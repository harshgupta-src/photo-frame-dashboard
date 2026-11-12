import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WalkStore } from '../src/walkstore.js';

const LL = 'https://lifelog.test', CAL = 'https://caldav.test/cal/', HCAL = 'https://caldav.test/harsh/', HA = 'https://ha.test/hook';
let events, ical, env, kv, hooks;

// Just enough of Lifelog's REST API (/events, /events/:id) and iCloud CalDAV PUT/DELETE.
function fakeFetch(url, init = {}) {
  const m = init.method || 'GET', u = new URL(url);
  const res = (status, j) => Promise.resolve(new Response(j === undefined ? null : JSON.stringify(j), { status }));
  if (url === HA) { hooks.push(JSON.parse(init.body)); return res(200, {}); }
  if (url.startsWith('https://caldav.test/')) {
    if (m === 'PUT') ical.set(url, init.body); else ical.delete(url);
    return res(m === 'PUT' ? 201 : 204);
  }
  assert.ok(url.startsWith(LL), url);
  const body = init.body ? JSON.parse(init.body) : null;
  const now = new Date().toISOString(), one = /^\/events\/(.+)$/.exec(u.pathname), id = one && decodeURIComponent(one[1]);
  const e = id && events.get(id);
  if (u.pathname === '/events' && m === 'GET') {
    const q = u.searchParams;
    return res(200, [...events.values()].filter((x) => x.type === q.get('type') && (q.get('deleted') === '1' || !x.deleted_at) &&
      (!q.get('since') || x.started_at >= q.get('since'))).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).map((x) => structuredClone(x)));
  }
  if (m === 'GET') return e ? res(200, structuredClone(e)) : res(404, { error: 'not found' });
  if (m === 'PUT') {
    if (e && e.type !== body.type) return res(400, { error: 'type' });
    events.set(id, { ...body, id, created_at: e ? e.created_at : now, updated_at: now, deleted_at: null });
    return res(e ? 200 : 201, structuredClone(events.get(id)));
  }
  if (m === 'PATCH') { e.data = { ...e.data, ...body.data }; e.updated_at = now; return res(200, structuredClone(e)); }
  if (m === 'DELETE') { e.deleted_at = now; return res(200, structuredClone(e)); }
  return res(404, { error: 'not found' });
}

beforeEach(() => {
  events = new Map();
  ical = new Map();
  hooks = [];
  globalThis.fetch = fakeFetch;
  kv = new Map([
    ['walk-calendar:family', JSON.stringify({ name: 'Family', url: CAL })],
    ['walk-calendar:harsh', JSON.stringify({ name: 'Harsh', url: HCAL })],
  ]);
  env = {
    LIFELOG_URL: LL + '/', LIFELOG_TOKEN: 't', LIFELOG_WALK_TYPE: 'rex_walk', WALK_CALENDAR: 'Family',
    WALK_PLAN_CALENDARS: '{"harsh": "Harsh"}',
    DATA: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } },
  };
});

// Runs the deferred calendar work like the Workers runtime would, then returns the result.
async function call(op, ...args) {
  const waits = [];
  const r = await new WalkStore(env, { waitUntil: (p) => waits.push(p) }).run(op, ...args);
  await Promise.all(waits);
  return r;
}

test('a stop within a minute of the start discards the walk instead of logging it', async () => {
  const id = (await call('start', { by: 'harsh' })).body.id;
  const r = await call('stop', {});
  assert.deepEqual([r.status, r.body.discarded, r.body.id], [200, true, id]);
  assert.ok(events.get(id).deleted_at);
  assert.equal([...events.values()].filter((x) => !x.deleted_at).length, 0);
  assert.equal(ical.size, 0);
});

test('start and stop store one Lifelog event and mirror it to the calendar', async () => {
  const started = await call('start', { by: 'harsh' });
  assert.equal(started.status, 200);
  const id = started.body.id;
  assert.equal(events.get(id).ended_at, null);
  assert.equal(ical.size, 0);
  assert.equal((await call('start', {})).status, 409);

  events.get(id).started_at = new Date(Date.now() - 20 * 60e3).toISOString(); // out for 20 minutes
  const stopped = await call('stop', { poop: 'Yes' });
  assert.equal(stopped.body.id, id);
  const e = events.get(id);
  assert.deepEqual([...events.values()].map((x) => x.type).sort(), ['rex_pee', 'rex_poop', 'rex_walk']);
  assert.equal(e.type, 'rex_walk');
  assert.equal(e.person, 'Harsh');
  assert.deepEqual([e.data.pee, e.data.poop, e.data.walker_ids], [true, true, ['harsh']]);
  assert.equal(e.data.calendar.state, 'synced');
  assert.match(ical.get(CAL + 'dog-walk-' + id + '.ics'), /UID:dog-walk-.*@frame-data/);

  const s = (await call('state')).body;
  assert.equal(s.active, null);
  assert.deepEqual(Object.keys(s.recent[0]).filter((k) => s.recent[0][k] !== undefined),
    ['id', 'startedAt', 'endedAt', 'durationMin', 'localDate', 'pee', 'poop', 'walkers', 'walkerIds', 'source', 'calendar']);
  assert.equal(s.recent[0].calendar, 'synced');
  assert.equal(s.calendar.synced, 1);
});

test('the frame\'s names are kept and an unchanged PUT writes nothing', async () => {
  const t = Date.now() - 40 * 60e3;
  const body = { startedAt: t, endedAt: t + 30 * 60e3, pee: true, poop: false, walkers: [{ id: 'harsh', name: 'Harsh G' }], tz: 'America/New_York', dog: 'Rex', source: 'frame' };
  await call('upsert', 'walk-aaaaaa', body);
  const before = events.get('walk-aaaaaa').updated_at;
  assert.equal((await call('upsert', 'walk-aaaaaa', body)).body.calendar, 'synced');
  assert.equal(events.get('walk-aaaaaa').updated_at, before);
  const r = await call('start', { by: 'harsh' });
  assert.deepEqual(r.body.walkers, ['Harsh G']);
});

test('deleting a walk soft-deletes it and removes its calendar event', async () => {
  const t = Date.now() - 40 * 60e3;
  await call('upsert', 'walk-bbbbbb', { startedAt: t, endedAt: t + 20 * 60e3 });
  assert.equal(ical.size, 1);
  assert.deepEqual((await call('remove', 'walk-bbbbbb')).body, { ok: true, id: 'walk-bbbbbb', existed: true });
  assert.ok(events.get('walk-bbbbbb').deleted_at);
  assert.equal(events.get('walk-bbbbbb').data.calendar.state, 'none');
  assert.equal(ical.size, 0);
  assert.equal((await call('state')).body.recent.length, 0);
});

test('a walk an agent logs or edits in Lifelog reaches the calendar on the next GET /walk', async () => {
  const t = new Date(Date.now() - 3600e3).toISOString(), end = new Date(Date.now() - 3000e3).toISOString();
  events.set('agent-1', { id: 'agent-1', type: 'rex_walk', person: 'Harsh', started_at: t, ended_at: end, source: 'mcp:copilot', data: { pee: true, walkers: ['Harsh'] }, updated_at: t });
  const s = (await call('state')).body;
  assert.deepEqual(s.recent[0].walkers, ['Harsh']);
  assert.equal(events.get('agent-1').data.calendar.state, 'synced');
  events.get('agent-1').data.notes = 'met a cat';
  assert.equal((await call('state')).body.recent[0].calendar, 'pending');
  assert.match(ical.get(CAL + 'dog-walk-agent-1.ics'), /met a cat/);
});

test('Lifelog being down is a 502, so the frame keeps the change queued', async () => {
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  assert.equal((await call('state')).status, 502);
  assert.equal((await call('upsert', 'walk-cccccc', { startedAt: Date.now() - 60e3 })).status, 502);
});

test('a ticked pee and poop become their own Lifelog and calendar events; unticking removes them', async () => {
  const t = Date.now() - 40 * 60e3, body = { startedAt: t, endedAt: t + 20 * 60e3, pee: true, poop: true, walkers: ['harsh'] };
  await call('upsert', 'walk-dddddd', body);
  const pee = events.get('walk-dddddd-pee'), poop = events.get('walk-dddddd-poop');
  assert.deepEqual([pee.type, poop.type], ['rex_pee', 'rex_poop']);
  assert.equal(Date.parse(pee.started_at), t + 60e3);
  assert.equal(Date.parse(poop.started_at), t + 3 * 60e3);
  assert.equal(pee.ended_at, pee.started_at);
  assert.equal(poop.data.walk_id, 'walk-dddddd');
  assert.match(ical.get(CAL + 'dog-walk-walk-dddddd-poop.ics'), /SUMMARY:Dog poop/);
  assert.equal(ical.size, 3);

  await call('upsert', 'walk-dddddd', { ...body, poop: false });
  assert.ok(events.get('walk-dddddd-poop').deleted_at);
  assert.ok(!events.get('walk-dddddd-pee').deleted_at);
  assert.equal(ical.has(CAL + 'dog-walk-walk-dddddd-poop.ics'), false);

  await call('remove', 'walk-dddddd');
  assert.ok(events.get('walk-dddddd-pee').deleted_at);
  assert.equal(ical.size, 0);
});

test('walks mirrored to an older calendar move to WALK_CALENDAR', async () => {
  const t = new Date(Date.now() - 3600e3).toISOString(), end = new Date(Date.now() - 3000e3).toISOString(), OLD = 'https://caldav.test/old/';
  ical.set(OLD + 'dog-walk-walk-eeeeee.ics', 'x');
  events.set('walk-eeeeee', { id: 'walk-eeeeee', type: 'rex_walk', started_at: t, ended_at: end, source: 'frame', updated_at: t,
    data: { pee: false, walkers: ['Harsh'], calendar: { state: 'synced', href: OLD + 'dog-walk-walk-eeeeee.ics', rev: 'old' } } });
  await call('state');
  assert.deepEqual([...ical.keys()], [CAL + 'dog-walk-walk-eeeeee.ics']);
  assert.equal(events.get('walk-eeeeee').data.calendar.href, CAL + 'dog-walk-walk-eeeeee.ics');
});

test('a planned walk goes on its walker\'s calendar and comes off once it is walked', async () => {
  env.HA_WALK_WEBHOOK_URL = HA;
  const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
  // Lifelog has no walks yet, so the household time zone is UTC.
  const start = new Date(now + 3600e3).toISOString();
  const r = await call('putPlan', date, { walks: [{ start, durationMin: 30, walkers: ['harsh'], note: 'long one' }] });
  if (new Date(now + 3600e3).toISOString().slice(0, 10) !== date) return; // near midnight UTC: skip
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const item = r.body.walks[0];
  assert.deepEqual([item.status, item.calendar, item.walkerIds], ['planned', 'synced', ['harsh']]);
  const href = HCAL + 'walk-plan-' + item.id + '.ics';
  assert.match(ical.get(href), /SUMMARY:🐕 Dog walk — Harsh/);
  assert.equal((await call('putPlan', date, { walks: [{ start: '2000-01-01T00:00:00Z', walkers: ['harsh'] }] })).status, 400);

  const started = await call('upsert', 'walk-ffffff', { startedAt: now - 60e3, walkers: ['harsh'], planId: item.id });
  assert.equal(started.body.planId, item.id);
  assert.equal((await call('state')).body.plans[0].walks[0].status, 'active');
  assert.ok(ical.has(href));
  await call('upsert', 'walk-ffffff', { startedAt: now - 60e3, endedAt: now, walkers: ['harsh'], planId: item.id, pee: true });
  assert.equal(ical.has(href), false);
  const p = (await call('getPlan', date)).body;
  assert.deepEqual([p.walks[0].status, p.walks[0].walkId], ['done', 'walk-ffffff']);
  assert.deepEqual(hooks.map((h) => h.event), ['start', 'stop']);
  assert.deepEqual(hooks[1].walk.walkerIds, ['harsh']);

  await call('remove', 'walk-ffffff');
  assert.ok(ical.has(href), 'deleting the walk puts the planned event back');
  await call('deletePlan', date);
  assert.equal(ical.has(href), false);
});

test('Home Assistant polls the active walk and stores its route, which goes with the walk', async () => {
  assert.equal((await call('active')).body.active, null);
  const id = (await call('start', { by: 'harsh' })).body.id;
  assert.equal((await call('active')).body.active.id, id);
  const t = Date.now() / 1000;
  const points = [
    { who: 'harsh', lat: 42.3043, lon: -71.1109, acc: 10, t: t - 600 },
    { who: 'harsh', lat: 42.3052, lon: -71.1109, acc: 12, t: t - 500 }, // 100 m north
    { who: 'harsh', lat: 42.3300, lon: -71.1109, acc: 900, t: t - 450 }, // bad fix, skipped
    { who: 'harsh', lat: 42.3052, lon: -71.1109, acc: 12, t: t - 400 },
    { who: 'harsh', lat: 42.3052, lon: -71.1109, acc: 8, t: t - 300 }, // same spot again, dropped
  ];
  const r = await call('putRoute', id, { points, source: 'ha' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = events.get(id + '-route');
  assert.equal(e.type, 'rex_walk_route');
  assert.equal(e.data.paths.harsh.length, 4);
  assert.ok(Math.abs(e.data.distance_m - 100) < 2, String(e.data.distance_m));
  assert.equal((await call('putRoute', 'walk-nonexist', { points })).status, 404);
  await call('remove', id);
  assert.ok(events.get(id + '-route').deleted_at);
});
