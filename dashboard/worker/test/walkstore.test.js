import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WalkStore } from '../src/walkstore.js';

const LL = 'https://lifelog.test', CAL = 'https://caldav.test/cal/';
let events, ical, env;

// Just enough of Lifelog's REST API (/events, /events/:id) and iCloud CalDAV PUT/DELETE.
function fakeFetch(url, init = {}) {
  const m = init.method || 'GET', u = new URL(url);
  const res = (status, j) => Promise.resolve(new Response(j === undefined ? null : JSON.stringify(j), { status }));
  if (url.startsWith(CAL)) {
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
  globalThis.fetch = fakeFetch;
  env = {
    LIFELOG_URL: LL + '/', LIFELOG_TOKEN: 't', LIFELOG_WALK_TYPE: 'rex_walk', WALK_CALENDAR: 'Family',
    DATA: { get: async () => ({ name: 'Family', url: CAL }), put: async () => {} },
  };
});

// Runs the deferred calendar work like the Workers runtime would, then returns the result.
async function call(op, ...args) {
  const waits = [];
  const r = await new WalkStore(env, { waitUntil: (p) => waits.push(p) }).run(op, ...args);
  await Promise.all(waits);
  return r;
}

test('start and stop store one Lifelog event and mirror it to the calendar', async () => {
  const started = await call('start', { by: 'harsh' });
  assert.equal(started.status, 200);
  const id = started.body.id;
  assert.equal(events.get(id).ended_at, null);
  assert.equal(ical.size, 0);
  assert.equal((await call('start', {})).status, 409);

  const stopped = await call('stop', { poop: 'Yes' });
  assert.equal(stopped.body.id, id);
  const e = events.get(id);
  assert.equal(events.size, 1);
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
