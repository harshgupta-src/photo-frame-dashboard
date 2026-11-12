import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dogData, dogRoute, lastRoute } from '../src/dogapi.js';

const LL = 'https://lifelog.test', CAL = 'https://caldav.test/log/';
let events, env, kv, calendar;

const ev = (type, id, at, data = {}, person = null) => events.push({ type, id, started_at: at, data, person, source: 'test' });
const vevent = (uid, start, summary) => 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:' + uid + '\r\nDTSTART:' + start + '\r\nDTEND:' + start.replace(/00Z$/, '30Z') +
  '\r\nSUMMARY:' + summary + '\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

// Lifelog's GET /events (one type, since, newest first) and a CalDAV REPORT on the Life Log calendar.
function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (url.startsWith('https://caldav.test/')) {
    if (calendar === 'down') return Promise.resolve(new Response('', { status: 503 }));
    const body = calendar.map((t, i) => '<d:response><d:href>/log/' + i + '.ics</d:href><d:propstat><d:prop><c:calendar-data>' +
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('');
    return Promise.resolve(new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' + body + '</d:multistatus>', { status: 207 }));
  }
  assert.equal(u.origin + u.pathname, LL + '/events');
  const q = u.searchParams;
  const out = events.filter((x) => x.type === q.get('type') && (!q.get('since') || x.started_at >= q.get('since')))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return Promise.resolve(new Response(JSON.stringify(out), { status: 200 }));
}

beforeEach(() => {
  events = [];
  calendar = [];
  globalThis.fetch = fakeFetch;
  kv = new Map([['walk-calendar:life log', JSON.stringify({ name: 'Life Log', url: CAL })]]);
  env = {
    LIFELOG_URL: LL + '/', LIFELOG_TOKEN: 't', LIFELOG_WALK_TYPE: 'maya_walk', WALK_CALENDAR: 'Life Log',
    ICLOUD_APPLE_ID: 'a', ICLOUD_APP_PASSWORD: 'b',
    DATA: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } },
  };
});

const NOW = Date.parse('2026-11-12T17:00:00Z');

test('meals, weigh-ins, potty, walk distances and the Life Log calendar in one answer', async () => {
  ev('maya_meal', 'maya_meal-2026-11-12-breakfast', '2026-11-12T11:44:27Z',
    { meal: 'Breakfast', cups: 0.75, planned_at: '2026-11-12T06:45:00-05:00', delta_min: -1, ate: 'all' }, 'harsh');
  ev('maya_meal', 'maya_meal-2026-09-01-lunch', '2026-09-01T16:00:00Z', { meal: 'Lunch' }, 'harsh'); // older than days
  ev('maya_weight', 'w1', '2026-10-31T15:00:00Z', { kg: 16.8, where: 'vet' });
  ev('maya_pee', 'w9-pee', '2026-11-12T11:30:00Z', { walk_id: 'w9' }, 'Harsh');
  ev('maya_poop', 'nfc-1', '2026-11-12T13:00:00Z');
  ev('maya_walk_route', 'r1', '2026-11-12T11:29:00Z', { walk_id: 'w9', distance_m: 812 });
  calendar = [vevent('hb-maya-meal-2026-11-12-breakfast', '20261112T114400Z', 'Maya breakfast 3/4 cup'),
    vevent('dog-walk-w9-pee@frame-data', '20261112T113000Z', 'Maya pee 💧')];

  const d = await dogData(env, 7, NOW);
  assert.deepEqual(d.meals.map((m) => [m.meal, m.person, m.cups, m.deltaMin, m.plannedAt]),
    [['Breakfast', 'harsh', 0.75, -1, '2026-11-12T06:45:00-05:00']]);
  assert.deepEqual(d.weights.map((w) => [w.kg, w.where]), [[16.8, 'vet']]);
  assert.deepEqual(d.potty.map((p) => [p.kind, p.walkId]).sort(), [['pee', 'w9'], ['poop', null]]);
  assert.deepEqual(d.routes, [{ walkId: 'w9', m: 812 }]);
  assert.equal(d.logCalendar, 'Life Log');
  assert.deepEqual(d.log.map((e) => e.title), ['Maya pee 💧', 'Maya breakfast 3/4 cup']);
  assert.equal(d.logError, undefined);
});

test('a calendar error keeps the Lifelog data and the last calendar answer', async () => {
  calendar = [vevent('x1', '20261112T120000Z', 'Maya lunch 1 cup')];
  assert.equal((await dogData(env, 7, NOW)).log.length, 1);
  calendar = 'down';
  ev('maya_poop', 'p1', '2026-11-12T13:00:00Z');
  const d = await dogData(env, 7, NOW + 10 * 60e3); // past the cache's 2 minutes
  assert.equal(d.potty.length, 1);
  assert.equal(d.log.length, 1);
  assert.match(d.logError, /503|iCloud/);
});

test('LOG_CALENDAR=none leaves the calendar out; GET only, needs the read key', async () => {
  env.LOG_CALENDAR = 'none';
  const d = await dogData(env, 7, NOW);
  assert.deepEqual([d.log, d.logCalendar], [[], null]);
  const url = new URL('https://w.test/dog?days=999');
  assert.equal((await dogRoute(new Request(url), url, env, { read: false })).status, 401);
  assert.equal((await dogRoute(new Request(url, { method: 'POST' }), url, env, { read: true })).status, 404);
  const r = await dogRoute(new Request(url), url, env, { read: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 365);
});

test('lastRoute takes the newest walk and the walker with the most accurate fixes', () => {
  const r = (id, at, paths) => ({ started_at: at, ended_at: at, data: { walk_id: id, distance_m: 900, paths } });
  const out = lastRoute([
    r('old', '2026-11-11T10:00:00Z', { harsh: [[1, 1, 5, 0], [2, 2, 5, 1]] }),
    r('new', '2026-11-12T10:00:00Z', { harsh: [[1, 1, 5, 0], [9, 9, 400, 1], [2, 2, 5, 2]], ambuja: [[3, 3, 90, 0], [4, 4, 90, 1]] }),
  ]);
  assert.deepEqual([out.walkId, out.m, out.path], ['new', 900, [[1, 1], [2, 2]]]);
  assert.equal(lastRoute([r('x', '2026-11-12T10:00:00Z', { harsh: [[1, 1, 5, 0]] })]), null);
});
