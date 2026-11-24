import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MealStore, mealKind, fmtCups, exdateICS } from '../src/meals.js';
import { expandICS } from '../src/ics.js';
import { calKey } from '../src/icloud.js';

const LL = 'https://lifelog.test', DAV = 'https://caldav.test/';
const CALS = { 'Harsh’s Calendar': DAV + 'h/', 'Ambuja’s Calendar': DAV + 'a/', 'A&H Life': DAV + 'ah/', 'Life Log': DAV + 'log/' };
let objects, kv, env, failPut;

const unfold = (s) => s.replace(/\r\n[ \t]/g, '');
const vevent = (uid, start, end, summary, desc) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:' + uid + '\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:' + start +
  '\r\nDTEND:' + end + '\r\nSUMMARY:' + summary + (desc ? '\r\nDESCRIPTION:' + desc : '') + '\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

// CalDAV: REPORT lists a calendar's objects (no time filtering), PUT/DELETE one object. Lifelog: no walks.
function fakeFetch(url, init = {}) {
  if (url.startsWith(LL)) return Promise.resolve(new Response('[]', { status: 200 }));
  const m = init.method || 'GET';
  if (m === 'REPORT') {
    const body = [...objects].filter(([h]) => h.startsWith(url)).map(([h, t]) => '<d:response><d:href>' + new URL(h).pathname + '</d:href><d:propstat><d:prop><c:calendar-data>' +
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('');
    return Promise.resolve(new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' + body + '</d:multistatus>', { status: 207 }));
  }
  if (m === 'GET') return Promise.resolve(objects.has(url) ? new Response(objects.get(url), { status: 200 }) : new Response('', { status: 404 }));
  if (m === 'PUT') {
    if (failPut && failPut(url)) return Promise.resolve(new Response('', { status: 503 }));
    objects.set(url, init.body); return Promise.resolve(new Response('', { status: 201 }));
  }
  if (m === 'DELETE') return Promise.resolve(new Response(null, { status: objects.delete(url) ? 204 : 404 }));
  throw new Error('unexpected ' + m + ' ' + url);
}

beforeEach(() => {
  globalThis.fetch = fakeFetch;
  failPut = null;
  objects = new Map([
    [CALS['A&H Life'] + 'b1.ics', vevent('b1', '20261116T144500Z', '20261116T150000Z', 'Maya · Breakfast', 'cups: 1.25')],
    [CALS['Harsh’s Calendar'] + 'hb-maya-meal-2026-11-16-lunch.ics', vevent('hb-maya-meal-2026-11-16-lunch', '20261116T203000Z', '20261116T204500Z', 'Maya lunch 1 cup')],
    [CALS['A&H Life'] + 's1.ics', vevent('s1', '20261117T050000Z', '20261117T051000Z', 'Maya snack 1/4 cup')],
    [CALS['A&H Life'] + 'prep.ics', vevent('prep', '20261116T143000Z', '20261116T144500Z', 'Maya prep')],
  ]);
  kv = new Map(Object.entries(CALS).map(([n, u]) => ['walk-calendar:' + calKey(n), JSON.stringify({ name: n, url: u })]));
  env = {
    LIFELOG_URL: LL, LIFELOG_TOKEN: 't', TZ: 'America/Los_Angeles', WALK_CALENDAR: 'Life Log', ICLOUD_APPLE_ID: 'a', ICLOUD_APP_PASSWORD: 'b',
    WALK_PLAN_CALENDARS: JSON.stringify({ harsh: 'Harsh’s Calendar', ambuja: 'Ambuja’s Calendar', 'ambuja+harsh': 'A&H Life' }),
    DATA: {
      get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); },
      list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
  };
});

test('meal kinds and cups follow the Home Assistant sensor', () => {
  assert.equal(mealKind('Maya snack 1/2 cup', 10), 'walk-snack');
  assert.equal(mealKind('Maya snack 1/4 cup', 21), 'night-snack');
  assert.equal(mealKind('Maya prep', 6), null);
  assert.equal(mealKind('🐕 Maya walk — Harsh', 16), null);
  assert.deepEqual([fmtCups(1.25), fmtCups(0.5), fmtCups(1), fmtCups(0.3)], ['1 1/4 cups', '1/2 cup', '1 cup', '0.3 cup']);
});

test('GET lists the day\'s meals with their usual times', async () => {
  const r = await new MealStore(env).get('2026-11-16');
  assert.deepEqual(r.meals.map((m) => [m.id, m.usual, m.calendar, m.cups]), [
    ['maya_meal-2026-11-16-breakfast', '06:45', 'A&H Life', 1.25],
    ['maya_meal-2026-11-16-lunch', '12:30', 'Harsh’s Calendar', 1],
    ['maya_meal-2026-11-16-night-snack', '21:00', 'A&H Life', 0.25],
  ]);
});

test('a plan moves a meal in place, reassigns it to another calendar, and brings it back', async () => {
  const s = new MealStore(env), href = CALS['Harsh’s Calendar'] + 'hb-maya-meal-2026-11-16-lunch.ics';
  let r = await s.putPlan('2026-11-16', { meals: [{ kind: 'Lunch', start: '13:15', people: ['harsh'] }, { kind: 'breakfast', start: '06:45' }], reason: 'Harsh has a 12:00–13:00 call' });
  assert.deepEqual(r.changed.map((c) => [c.kind, c.calendar]), [['lunch', 'Harsh’s Calendar']]);
  assert.deepEqual(r.unchanged, ['breakfast']);
  assert.match(objects.get(href), /DTSTART:20261116T211500Z/);
  assert.match(objects.get(href), /X-MAYA-USUAL:12:30/);
  assert.match(objects.get(href), /Moved from the usual 12:30: Harsh has a 12:00–13:00 call/);

  r = await s.putPlan('2026-11-16', { meals: [{ kind: 'lunch', start: '12:30', people: ['ambuja'] }] });
  assert.equal(objects.has(href), false);
  const moved = objects.get(CALS['Ambuja’s Calendar'] + 'hb-maya-meal-2026-11-16-lunch.ics');
  assert.match(moved, /UID:hb-maya-meal-2026-11-16-lunch/);
  assert.match(moved, /DTSTART:20261116T203000Z/);
  assert.doesNotMatch(moved, /Moved from/);
  const g = await s.get('2026-11-16');
  assert.deepEqual(g.meals.find((m) => m.kind === 'lunch').people, ['ambuja']);
  assert.equal(g.meals.find((m) => m.kind === 'lunch').moved, false);
});

test('a logged meal moves to Life Log; undo puts the plan back', async () => {
  const s = new MealStore(env), planned = CALS['A&H Life'] + 'b1.ics', before = objects.get(planned);
  const r = await s.log({ id: 'maya_meal-2026-11-16-breakfast', person: 'ambuja', at: '2026-11-16T06:57:00-08:00', delta_min: 12, purina_pct: 75, source: 'ha-nfc' });
  assert.equal(r.removedFrom, 'A&H Life');
  assert.equal(objects.has(planned), false);
  const log = unfold(objects.get(CALS['Life Log'] + 'maya_meal-2026-11-16-breakfast.ics'));
  assert.match(log, /SUMMARY:Maya breakfast 🍽️ 1 1\/4 cups — Ambuja/);
  assert.match(log, /DTSTART:20261116T145700Z/);
  assert.match(log, /Fed at: 6:57 AM \(planned 6:45 AM\\, 12 min late\)/);
  assert.match(log, /Food: 1 1\/4 cups · 75% Purina/);

  await s.log({ id: 'maya_meal-2026-11-16-breakfast', ate: 'some' });
  const again = unfold(objects.get(CALS['Life Log'] + 'maya_meal-2026-11-16-breakfast.ics'));
  assert.match(again, /Ate: some/);
  assert.match(again, /12 min late/);

  const u = await s.unlog('maya_meal-2026-11-16-breakfast');
  assert.deepEqual([u.removed, u.restored], [true, 'A&H Life']);
  assert.equal(objects.get(planned).trim(), before.trim());
  assert.equal(objects.has(CALS['Life Log'] + 'maya_meal-2026-11-16-breakfast.ics'), false);
});

const SERIES = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nDTSTART:20071104T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n' +
  'TZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:20070311T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n' +
  'BEGIN:VEVENT\r\nUID:SER-1\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;TZID=America/New_York:20261110T183000\r\nDTEND;TZID=America/New_York:20261110T184500\r\nRRULE:FREQ=DAILY;UNTIL=20261120T235959Z\r\nSUMMARY:Maya dinner 3/4 cup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('a recurring meal: the moved day becomes its own event, logging takes a day out, undo restores the series', async () => {
  objects.set(CALS['A&H Life'] + 'ser.ics', SERIES);
  env.TZ = 'America/New_York';
  const s = new MealStore(env), dinners = (from, to) => expandICS(objects.get(CALS['A&H Life'] + 'ser.ics'), { name: 'x' }, new Date(from), new Date(to)).map((e) => e.start);
  const r = await s.putPlan('2026-11-16', { meals: [{ kind: 'dinner', start: '19:15', people: ['ambuja'] }], reason: 'Harsh at a dinner' });
  assert.equal(r.changed[0].calendar, 'Ambuja’s Calendar');
  assert.deepEqual(dinners('2026-11-15T12:00:00Z', '2026-11-18T12:00:00Z'), ['2026-11-15T23:30:00.000Z', '2026-11-17T23:30:00.000Z']);
  const own = unfold(objects.get(CALS['Ambuja’s Calendar'] + 'maya-meal-plan-2026-11-16-dinner.ics'));
  assert.match(own, /DTSTART:20261117T001500Z/);
  assert.match(own, /X-MAYA-USUAL:18:30/);
  const g = (await s.get('2026-11-16')).meals.find((m) => m.kind === 'dinner');
  assert.deepEqual([g.calendar, g.recurring, g.usual, g.moved], ['Ambuja’s Calendar', false, '18:30', true]);

  await s.log({ id: 'maya_meal-2026-11-17-dinner', person: 'harsh', at: '2026-11-17T18:40:00-05:00' });
  assert.deepEqual(dinners('2026-11-17T12:00:00Z', '2026-11-19T12:00:00Z'), ['2026-11-18T23:30:00.000Z']);
  assert.match(unfold(objects.get(CALS['Life Log'] + 'maya_meal-2026-11-17-dinner.ics')), /SUMMARY:Maya dinner 🍽️ 3\/4 cup — Harsh/);
  await s.unlog('maya_meal-2026-11-17-dinner');
  assert.deepEqual(dinners('2026-11-17T12:00:00Z', '2026-11-19T12:00:00Z'), ['2026-11-17T23:30:00.000Z', '2026-11-18T23:30:00.000Z']);
});

test('undoing one day of a series keeps the days logged since', async () => {
  objects.set(CALS['A&H Life'] + 'ser.ics', SERIES);
  env.TZ = 'America/New_York';
  const s = new MealStore(env), dinners = () => expandICS(objects.get(CALS['A&H Life'] + 'ser.ics'), { name: 'x' }, new Date('2026-11-16T12:00:00Z'), new Date('2026-11-19T12:00:00Z')).map((e) => e.start);
  await s.log({ id: 'maya_meal-2026-11-16-dinner', person: 'harsh', at: '2026-11-16T18:40:00-05:00' });
  await s.log({ id: 'maya_meal-2026-11-17-dinner', person: 'ambuja', at: '2026-11-17T18:35:00-05:00' });
  assert.deepEqual(dinners(), ['2026-11-18T23:30:00.000Z']);
  await s.unlog('maya_meal-2026-11-16-dinner');
  assert.deepEqual(dinners(), ['2026-11-16T23:30:00.000Z', '2026-11-18T23:30:00.000Z']);
});

test('a planned meal that could not be taken out is taken out when the meal is logged again', async () => {
  const planned = CALS['A&H Life'] + 'b1.ics';
  objects.set(planned, vevent('b1', '20261116T144500Z', '20261116T150000Z', 'Maya · Breakfast'));
  const s = new MealStore(env);
  let calls = 0;
  globalThis.fetch = (url, init = {}) => ((init.method === 'DELETE' && url === planned && !calls++) ? Promise.resolve(new Response('', { status: 503 })) : fakeFetch(url, init));
  await assert.rejects(s.log({ id: 'maya_meal-2026-11-16-breakfast', person: 'ambuja', at: '2026-11-16T06:57:00-08:00' }));
  assert.equal(objects.has(planned), true);
  const r = await s.log({ id: 'maya_meal-2026-11-16-breakfast', ate: 'some' });
  assert.equal(r.removedFrom, 'A&H Life');
  assert.equal(objects.has(planned), false);
  assert.match(unfold(objects.get(CALS['Life Log'] + 'maya_meal-2026-11-16-breakfast.ics')), /planned 6:45 AM/);
});

test('a plan keeps a long description whole, and skips a meal with a bad time', async () => {
  const long = 'x'.repeat(700), href = CALS['Harsh’s Calendar'] + 'hb-maya-meal-2026-11-16-lunch.ics';
  objects.set(href, vevent('hb-maya-meal-2026-11-16-lunch', '20261116T203000Z', '20261116T204500Z', 'Maya lunch 1 cup', long));
  const r = await new MealStore(env).putPlan('2026-11-16', { meals: [{ kind: 'breakfast', start: 'soon' }, { kind: 'lunch', start: '13:15' }] });
  assert.deepEqual(r.skipped.map((x) => x.kind), ['breakfast']);
  assert.deepEqual(r.changed.map((x) => x.kind), ['lunch']);
  assert.ok(unfold(objects.get(href)).includes(long));
});

test('a plan removes the day\'s other copies of a meal: other UIDs deleted, a series loses the day, Life Log kept', async () => {
  objects.set(CALS['A&H Life'] + 'ser.ics', SERIES.replace('Maya dinner 3/4 cup', 'Maya dinner'));
  env.TZ = 'America/New_York';
  env.WALK_PLAN_CALENDARS = JSON.stringify({ harsh: 'Harsh’s Calendar', ambuja: 'Ambuja’s Calendar', 'ambuja+harsh': 'A&H Life', dog: 'Life Log' });
  const harsh = CALS['Harsh’s Calendar'] + 'hb-maya-meal-2026-11-16-dinner.ics', ambuja = CALS['Ambuja’s Calendar'] + 'maya-meal-plan-2026-11-16-dinner.ics';
  const logged = CALS['Life Log'] + 'maya_meal-2026-11-16-dinner.ics';
  objects.set(harsh, vevent('hb-maya-meal-2026-11-16-dinner', '20261117T013000Z', '20261117T014500Z', 'Maya dinner 3/4 cup'));
  objects.set(ambuja, vevent('maya-meal-plan-2026-11-16-dinner@frame-data', '20261117T013000Z', '20261117T014500Z', 'Maya dinner 3/4 cup').replace('DTSTAMP:', 'LAST-MODIFIED:20261116T000000Z\r\nDTSTAMP:'));
  objects.set(logged, vevent('maya_meal-2026-11-16-dinner@frame-data', '20261117T000000Z', '20261117T001500Z', 'Maya dinner 🍽️ 3/4 cup — Harsh'));
  const s = new MealStore(env);
  assert.equal((await s.get('2026-11-16')).duplicates.length, 3);
  const r = await s.putPlan('2026-11-16', { meals: [{ kind: 'dinner', start: '20:30' }] });
  assert.deepEqual(r.unchanged, ['dinner']);
  assert.deepEqual(r.removed.map((x) => x.calendar).sort(), ['A&H Life', 'Harsh’s Calendar']);
  assert.equal(objects.has(harsh), false);
  assert.equal(objects.has(ambuja), true);
  assert.equal(objects.has(logged), true);
  const days = expandICS(objects.get(CALS['A&H Life'] + 'ser.ics'), { name: 'x' }, new Date('2026-11-15T12:00:00Z'), new Date('2026-11-18T12:00:00Z')).map((e) => e.start);
  assert.deepEqual(days, ['2026-11-15T23:30:00.000Z', '2026-11-17T23:30:00.000Z']);
  const g = await s.get('2026-11-16');
  assert.deepEqual([g.meals.filter((x) => x.kind === 'dinner').map((x) => x.calendar), g.duplicates.length], [['Ambuja’s Calendar'], 1]);
});
