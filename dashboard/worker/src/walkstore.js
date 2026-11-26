// The dog walk log, kept in Lifelog (a small event store with a REST API, e.g. on Home Assistant):
// one event per walk, type LIFELOG_WALK_TYPE (default dog_walk), id = the walk id. This Worker keeps
// no walk data of its own; it validates, maps Lifelog events to the JSON the frame and Shortcuts
// expect, and mirrors completed walks to an iCloud calendar. The mirror's state lives in each event
// (data.calendar), and a sync runs after every write and whenever GET /walk sees a walk that needs one
// (failed writes back off up to an hour; also catches walks that agents log or edit in Lifelog).
// Secrets: LIFELOG_URL (base URL, e.g. https://example.org/lifelog), LIFELOG_TOKEN (a read/write
// Lifelog token), optional LIFELOG_WALK_TYPE.
// A completed walk's pee and poop (when ticked) are also their own events: Lifelog types <dog>_pee and
// <dog>_poop (from the walk type, e.g. maya_walk → maya_pee), ids <walk id>-pee / -poop, and 1-minute
// calendar events, at start + 1 min and 2 min after that. The day's walk plan lives in KV (walkplan.js).
// Every walk change is posted to Home Assistant (secret HA_WALK_WEBHOOK_URL), which runs the house side.
import { listCalendars, putEvent, deleteEvent, calKey } from './icloud.js';
import {
  normalize, summarize, walkJSON, walkICS, renderLog, validId, WalkError, UID_PREFIX, PLAN_PREFIX,
  toEvent, fromEvent, calRev, needsSync, pottyTimes, pottyType, pottyICS, localDate, normalizeRoute, routeFromPaths,
} from './walks.js';
import { loadGraph, snapRoute } from './snap.js';
import { owntracksPoints, mergePaths } from './owntracks.js';
import { normalizePlan, matchPlans, planCalendarName, planRev, planICS, planJSON, validDate, nextDate, prevDate, minuteOfDay } from './walkplan.js';
import { expectPotty } from './walkexpect.js';

const DAY = 864e5;
const RECENT_DAYS = 14;
const MAX_TRIES = 10;
export const TOMBSTONE_DAYS = 30;
const OPS = ['state', 'list', 'summary', 'log', 'upsert', 'remove', 'start', 'stop', 'resync', 'getPlan', 'putPlan', 'deletePlan', 'active', 'putRoute', 'resnapRoute', 'resnapRoutes'];
const POTTY = ['pee', 'poop'];
const sibling = (href, kind) => href.replace(/\.ics$/, '-' + kind + '.ics');
const iso = (ms) => new Date(ms).toISOString();
export const MIN_WALK_MS = 60e3; // shorter is a mis-tap (start then stop); see stop() and the frame's W.MIN_MS

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
// becomes a 502, so the frame keeps the change queued and retries. type: the event type get() and
// list() stick to (default the walk type; meals.js passes <dog>_meal).
export class Lifelog {
  constructor(env, type) {
    this.base = String(env.LIFELOG_URL || '').replace(/\/+$/, '');
    this.token = env.LIFELOG_TOKEN;
    this.type = type || env.LIFELOG_WALK_TYPE || 'dog_walk';
  }
  async req(method, path, body) {
    if (!this.base || !this.token) throw new WalkError('Lifelog is not configured (LIFELOG_URL, LIFELOG_TOKEN)', 503);
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
export function household(walks) {
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
    const active = live.find((w) => w.endedAt == null && !w.abandoned);
    const due = all.filter((w) => needsSync(w, now));
    if (due.length) this.later(() => this.syncAll(due));
    const plans = [];
    const today = localDate(now, tz);
    for (const date of [today, nextDate(today)]) {
      const plan = await this.loadPlan(date);
      if (!plan) continue;
      const matched = await this.matchDay(plan, live);
      if (this.planDue(plan, matched, now)) this.later(() => this.syncPlan(date));
      plans.push(planJSON(plan, matched, now, live, plan.tz || tz));
    }
    return {
      now: new Date(now).toISOString(), tz,
      active: active ? walkJSON(active, tz) : null,
      recent: live.filter((w) => w.endedAt != null && w.startedAt >= now - RECENT_DAYS * DAY).map((w) => walkJSON(w, tz)),
      plans,
      calendar: this.calendarStatus(all),
    };
  }
  // Just the walk in progress (a cheap poll for Home Assistant).
  async active() {
    const now = Date.now(), list = await this.walks(now - 2 * DAY, { limit: 20 }), { tz } = household(list);
    const a = list.find((w) => w.endedAt == null && !w.abandoned);
    return { now: new Date(now).toISOString(), tz, active: a ? walkJSON(a, tz) : null };
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
    // Deleted on purpose (remove): a device that still has it (the frame's open end-of-walk sheet, a
    // phone's queue) mustn't bring it back. body.restore (an Undo of that delete) clears the tombstone.
    if (await this.tombstoned(id)) {
      if (!(body && body.restore === true)) throw new WalkError('this walk was deleted on another device', 410, { deleted: true, id });
      await this.env.DATA.delete('walk-deleted:' + id);
    }
    const now = Date.now(), f = normalize(body, now);
    const [oldEvent, recent] = await Promise.all([this.ll.get(id), this.walks(now - 30 * DAY)]);
    if (!oldEvent && await this.ll.exists(id)) throw new WalkError('that id belongs to another kind of event', 409);
    const old = oldEvent && fromEvent(oldEvent);
    const h = household(recent), tz = f.tz || h.tz;
    if (f.endedAt == null) {
      const a = recent.find((w) => w.endedAt == null && !w.abandoned && w.id !== id);
      if (a) throw new WalkError('another walk is already active', 409, { active: walkJSON(a, tz) });
    }
    const w = {
      id, startedAt: f.startedAt, endedAt: f.endedAt, pee: f.pee, poop: f.poop, notes: f.notes, source: f.source, tz,
      planId: f.planId || (old && old.planId) || null,
      walkers: f.walkers.map(({ id, name, named }) => ({ id, name: named ? name : h.names[id] || name })),
      dog: f.dog || (old && old.dog) || h.dog,
    };
    if (old && !old.deletedAt && ['startedAt', 'endedAt', 'pee', 'poop', 'notes', 'dog', 'planId'].every((k) => (old[k] ?? null) === (w[k] ?? null)) &&
      JSON.stringify(old.walkers) === JSON.stringify(w.walkers)) return walkJSON(old, tz);
    // Keep the calendar event's address so an edit overwrites it and a delete can remove it.
    const href = (old && old.cal && old.cal.href) || null;
    const pending = w.endedAt != null || href || (old && old.cal && old.cal.state !== 'none');
    w.cal = pending ? { state: 'pending', href } : { state: 'none' };
    const saved = fromEvent(await this.ll.put(id, toEvent(w, this.ll.type)));
    if (pending) this.later(() => this.sync(id));
    const event = !old || old.deletedAt ? (w.endedAt == null ? 'start' : 'logged') : old.endedAt == null && w.endedAt != null ? 'stop' : 'change';
    this.later(() => this.notifyHA(event, saved, tz));
    this.later(() => this.syncPlan(localDate(w.startedAt, tz)));
    return walkJSON(saved, tz);
  }

  // An explicit delete leaves a tombstone (KV walk-deleted:<id>, TOMBSTONE_DAYS) so a later upsert of the
  // same id is a 410, not a new walk. tombstone: false for a discarded mis-tap (stop()).
  async remove(id, { tombstone = true } = {}) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const old = await this.ll.get(id);
    if (!old || old.deleted_at) { if (tombstone) await this.tomb(id); return { ok: true, id, existed: false }; }
    const w = fromEvent(await this.ll.del(id, 'deleted on the frame'));
    if (tombstone) await this.tomb(id);
    this.later(async () => { await this.syncPotty(w); if (needsSync(w, Date.now(), true)) await this.sync(id); });
    const tz = w.tz || 'UTC';
    this.later(() => this.notifyHA('delete', w, tz));
    this.later(() => this.syncPlan(localDate(w.startedAt, tz)));
    return { ok: true, id, existed: true };
  }

  async tomb(id) {
    if (this.env.DATA) await this.env.DATA.put('walk-deleted:' + id, String(Date.now()), { expirationTtl: TOMBSTONE_DAYS * 86400 });
  }
  async tombstoned(id) { return !!(this.env.DATA && await this.env.DATA.get('walk-deleted:' + id)); }

  // Server-timed start and stop for an iPhone Shortcut or an agent.
  async start(body = {}) {
    return this.upsert(crypto.randomUUID(), { startedAt: Date.now(), walkers: body.by || body.walkers, source: body.source || 'shortcut', dog: body.dog, planId: body.planId });
  }
  async stop(body = {}) {
    const a = (await this.walks(Date.now() - 30 * DAY)).find((w) => w.endedAt == null && !w.abandoned);
    if (!a) throw new WalkError('no walk is active', 404);
    // Stopped within a minute of starting: a mis-tap, not a walk. Drop it instead of logging it.
    if (Date.now() - a.startedAt < MIN_WALK_MS) return { ...(await this.remove(a.id, { tombstone: false })), discarded: true };
    const pick = (v, d) => (v == null || v === '' ? d : v);
    const guess = body.pee == null || body.pee === '' || body.poop == null || body.poop === '' ? await this.expectFor(a) : { pee: true, poop: false };
    return this.upsert(a.id, {
      startedAt: a.startedAt, endedAt: Date.now(), pee: pick(body.pee, guess.pee), poop: pick(body.poop, guess.poop),
      walkers: pick(body.by || body.walkers, a.walkers), notes: pick(body.notes, a.notes), source: body.source || 'shortcut',
    });
  }

  // What a walk probably brought (a stop that doesn't say): its planned walk's expect, else history.
  // The planned walk is the one matchPlans gives it (its planId first, the days either side of its
  // start too, never one planned after it ended), as on GET /walk.
  async expectFor(w) {
    const now = Date.now(), recent = await this.walks(now - 15 * DAY), tz = w.tz || household(recent).tz;
    const live = recent.filter((x) => !x.deletedAt && x.id !== w.id).concat([{ ...w, endedAt: w.endedAt ?? now }]);
    const date = localDate(w.startedAt, tz);
    const plans = (await Promise.all([prevDate(date), date, nextDate(date)].map((d) => this.loadPlan(d).catch(() => null))))
      .filter((p) => p && Array.isArray(p.items));
    const matched = matchPlans(plans, live);
    let item = null;
    for (const p of plans) for (const [id, x] of matched.get(p.date)) if (x.id === w.id) item = p.items.find((i) => i.id === id);
    return expectPotty(item && item.expect, recent.filter((x) => !x.deletedAt), w.startedAt, minuteOfDay(tz), w.id);
  }

  // Retry calendar writes that gave up (and walks logged while the calendar was off).
  async resync() {
    const now = Date.now(), all = await this.walks(now - 60 * DAY, { deleted: true, limit: 5000 });
    const due = all.filter((w) => needsSync(w, now, true));
    await this.syncAll(due, true);
    return { ok: true, requeued: due.length };
  }

  // ---------------------------------------------------------------- calendar mirror
  async calendarUrl(fresh, name = walkCalendarName(this.env)) {
    if (!name) return null;
    const key = 'walk-calendar:' + calKey(name);
    const cached = this.env.DATA && await this.env.DATA.get(key, 'json');
    if (cached && !fresh && cached.name === name) return cached.url;
    const c = (await listCalendars(this.env)).find((x) => calKey(x.name) === calKey(name));
    if (!c) throw new WalkError('calendar "' + name + '" not found', 503);
    if (this.env.DATA) await this.env.DATA.put(key, JSON.stringify({ name, url: c.url }));
    return c.url;
  }

  // A walk's event and its pee/poop events.
  async dropEvents(href) {
    for (const h of [href, ...POTTY.map((k) => sibling(href, k))]) await deleteEvent(this.env, h);
  }

  // The walk's pee/poop Lifelog events: there (at their times) when the walk is completed and ticked,
  // soft-deleted otherwise.
  async syncPotty(w) {
    const live = w.endedAt != null && !w.deletedAt, at = pottyTimes(w);
    if (w.deletedAt) {
      const r = await this.ll.req('GET', '/events/' + encodeURIComponent(w.id + '-route'));
      if (r && r.type === this.ll.type + '_route' && !r.deleted_at) await this.ll.del(r.id, 'walk deleted');
    }
    for (const kind of POTTY) {
      const id = w.id + '-' + kind, type = pottyType(this.ll.type, kind);
      if (live && w[kind]) {
        await this.ll.put(id, {
          type, person: w.walkers.length === 1 ? w.walkers[0].name : null, started_at: iso(at[kind]), ended_at: iso(at[kind]),
          source: 'walk', data: { walk_id: w.id, dog: w.dog || null, walkers: w.walkers.map((x) => x.name), walker_ids: w.walkers.map((x) => x.id) },
        });
      } else {
        const e = await this.ll.req('GET', '/events/' + encodeURIComponent(id));
        if (e && e.type === type && !e.deleted_at) await this.ll.del(id, w.deletedAt ? 'walk deleted' : 'not ticked on the walk');
      }
    }
  }

  // The walk's route from the walkers' phones (Home Assistant) → Lifelog event <walk id>-route, type
  // <walk type>_route; removed with the walk. The raw fixes stay in data.paths; data.snapped is the
  // same walk matched to the footpaths (snap.js) when the Worker has the walk graph.
  async putRoute(id, body) {
    const w = await this.routeWalk(id), r = normalizeRoute(body);
    return this.saveRoute(w, r.paths, String((body && body.source) || 'api').slice(0, 20));
  }

  // Re-save a walk's route: the stored fixes plus `extra` ({who: [[lat, lon, acc, t_s]]}, e.g. points
  // that arrived after the walk ended), merged with the other sources and snapped again.
  async resnapRoute(id, extra) {
    const w = await this.routeWalk(id);
    const old = await this.ll.req('GET', '/events/' + encodeURIComponent(id + '-route'));
    const live = old && old.type === this.ll.type + '_route' && !old.deleted_at;
    if (!live && !extra) throw new WalkError('no route for this walk', 404);
    const paths = {};
    for (const src of [live ? (old.data || {}).paths : null, extra]) {
      for (const [who, list] of Object.entries(src || {})) if (Array.isArray(list)) paths[who] = (paths[who] || []).concat(list);
    }
    return this.saveRoute(w, paths, (live && old.source) || 'api');
  }

  // Snap the routes of the last `days` days again (after a graph rebuild or a matcher change).
  // dry: only report what would change.
  async resnapRoutes({ days = 14, dry = false } = {}) {
    if (!loadGraph(this.env)) throw new WalkError('no walk graph (WALK_GRAPH) on this Worker', 503);
    const q = new URLSearchParams({ type: this.ll.type + '_route', limit: '1000', since: iso(Date.now() - days * DAY) });
    const routes = (await this.ll.req('GET', '/events?' + q)) || [], out = [];
    for (const e of routes) {
      const d = e.data || {};
      if (e.deleted_at || !d.walk_id || !d.paths) continue;
      try {
        const r = dry ? { distanceM: d.distance_m, ...snapRoute(loadGraph(this.env), d.paths) } : await this.resnapRoute(d.walk_id);
        out.push({ walkId: d.walk_id, distanceM: r.distanceM, snappedM: dry ? r.snapped_m : r.snappedM, before: d.snapped_m == null ? null : d.snapped_m });
      } catch (err) { out.push({ walkId: d.walk_id, error: String(err.message || err) }); }
    }
    return { ok: true, dry: !!dry, days, routes: out };
  }

  async routeWalk(id) {
    if (!validId(id)) throw new WalkError('bad walk id');
    const e = await this.ll.get(id);
    if (!e || e.deleted_at) throw new WalkError('no such walk', 404);
    return fromEvent(e);
  }

  // Other sources of the walk's points join the phones' here, before snapping (the one call site).
  async mergeSources(id, paths) {
    try { return mergePaths(paths, await owntracksPoints(this.env, id)); } catch (e) { console.warn('owntracks merge:', e.message || e); return paths; }
  }

  async saveRoute(w, input, source) {
    const r = routeFromPaths(await this.mergeSources(w.id, input));
    const s = snapRoute(loadGraph(this.env), r.paths) || {};
    const last = Math.max(0, ...Object.values(r.paths).flat().map((x) => x[3] * 1000));
    const saved = await this.ll.put(w.id + '-route', {
      type: this.ll.type + '_route', person: w.walkers.length === 1 ? w.walkers[0].name : null,
      started_at: iso(w.startedAt), ended_at: iso(w.endedAt != null ? w.endedAt : Math.max(w.startedAt, last)), source,
      data: {
        walk_id: w.id, dog: w.dog || null, walkers: w.walkers.map((x) => x.name), walker_ids: w.walkers.map((x) => x.id), ...r, ...s,
        points: Object.values(r.paths).reduce((n, l) => n + l.length, 0),
      },
    });
    return {
      ok: true, id: saved.id, walkId: w.id, distanceM: r.distance_m, snappedM: s.snapped_m == null ? null : s.snapped_m,
      snapped: Object.keys(s.snapped || {}), points: saved.data.points,
    };
  }

  // ---------------------------------------------------------------- Home Assistant
  // 'start' | 'stop' | 'logged' (added already finished) | 'change' | 'delete' → HA's walk webhook.
  async notifyHA(event, w, tz) {
    const url = this.env.HA_WALK_WEBHOOK_URL;
    if (!url) return 'off';
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, walk: { ...walkJSON(w, tz), deleted: !!w.deletedAt } }),
        signal: AbortSignal.timeout(10000),
      });
      return r.ok ? 'ok' : 'failed';
    } catch { return 'failed'; }
  }

  // ---------------------------------------------------------------- the day's plan
  async loadPlan(date) { return this.env.DATA ? await this.env.DATA.get('walk-plan:' + date, 'json') : null; }
  async savePlan(plan) {
    if (!this.env.DATA) throw new WalkError('no KV namespace for walk plans', 503);
    await this.env.DATA.put('walk-plan:' + plan.date, JSON.stringify(plan), { expirationTtl: 90 * 86400 });
  }
  // Which walk covers each of the day's planned walks (matchPlan), matched together with the days either
  // side so a walk around midnight isn't counted for two plans.
  async matchDay(plan, walks) {
    const side = await Promise.all([this.loadPlan(prevDate(plan.date)), this.loadPlan(nextDate(plan.date))]);
    const plans = [plan, ...side.filter((p) => p && p.date !== plan.date && Array.isArray(p.items))];
    return matchPlans(plans, walks).get(plan.date);
  }
  // Live walks near the plan's day.
  async planWalks(plan) {
    // 15 days back: the walks it matches, and the history behind each walk's expect.
    const from = Math.min(...plan.items.map((x) => x.start), Date.parse(plan.date + 'T00:00:00Z')) - 15 * DAY;
    return (await this.walks(from)).filter((w) => !w.deletedAt);
  }
  // Does any planned event need writing or removing? (no iCloud call)
  planDue(plan, matched, now = Date.now()) {
    if ((plan.removed || []).some((x) => !(x.cal && x.cal.retry_at && now < x.cal.retry_at))) return true;
    return plan.items.some((x) => {
      const c = x.cal || {};
      if (c.retry_at && now < c.retry_at) return false;
      const done = matched.get(x.id) && matched.get(x.id).endedAt != null;
      if (done) return !!c.href;
      const name = planCalendarName(this.env, x.walkers.map((p) => p.id));
      return name ? !c.href || c.name !== name || c.rev !== planRev(x, plan.dog) : !!c.href;
    });
  }

  async getPlan(date) {
    const now = Date.now(), d = date || localDate(now, household(await this.walks(now - 7 * DAY)).tz);
    if (!validDate(d)) throw new WalkError('the plan date must be YYYY-MM-DD');
    const plan = await this.loadPlan(d);
    if (!plan) return { date: d, walks: [] };
    const walks = await this.planWalks(plan);
    return planJSON(plan, await this.matchDay(plan, walks), now, walks, plan.tz || household(walks).tz);
  }

  // Replaces the day's plan and writes its calendar events before answering.
  async putPlan(date, body) {
    const now = Date.now(), recent = await this.walks(now - 30 * DAY), h = household(recent);
    const old = await this.loadPlan(date);
    // Planned walks already walked or under way are never dropped for being after bedtime.
    const oldMatch = old ? await this.matchDay(old, recent.filter((w) => !w.deletedAt)) : new Map();
    const plan = normalizePlan(body, date, (body && body.tz) || h.tz, h.names, now, new Set(oldMatch.keys()));
    plan.dog = h.dog;
    plan.v = crypto.randomUUID(); // tells two PUTs in the same millisecond apart (syncPlan's race check)
    const prev = new Map(((old && old.items) || []).map((x) => [x.id, x]));
    for (const x of plan.items) {
      const o = prev.get(x.id);
      if (o) { x.cal = o.cal; x.created = o.created; }
    }
    // A replan keeps the walks already done even when the PUT leaves them out (e.g. one logged while the
    // planner was thinking); a walk under way instead takes its moved item (matchPlan's nearest).
    for (const [id, w] of oldMatch) {
      if (w.endedAt != null && !plan.items.some((x) => x.id === id)) plan.items.push(prev.get(id));
    }
    plan.items.sort((a, b) => a.start - b.start);
    plan.removed = [...((old && old.removed) || []), ...[...prev.values()].filter((x) => x.cal && x.cal.href && !plan.items.some((y) => y.id === x.id))];
    await this.savePlan(plan);
    return (await this.syncPlan(date)) || { date, walks: [] };
  }

  async deletePlan(date) {
    if (!validDate(date)) throw new WalkError('the plan date must be YYYY-MM-DD');
    const old = await this.loadPlan(date);
    if (!old) return { ok: true, date, existed: false };
    await this.savePlan({ ...old, items: [], removed: [...(old.removed || []), ...old.items.filter((x) => x.cal && x.cal.href)] });
    await this.syncPlan(date);
    return { ok: true, date, existed: true };
  }

  // Brings the day's planned events in line: one per planned walk not yet walked, in its walkers'
  // calendar; none for walked or removed ones. → planJSON, or null when there is no plan.
  async syncPlan(date) {
    const plan = await this.loadPlan(date);
    if (!plan) return null;
    const now = Date.now(), walks = await this.planWalks(plan), matched = await this.matchDay(plan, walks);
    let changed = false;
    const fail = (x, err) => {
      const tries = ((x.cal && x.cal.tries) || 0) + 1;
      x.cal = { ...(x.cal || {}), error: String(err.message || err).slice(0, 200), tries, retry_at: now + Math.min(60, 2 ** tries) * 60e3 };
      changed = true;
    };
    const kept = [];
    for (const x of plan.removed || []) {
      try { await deleteEvent(this.env, x.cal.href); changed = true; } catch (err) { fail(x, err); kept.push(x); }
    }
    plan.removed = kept;
    for (const x of plan.items) {
      const c = x.cal || {}, w = matched.get(x.id);
      try {
        const name = w && w.endedAt != null ? null : planCalendarName(this.env, x.walkers.map((p) => p.id));
        if (!name) {
          if (c.href) { await deleteEvent(this.env, c.href); x.cal = { name: null }; changed = true; }
          continue;
        }
        const rev = planRev(x, plan.dog);
        let url = await this.calendarUrl(false, name), href = url + PLAN_PREFIX + x.id + '.ics';
        if (c.href === href && c.rev === rev && c.name === name) continue;
        if (c.href && c.href !== href) await deleteEvent(this.env, c.href);
        const ics = planICS(x, plan.dog || 'Dog', now);
        try { await putEvent(this.env, href, ics); } catch (err) {
          url = await this.calendarUrl(true, name);
          href = url + PLAN_PREFIX + x.id + '.ics';
          await putEvent(this.env, href, ics);
        }
        x.cal = { name, href, rev };
        changed = true;
      } catch (err) { fail(x, err); }
    }
    if (changed) {
      // Keep any re-plan that landed while iCloud answered; just record where events now are.
      const cur = await this.loadPlan(date);
      if (cur && (cur.updated !== plan.updated || cur.v !== plan.v)) {
        // Events written here that the newer plan doesn't know about: adopt them, or remove them.
        const known = new Set([...cur.items, ...(cur.removed || [])].map((x) => x.cal && x.cal.href).filter(Boolean));
        let adopted = false;
        for (const x of [...plan.items, ...plan.removed]) {
          if (!x.cal || !x.cal.href || known.has(x.cal.href)) continue;
          const y = plan.items.includes(x) && cur.items.find((i) => i.id === x.id && !(i.cal && i.cal.href));
          if (y) y.cal = x.cal; else cur.removed = [...(cur.removed || []), x];
          adopted = true;
        }
        if (adopted) await this.savePlan(cur);
        return this.syncPlan(date);
      }
      await this.savePlan(plan);
    }
    return planJSON(plan, matched, now, walks, plan.tz || household(walks).tz);
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
        await this.syncPotty(w);
        let url = await this.calendarUrl();
        if (w.endedAt != null && !w.deletedAt) {
          if (!url) next = { state: 'off', href: c.href || null, rev };
          else {
            const ics = walkICS({ ...w, dog: w.dog || 'Dog' }, now);
            let href = url + UID_PREFIX + w.id + '.ics';
            // Walks mirrored to another calendar before (WALK_CALENDAR changed) move to this one.
            if (c.href && c.href !== href) await this.dropEvents(c.href);
            try { await putEvent(this.env, href, ics); } catch (err) {
              url = await this.calendarUrl(true); // the calendar may have moved; look it up again once
              if (url + UID_PREFIX + w.id + '.ics' === href) throw err;
              href = url + UID_PREFIX + w.id + '.ics';
              await putEvent(this.env, href, ics);
            }
            for (const kind of POTTY) {
              if (w[kind]) await putEvent(this.env, sibling(href, kind), pottyICS({ ...w, dog: w.dog || 'Dog' }, kind, now));
              else await deleteEvent(this.env, sibling(href, kind));
            }
            next = { state: 'synced', href, rev };
          }
        } else {
          const href = c.href || (url && url + UID_PREFIX + w.id + '.ics');
          if (href) await this.dropEvents(href);
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
