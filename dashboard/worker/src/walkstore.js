// The dog walk log, kept in Lifelog (a small event store with a REST API, e.g. on Home Assistant):
// one event per walk, type LIFELOG_WALK_TYPE (default dog_walk), id = the walk id. This Worker keeps
// no walk data of its own; it validates, maps Lifelog events to the JSON the frame and Shortcuts
// expect, and mirrors completed walks to an iCloud calendar. The mirror's state lives in each event
// (data.calendar), and a sync runs after every write and whenever GET /walk sees a walk that needs one
// (failed writes back off up to an hour; also catches walks that agents log or edit in Lifelog).
// Secrets: LIFELOG_URL (base URL, e.g. https://example.org/lifelog), LIFELOG_TOKEN (a read/write
// Lifelog token), optional LIFELOG_WALK_TYPE.
import { listCalendars, putEvent, deleteEvent, calKey } from './icloud.js';
import {
  normalize, summarize, walkJSON, walkICS, renderLog, validId, WalkError, UID_PREFIX,
  toEvent, fromEvent, calRev, needsSync,
} from './walks.js';

const DAY = 864e5;
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

// Lifelog REST. Its 4xx answers (bad input) become 400s; anything else (down, auth, rate limit)
// becomes a 502, so the frame keeps the change queued and retries.
export class Lifelog {
  constructor(env) {
    this.base = String(env.LIFELOG_URL || '').replace(/\/+$/, '');
    this.token = env.LIFELOG_TOKEN;
    this.type = env.LIFELOG_WALK_TYPE || 'dog_walk';
  }
  async req(method, path, body) {
    if (!this.base || !this.token) throw new WalkError('the walk log is not configured (LIFELOG_URL, LIFELOG_TOKEN)', 503);
    let r;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { Authorization: 'Bearer ' + this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw new WalkError('Lifelog unreachable: ' + e.message, 502); }
    const j = await r.json().catch(() => null);
    if (r.status === 404 && method === 'GET') return null;
    if (r.ok) return j;
    if ([400, 404, 409, 422].includes(r.status)) throw new WalkError('Lifelog: ' + ((j && j.error) || 'HTTP ' + r.status), 400);
    throw new WalkError('Lifelog HTTP ' + r.status, 502);
  }
  async get(id) {
    const e = await this.req('GET', '/events/' + encodeURIComponent(id));
    return e && e.type === this.type ? e : null;
  }
  async exists(id) { return !!(await this.req('GET', '/events/' + encodeURIComponent(id))); }
  // Walks with started_at >= sinceMs, newest first; soft-deleted ones too when deleted is set.
  list(sinceMs, { deleted = false, limit = 1000 } = {}) {
    const q = new URLSearchParams({ type: this.type, limit: String(limit) });
    if (sinceMs) q.set('since', new Date(sinceMs).toISOString());
    if (deleted) q.set('deleted', '1');
    return this.req('GET', '/events?' + q);
  }
  put(id, ev) { return this.req('PUT', '/events/' + encodeURIComponent(id), ev); }
  patch(id, body) { return this.req('PATCH', '/events/' + encodeURIComponent(id), body); }
  del(id, reason) { return this.req('DELETE', '/events/' + encodeURIComponent(id) + '?reason=' + encodeURIComponent(reason)); }
}

// Home time zone, dog name and people's names (learned from the frame's walks; a Shortcut sends
// only ids), from recent walks, newest first.
function household(walks) {
  const names = {};
  for (const w of [...walks].reverse()) if (w.source === 'frame') for (const x of w.walkers) names[x.id] = x.name;
  const tz = (walks.find((w) => w.tz) || {}).tz || 'UTC';
  const dog = (walks.find((w) => w.dog) || {}).dog || 'Dog';
  return { tz, dog, names };
}

export class WalkStore {
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx;
    this.ll = new Lifelog(env);
  }

  // Calendar work runs after the response when there is a ctx (always, in the Worker).
  later(fn) {
    const p = Promise.resolve().then(fn).catch((e) => console.error('walk calendar sync:', e.message || e));
    if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(p);
    return p;
  }

  // One entry point; errors become {status, body}.
  async run(op, ...args) {
    if (!OPS.includes(op)) return { status: 400, body: { error: 'unknown operation' } };
    try {
      return { status: 200, body: await this[op](...args) };
    } catch (e) {
      if (e instanceof WalkError) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
      return { status: 500, body: { error: String(e.message || e) } };
    }
  }

  async walks(sinceMs, opts) { return ((await this.ll.list(sinceMs, opts)) || []).map(fromEvent); }

  // ---------------------------------------------------------------- reads
  async state() {
    const now = Date.now();
    const all = await this.walks(now - (RECENT_DAYS + 1) * DAY, { deleted: true });
    const live = all.filter((w) => !w.deletedAt);
    const { tz } = household(all);
    const active = live.find((w) => w.endedAt == null);
    const due = all.filter((w) => needsSync(w, now));
    if (due.length) this.later(() => this.syncAll(due));
    return {
      now: new Date(now).toISOString(), tz,
      active: active ? walkJSON(active, tz) : null,
      recent: live.filter((w) => w.endedAt != null && w.startedAt >= now - RECENT_DAYS * DAY).map((w) => walkJSON(w, tz)),
      calendar: this.calendarStatus(all),
    };
  }
  async list(days, limit) {
    const now = Date.now(), list = await this.walks(now - days * DAY, { limit }), { tz } = household(list);
    return { now: new Date(now).toISOString(), tz, walks: list.map((w) => walkJSON(w, tz)) };
  }
  async summary() {
    const now = Date.now(), list = await this.walks(now - 8 * DAY);
    return summarize(list, now, household(list).tz);
  }
  async log() {
    const list = await this.walks(0, { limit: 5000 }), h = household(list);
    return renderLog(list, Date.now(), h.tz, h.dog);
  }
  calendarStatus(all) {
    const out = { calendar: walkCalendarName(this.env) };
    for (const w of all) {
      if (w.deletedAt && !(w.cal && w.cal.href)) continue;
      if (!w.deletedAt && w.endedAt == null) continue;
      const s = w.deletedAt ? 'pending' : walkJSON(w, 'UTC').calendar;
      out[s] = (out[s] || 0) + 1;
      if (w.cal && w.cal.error && s !== 'synced') out.lastError = w.cal.error;
    }
    return out;
  }

  // ---------------------------------------------------------------- writes
  async upsert(id, body) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const now = Date.now(), f = normalize(body, now);
    const [oldEvent, recent] = await Promise.all([this.ll.get(id), this.walks(now - 30 * DAY)]);
    if (!oldEvent && await this.ll.exists(id)) throw new WalkError('that id belongs to another kind of event', 409);
    const old = oldEvent && fromEvent(oldEvent);
    const h = household(recent), tz = f.tz || h.tz;
    if (f.endedAt == null) {
      const a = recent.find((w) => w.endedAt == null && w.id !== id);
      if (a) throw new WalkError('another walk is already active', 409, { active: walkJSON(a, tz) });
    }
    const w = {
      id, startedAt: f.startedAt, endedAt: f.endedAt, pee: f.pee, poop: f.poop, notes: f.notes, source: f.source, tz,
      walkers: f.walkers.map(({ id, name, named }) => ({ id, name: named ? name : h.names[id] || name })),
      dog: f.dog || (old && old.dog) || h.dog,
    };
    if (old && !old.deletedAt && ['startedAt', 'endedAt', 'pee', 'poop', 'notes', 'dog'].every((k) => (old[k] ?? null) === (w[k] ?? null)) &&
      JSON.stringify(old.walkers) === JSON.stringify(w.walkers)) return walkJSON(old, tz);
    // Keep the calendar event's address so an edit overwrites it and a delete can remove it.
    const href = (old && old.cal && old.cal.href) || null;
    const pending = w.endedAt != null || href || (old && old.cal && old.cal.state !== 'none');
    w.cal = pending ? { state: 'pending', href } : { state: 'none' };
    const saved = fromEvent(await this.ll.put(id, toEvent(w, this.ll.type)));
    if (pending) this.later(() => this.sync(id));
    return walkJSON(saved, tz);
  }

  async remove(id) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const old = await this.ll.get(id);
    if (!old || old.deleted_at) return { ok: true, id, existed: false };
    const w = fromEvent(await this.ll.del(id, 'deleted on the frame'));
    if (needsSync(w, Date.now(), true)) this.later(() => this.sync(id));
    return { ok: true, id, existed: true };
  }

  // Server-timed start and stop for an iPhone Shortcut or an agent.
  async start(body = {}) {
    return this.upsert(crypto.randomUUID(), { startedAt: Date.now(), walkers: body.by || body.walkers, source: body.source || 'shortcut', dog: body.dog });
  }
  async stop(body = {}) {
    const a = (await this.walks(Date.now() - 30 * DAY)).find((w) => w.endedAt == null);
    if (!a) throw new WalkError('no walk is active', 404);
    const pick = (v, d) => (v == null || v === '' ? d : v);
    return this.upsert(a.id, {
      startedAt: a.startedAt, endedAt: Date.now(), pee: pick(body.pee, true), poop: pick(body.poop, false),
      walkers: pick(body.by || body.walkers, a.walkers), notes: pick(body.notes, a.notes), source: body.source || 'shortcut',
    });
  }

  // Retry calendar writes that gave up (and walks logged while the calendar was off).
  async resync() {
    const now = Date.now(), all = await this.walks(now - 60 * DAY, { deleted: true, limit: 5000 });
    const due = all.filter((w) => needsSync(w, now, true));
    await this.syncAll(due, true);
    return { ok: true, requeued: due.length };
  }

  // ---------------------------------------------------------------- calendar mirror
  async calendarUrl(fresh) {
    const name = walkCalendarName(this.env);
    if (!name) return null;
    const cached = this.env.DATA && await this.env.DATA.get('walk-calendar', 'json');
    if (cached && !fresh && cached.name === name) return cached.url;
    const c = (await listCalendars(this.env)).find((x) => calKey(x.name) === calKey(name));
    if (!c) throw new Error('calendar "' + name + '" not found');
    if (this.env.DATA) await this.env.DATA.put('walk-calendar', JSON.stringify({ name, url: c.url }));
    return c.url;
  }

  async syncAll(walks, force = false) {
    for (const w of walks.slice(0, 20)) {
      try { await this.sync(w.id, force); } catch (e) { console.error('walk calendar sync', w.id, e.message); }
    }
  }

  // Brings one walk's calendar event in line with Lifelog: write it (completed walk), delete it
  // (deleted or reopened walk), and record the outcome in data.calendar. If the walk changes while
  // iCloud answers, go round again with the new version.
  async sync(id, force = false) {
    for (let round = 0; round < 3; round++) {
      const e = await this.ll.req('GET', '/events/' + encodeURIComponent(id));
      if (!e || e.type !== this.ll.type) return;
      const w = fromEvent(e), now = Date.now();
      if (!needsSync(w, now, force || round > 0)) return;
      const c = w.cal || {}, rev = calRev(w);
      let next;
      try {
        let url = await this.calendarUrl();
        if (w.endedAt != null && !w.deletedAt) {
          if (!url) next = { state: 'off', href: c.href || null, rev };
          else {
            const ics = walkICS({ ...w, dog: w.dog || 'Dog' }, now);
            let href = c.href || url + UID_PREFIX + w.id + '.ics';
            try { await putEvent(this.env, href, ics); } catch (err) {
              if (c.href) throw err;
              url = await this.calendarUrl(true); // the calendar may have moved; look it up again once
              href = url + UID_PREFIX + w.id + '.ics';
              await putEvent(this.env, href, ics);
            }
            next = { state: 'synced', href, rev };
          }
        } else {
          const href = c.href || (url && url + UID_PREFIX + w.id + '.ics');
          if (href) await deleteEvent(this.env, href);
          next = { state: 'none', href: null };
        }
      } catch (err) {
        const tries = (c.tries || 0) + 1;
        next = {
          ...c, state: tries >= MAX_TRIES ? 'error' : 'pending', error: String(err.message || err).slice(0, 200), tries,
          retry_at: now + Math.min(60, 2 ** (tries - 1)) * 60e3,
        };
      }
      const cur = await this.ll.req('GET', '/events/' + encodeURIComponent(id));
      if (!cur) return;
      const after = fromEvent(cur);
      const moved = calRev(after) !== rev || !!after.deletedAt !== !!w.deletedAt || (after.endedAt == null) !== (w.endedAt == null);
      if (moved) {
        // Keep the event's address (it may have just been created) and sync the new version.
        await this.ll.patch(id, { data: { calendar: { state: 'pending', href: next.href || c.href || null } } });
        continue;
      }
      await this.ll.patch(id, { data: { calendar: next } });
      return;
    }
  }
}
