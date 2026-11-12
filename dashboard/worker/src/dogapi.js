// GET /dog?days=30 — the frame's dog tab (js/dog.js, js/views/dog.js): what Lifelog knows about the
// dog besides the walks themselves (the frame has those from GET /walk). Types share the walk type's
// prefix (LIFELOG_WALK_TYPE maya_walk → maya_meal, maya_weight, maya_walk_route):
//   <dog>_meal        one per meal fed (Home Assistant's NFC tap, ../../WALKS.md "Lifelog"); data
//                     {meal, cups, planned_at, delta_min, ate, purina_pct, fortiflora, calendar}
//   <dog>_weight      a weigh-in; data {kg} or {lbs}, optional {where, note}
//   <dog>_walk_route  a walk's route; only {walk_id, distance_m} is sent
//   <dog>_pee, <dog>_poop  potty breaks: the walk's own (id <walk id>-pee) and any logged on their own
// Plus `log`: the events in the Life Log calendar (LOG_CALENDAR, default WALK_CALENDAR), where what
// actually happened ends up (walks, pee/poop, and planned meals moved there once they're done), so
// the frame can tell the plan (everyone's calendars) from what was done. Kept out of /events so the
// schedule doesn't fill up with it. A calendar error only sets logError.
// Read-only, same keys as /walk.
import { Lifelog, WalkStore, walkCalendarName } from './walkstore.js';
import { calendarObjects } from './icloud.js';
import { expandICS } from './ics.js';

const DAY = 864e5;
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

export function dogPrefix(env) {
  const t = String(env.LIFELOG_WALK_TYPE || 'dog_walk');
  return t.endsWith('_walk') ? t.slice(0, -5) : t;
}

export function mealJSON(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  return {
    id: e.id, at: e.started_at, meal: d.meal || 'Meal', person: e.person || null,
    cups: num(d.cups), plannedAt: d.planned_at || null, deltaMin: num(d.delta_min),
    ate: d.ate || null, purinaPct: num(d.purina_pct), fortiflora: d.fortiflora ?? null,
  };
}

export function weightJSON(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  const kg = num(d.kg) ?? (num(d.lbs) == null ? null : Math.round(num(d.lbs) * 0.45359237 * 10) / 10);
  return kg == null ? null : { id: e.id, at: e.started_at, kg, where: d.where || null, note: d.note || null };
}

export function logCalendarName(env) {
  const n = String(env.LOG_CALENDAR || '').trim();
  if (n) return /^(none|off)$/i.test(n) ? null : n;
  return walkCalendarName(env);
}

const LOG_TTL = 120;
async function logEvents(env, days, now) {
  const name = logCalendarName(env);
  if (!name) return { log: [], logCalendar: null };
  const key = 'dog-log:' + days;
  const cached = env.DATA && await env.DATA.get(key, 'json');
  if (cached && cached.name === name && now - cached.at < LOG_TTL * 1000) return { log: cached.log, logCalendar: name };
  try {
    const url = await new WalkStore(env).calendarUrl(false, name);
    const from = new Date(now - days * DAY), to = new Date(now + DAY), log = [];
    for (const t of await calendarObjects(env, url, from, to)) log.push(...expandICS(t, { name, people: [] }, from, to));
    log.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const out = log.map(({ people, cal, ...e }) => e);
    if (env.DATA) await env.DATA.put(key, JSON.stringify({ name, at: now, log: out }));
    return { log: out, logCalendar: name };
  } catch (e) {
    return { log: cached ? cached.log : [], logCalendar: name, logError: e.message };
  }
}

export async function dogData(env, days, now = Date.now()) {
  const p = dogPrefix(env), ll = new Lifelog(env);
  const list = async (type, since, limit) => {
    const q = new URLSearchParams({ type, limit: String(limit) });
    if (since) q.set('since', new Date(since).toISOString());
    return (await ll.req('GET', '/events?' + q)) || [];
  };
  const since = now - days * DAY;
  // Weigh-ins are rare, so all of them (growth curve since day one).
  const [meals, weights, routes, pees, poops, cal] = await Promise.all([
    list(p + '_meal', since, 1000), list(p + '_weight', null, 500), list(p + '_walk_route', since, 1000),
    list(p + '_pee', since, 1000), list(p + '_poop', since, 1000), logEvents(env, days, now),
  ]);
  const potty = (kind) => (e) => ({ id: e.id, kind, at: e.started_at, walkId: (e.data || {}).walk_id || null, person: e.person || null });
  return {
    now: new Date(now).toISOString(), days, ...cal,
    potty: pees.map(potty('pee')).concat(poops.map(potty('poop'))),
    meals: meals.map(mealJSON),
    weights: weights.map(weightJSON).filter(Boolean),
    routes: routes.map((e) => ({ walkId: (e.data || {}).walk_id || null, m: num((e.data || {}).distance_m) }))
      .filter((r) => r.walkId && r.m != null),
    lastRoute: lastRoute(routes),
  };
}

// The newest walk's path for the route map: the walker with the most good fixes (≤ 50 m), at most
// 300 points as [lat, lon].
export function lastRoute(routes) {
  const e = routes.filter((r) => r.data && r.data.paths && r.data.walk_id)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  if (!e) return null;
  let best = [];
  for (const list of Object.values(e.data.paths)) {
    const good = (list || []).filter((x) => Array.isArray(x) && (x[2] == null || x[2] <= 50));
    if (good.length > best.length) best = good;
  }
  if (best.length < 2) return null;
  const step = Math.ceil(best.length / 300);
  const path = best.filter((x, i) => i % step === 0 || i === best.length - 1).map((x) => [x[0], x[1]]);
  return { walkId: e.data.walk_id, start: e.started_at, end: e.ended_at, m: num(e.data.distance_m), path };
}

export async function dogRoute(req, url, env, access) {
  if (req.method !== 'GET') return { status: 404, body: { error: 'not found' } };
  if (!access.read) return { status: 401, body: { error: 'unauthorized' } };
  const n = parseInt(url.searchParams.get('days'), 10);
  const days = Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
  try {
    return { status: 200, body: await dogData(env, days) };
  } catch (e) {
    return { status: e.status || 502, body: { error: e.message } };
  }
}

// GET /tile?z=&x=&y=  an OpenStreetMap tile for the dog tab's route map. Proxied so the frame sends
// a proper User-Agent, and cached for a week at the edge and in the browser (OSM's tile usage policy).
export async function mapTile(url, ctx) {
  const n = (k) => Number(url.searchParams.get(k));
  const z = n('z'), x = n('x'), y = n('y');
  if (![z, x, y].every(Number.isInteger) || z < 3 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return new Response('bad tile', { status: 400 });
  const key = new Request(`https://tile.cache/${z}/${x}/${y}.png`), cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers: { 'User-Agent': 'photo-frame-dashboard/1.0 (+https://github.com/harshgupta-src/photo-frame-dashboard)' },
  });
  if (!r.ok) return new Response('tile unavailable', { status: 502 });
  const out = new Response(r.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  if (cache) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
