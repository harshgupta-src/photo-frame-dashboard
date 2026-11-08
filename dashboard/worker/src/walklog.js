// WalkLog: the dog walk log, one Durable Object (SQLite storage) for the household. A Durable Object
// rather than KV because KV is eventually consistent: a start followed seconds later by a cancel
// could read a stale list and lose a write. Every request to the object runs in order.
// Completed walks are mirrored to an iCloud calendar from alarm(), retried with backoff, so a slow
// or failing iCloud never holds up the frame.
import { DurableObject } from 'cloudflare:workers';
import { listCalendars, putEvent, deleteEvent, calKey } from './icloud.js';
import { normalize, summarize, walkJSON, walkICS, renderLog, validId, WalkError, UID_PREFIX } from './walks.js';

const RECENT_DAYS = 14;
const MAX_TRIES = 10;
const OPS = ['state', 'list', 'summary', 'log', 'upsert', 'remove', 'start', 'stop', 'resync'];

// WALK_CALENDAR (a calendar name, or "none"), else the CALENDARS entry shared by the most people
// (the family calendar), else no calendar.
export function walkCalendarName(env) {
  const w = String(env.WALK_CALENDAR || '').trim();
  if (w) return /^(none|off)$/i.test(w) ? null : w;
  let m = {};
  try { m = typeof env.CALENDARS === 'string' ? JSON.parse(env.CALENDARS) : env.CALENDARS || {}; } catch { return null; }
  let best = null;
  for (const [name, people] of Object.entries(m)) if (Array.isArray(people) && people.length > 1 && (!best || people.length > best[1])) best = [name, people.length];
  return best && best[0];
}

export class WalkLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS walks (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, pee INTEGER, poop INTEGER,
      walkers TEXT NOT NULL DEFAULT '[]', notes TEXT, dog TEXT, source TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      cal_href TEXT, cal_state TEXT NOT NULL DEFAULT 'none', cal_error TEXT, cal_tries INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS walks_started ON walks(started_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  }

  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) {
    if (v == null) this.sql.exec('DELETE FROM meta WHERE k = ?', k);
    else this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  }
  get tz() { return this.meta('tz') || 'UTC'; }
  get dog() { return this.meta('dog') || 'Dog'; }

  row(r) {
    return r && {
      id: r.id, startedAt: r.started_at, endedAt: r.ended_at,
      pee: r.pee == null ? null : !!r.pee, poop: r.poop == null ? null : !!r.poop,
      walkers: JSON.parse(r.walkers || '[]'), notes: r.notes, dog: r.dog, source: r.source,
      createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
      calHref: r.cal_href, calState: r.cal_state, calError: r.cal_error, calTries: r.cal_tries,
    };
  }
  get(id) { return this.row(this.sql.exec('SELECT * FROM walks WHERE id = ?', id).toArray()[0]); }
  walks(sinceMs = 0, limit = 1000) {
    return this.sql.exec('SELECT * FROM walks WHERE deleted_at IS NULL AND (started_at >= ? OR ended_at IS NULL) ORDER BY started_at DESC LIMIT ?', sinceMs, limit)
      .toArray().map((r) => this.row(r));
  }
  active() { return this.row(this.sql.exec('SELECT * FROM walks WHERE deleted_at IS NULL AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').toArray()[0]); }

  // One entry point for the Worker: errors cross RPC as {status, body} because custom error
  // properties don't survive it.
  async run(op, ...args) {
    if (!OPS.includes(op)) return { status: 400, body: { error: 'unknown operation' } };
    try {
      return { status: 200, body: await this[op](...args) };
    } catch (e) {
      if (e instanceof WalkError) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  // ---------------------------------------------------------------- reads
  state() {
    const now = Date.now(), tz = this.tz;
    const list = this.walks(now - RECENT_DAYS * 864e5, 200);
    const active = list.find((w) => w.endedAt == null);
    return {
      now: new Date(now).toISOString(), tz,
      active: active ? walkJSON(active, tz) : null,
      recent: list.filter((w) => w.endedAt != null).map((w) => walkJSON(w, tz)),
      calendar: this.calendarStatus(),
    };
  }
  list(days, limit) {
    const tz = this.tz, now = Date.now();
    return { now: new Date(now).toISOString(), tz, walks: this.walks(now - days * 864e5, limit).map((w) => walkJSON(w, tz)) };
  }
  summary() { return summarize(this.walks(Date.now() - 8 * 864e5), Date.now(), this.tz); }
  log() { return renderLog(this.walks(0, 100000), Date.now(), this.tz, this.dog); }
  calendarStatus() {
    const c = this.sql.exec("SELECT cal_state AS s, COUNT(*) AS n, MAX(cal_error) AS e FROM walks WHERE deleted_at IS NULL OR cal_state != 'none' GROUP BY cal_state").toArray();
    const out = { calendar: walkCalendarName(this.env) };
    for (const r of c) { out[r.s] = r.n; if (r.e && r.s !== 'synced') out.lastError = r.e; }
    return out;
  }

  // ---------------------------------------------------------------- writes
  upsert(id, body) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const now = Date.now(), f = normalize(body, now), old = this.get(id);
    if (f.endedAt == null) {
      const a = this.active();
      if (a && a.id !== id) throw new WalkError('another walk is already active', 409, { active: walkJSON(a, this.tz) });
    }
    if (f.tz) this.setMeta('tz', f.tz);
    if (f.dog) this.setMeta('dog', f.dog);
    const w = {
      id, startedAt: f.startedAt, endedAt: f.endedAt, pee: f.pee, poop: f.poop, walkers: f.walkers, notes: f.notes,
      dog: f.dog || (old && old.dog) || this.meta('dog'), source: f.source,
    };
    const same = old && !old.deletedAt && ['startedAt', 'endedAt', 'pee', 'poop', 'notes', 'dog'].every((k) => old[k] === w[k]) &&
      JSON.stringify(old.walkers) === JSON.stringify(w.walkers);
    if (same) return walkJSON(old, this.tz);
    const cal = w.endedAt != null || (old && (old.calHref || old.calState === 'pending')) ? 'pending' : 'none';
    const b = (v) => (v == null ? null : v ? 1 : 0);
    this.sql.exec(`INSERT INTO walks (id, started_at, ended_at, pee, poop, walkers, notes, dog, source, created_at, updated_at, deleted_at, cal_state, cal_tries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)
      ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at, pee = excluded.pee, poop = excluded.poop,
        walkers = excluded.walkers, notes = excluded.notes, dog = excluded.dog, source = excluded.source, updated_at = excluded.updated_at,
        deleted_at = NULL, cal_state = excluded.cal_state, cal_tries = 0, cal_error = NULL`,
    id, w.startedAt, w.endedAt, b(w.pee), b(w.poop), JSON.stringify(w.walkers), w.notes, w.dog, w.source, now, now, cal);
    if (cal === 'pending') this.ctx.storage.setAlarm(now);
    return walkJSON(this.get(id), this.tz);
  }

  remove(id) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const old = this.get(id);
    if (!old || old.deletedAt) return { ok: true, id, existed: false };
    const now = Date.now(), cal = old.calHref || old.calState === 'pending' ? 'pending' : 'none';
    // A deleted walk is kept only until its calendar event is gone (syncOne purges it).
    if (cal === 'none') this.sql.exec('DELETE FROM walks WHERE id = ?', id);
    else {
      this.sql.exec('UPDATE walks SET deleted_at = ?, updated_at = ?, cal_state = ?, cal_tries = 0, cal_error = NULL WHERE id = ?', now, now, cal, id);
      this.ctx.storage.setAlarm(now);
    }
    return { ok: true, id, existed: true };
  }

  // Server-timed start and stop for an iPhone Shortcut or an agent.
  start(body = {}) {
    const a = this.active();
    if (a) throw new WalkError('a walk is already active', 409, { active: walkJSON(a, this.tz) });
    return this.upsert(crypto.randomUUID(), { startedAt: Date.now(), walkers: body.by || body.walkers, source: body.source || 'shortcut', dog: body.dog });
  }
  stop(body = {}) {
    const a = this.active();
    if (!a) throw new WalkError('no walk is active', 404);
    const pick = (v, d) => (v == null || v === '' ? d : v);
    return this.upsert(a.id, {
      startedAt: a.startedAt, endedAt: Date.now(), pee: pick(body.pee, true), poop: pick(body.poop, false),
      walkers: pick(body.by || body.walkers, a.walkers), notes: pick(body.notes, a.notes), source: body.source || 'shortcut',
    });
  }

  // ---------------------------------------------------------------- calendar mirror
  async calendarUrl(fresh) {
    const name = walkCalendarName(this.env);
    if (!name) return null;
    const cached = this.meta('cal_url');
    if (cached && !fresh && this.meta('cal_name') === name) return cached;
    const c = (await listCalendars(this.env)).find((x) => calKey(x.name) === calKey(name));
    if (!c) throw new Error('calendar "' + name + '" not found');
    this.setMeta('cal_url', c.url);
    this.setMeta('cal_name', name);
    return c.url;
  }

  async syncOne(w) {
    const want = w.endedAt != null && !w.deletedAt;
    let href = w.calHref, state = 'none';
    if (want) {
      let url = await this.calendarUrl();
      if (!url) { state = 'off'; href = null; }
      else {
        const ics = walkICS({ ...w, dog: w.dog || this.dog }, Date.now());
        if (!href) href = url + UID_PREFIX + w.id + '.ics';
        try { await putEvent(this.env, href, ics); } catch (e) {
          if (w.calHref) throw e;
          url = await this.calendarUrl(true); // the calendar may have moved; look it up again once
          href = url + UID_PREFIX + w.id + '.ics';
          await putEvent(this.env, href, ics);
        }
        state = 'synced';
      }
    } else if (href) {
      await deleteEvent(this.env, href);
      href = null;
    }
    // Only if the walk didn't change while iCloud was answering; a change has its own alarm.
    if (w.deletedAt && !href) { this.sql.exec('DELETE FROM walks WHERE id = ? AND updated_at = ?', w.id, w.updatedAt); return; }
    this.sql.exec('UPDATE walks SET cal_href = ? WHERE id = ?', href, w.id);
    this.sql.exec('UPDATE walks SET cal_state = ?, cal_error = NULL, cal_tries = 0 WHERE id = ? AND updated_at = ?', state, w.id, w.updatedAt);
  }

  async alarm() {
    const pending = this.sql.exec("SELECT * FROM walks WHERE cal_state = 'pending' ORDER BY updated_at").toArray().map((r) => this.row(r));
    for (const w of pending) {
      try { await this.syncOne(w); } catch (e) {
        const tries = w.calTries + 1;
        this.sql.exec('UPDATE walks SET cal_tries = ?, cal_error = ?, cal_state = ? WHERE id = ? AND updated_at = ?',
          tries, String(e.message).slice(0, 200), tries >= MAX_TRIES ? 'error' : 'pending', w.id, w.updatedAt);
      }
    }
    const left = this.sql.exec("SELECT MIN(cal_tries) AS t, COUNT(*) AS n FROM walks WHERE cal_state = 'pending'").toArray()[0];
    if (left && left.n) this.ctx.storage.setAlarm(Date.now() + Math.min(60, 2 ** Math.max(0, left.t - 1)) * 60e3);
  }

  // Re-queue failed calendar writes (GET /walks/resync).
  resync() {
    const n = this.sql.exec("UPDATE walks SET cal_state = 'pending', cal_tries = 0 WHERE cal_state = 'error' OR (cal_state = 'off' AND deleted_at IS NULL)").rowsWritten;
    this.ctx.storage.setAlarm(Date.now());
    return { ok: true, requeued: n };
  }
}
