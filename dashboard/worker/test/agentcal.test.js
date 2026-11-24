import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentICS, parseTime, canWrite, agentCalRoute } from '../src/agentcal.js';
import { expandICS, icsTime, localISO, VTIMEZONE } from '../src/ics.js';

test('wall-clock times are read in New York time across DST', () => {
  assert.equal(new Date(parseTime('2026-11-12T12:30')).toISOString(), '2026-11-12T17:30:00.000Z');
  assert.equal(new Date(parseTime('2026-07-01T06:45')).toISOString(), '2026-07-01T10:45:00.000Z');
  assert.equal(new Date(parseTime('2026-11-12T12:30:00-05:00')).toISOString(), '2026-11-12T17:30:00.000Z');
  assert.throws(() => parseTime('tomorrow'), /bad time/);
});

test('agentICS round-trips through the frame parser with alarms and escaping', () => {
  const ics = agentICS('hb-dog-meal-2026-11-12-lunch', {
    title: 'Rex · Lunch', start: '2026-11-12T12:30', end: '2026-11-12T12:45',
    description: 'cups: 0.75\nkibble_pct: 75, probiotic: 0.5', alarms: [0, 10],
  }, Date.UTC(2026, 10, 10), { person: 'Alex', agent: 'Agent' });
  assert.match(ics, /TRIGGER:PT0S/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.match(ics, /X-HOMEBRAIN-PERSON:Alex/);
  const [ev] = expandICS(ics, { name: 'Alex' }, new Date('2026-11-12T00:00:00Z'), new Date('2026-11-13T00:00:00Z'));
  assert.equal(ev.id, 'hb-dog-meal-2026-11-12-lunch');
  assert.equal(ev.start, '2026-11-12T17:30:00.000Z');
  assert.equal(ev.end, '2026-11-12T17:45:00.000Z');
  assert.equal(ev.notes, 'cups: 0.75\nkibble_pct: 75, probiotic: 0.5');
});

test('agentICS: all-day, default 30-minute end, and validation', () => {
  assert.match(agentICS('hb-x', { title: 'Vet', allDay: true, start: '2026-11-20' }, 0), /DTEND;VALUE=DATE:20261121/);
  assert.match(agentICS('hb-x', { title: 'Snack', start: '2026-11-12T21:00' }, 0), /DTEND;TZID=America\/New_York:20261112T213000/);
  assert.throws(() => agentICS('abc', { title: 't', start: '2026-11-12T21:00' }, 0), /uid/);
  assert.throws(() => agentICS('hb-x', { start: '2026-11-12T21:00' }, 0), /title/);
  assert.throws(() => agentICS('hb-x', { title: 't', start: '2026-11-12T21:00', end: '2026-11-12T20:00' }, 0), /after start/);
});

test('canWrite: true, false or a person list', () => {
  assert.equal(canWrite({ write: true }, ''), true);
  assert.equal(canWrite({ write: false }, 'Alex'), false);
  assert.equal(canWrite({ write: ['jordan'] }, 'Jordan'), true);
  assert.equal(canWrite({ write: ['jordan'] }, 'Alex'), false);
});

// Fake iCloud: principal → home → three calendars; records PUT/DELETE. `objects` (href → ics) are
// served by REPORT (a UID search or a time range) and removed by DELETE.
// `noUidFilter` answers UID searches with 412, as iCloud does.
function fakeICloud(objects, { noUidFilter = false } = {}) {
  const calls = [], tracked = !!objects;
  objects = objects || new Map();
  const ms = (inner) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, { status: 207 });
  const cal = (path, name) => `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), m = init.method || 'GET';
    if (m === 'PUT' || m === 'DELETE') {
      calls.push(m + ' ' + u);
      if (m === 'PUT') { objects.set(u, init.body); return new Response(null, { status: 201 }); }
      if (tracked) return new Response(null, { status: objects.delete(u) ? 204 : 404 });
      return new Response(null, { status: u.includes('/h/') ? 204 : 404 });
    }
    if (m === 'REPORT') {
      if (noUidFilter && init.body.includes('name="UID"')) return new Response('', { status: 412 });
      const want = /<c:text-match[^>]*>([^<]*)</.exec(init.body);
      const rows = [...objects].filter(([h, ics]) => h.startsWith(u) && (!want || ics.includes('UID:' + want[1])));
      return ms(rows.map(([h, ics]) => `<d:response><d:href>${new URL(h).pathname}</d:href><d:propstat><d:prop><c:calendar-data>${ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join(''));
    }
    if (u === 'https://caldav.icloud.com/') return ms('<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/1/principal/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    if (u.endsWith('/principal/')) return ms('<d:response><d:href>/1/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/1/calendars/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    return ms(cal('/1/calendars/h/', 'Alex’s Calendar') + cal('/1/calendars/a/', 'Jordan’s Calendar') + cal('/1/calendars/l/', 'Family'));
  };
  return calls;
}

const env = {
  ICLOUD_APPLE_ID: 'x', ICLOUD_APP_PASSWORD: 'y', DATA: { delete: async () => {} },
  AGENT_CALENDARS: JSON.stringify({ alex: { name: "Alex's Calendar", write: true }, family: { name: 'Family', write: true }, jordan: { name: "Jordan's Calendar", write: false } }),
};
const ctx = { waitUntil() {} };
const req = (method, path, body, person = 'Alex') => [
  new Request('https://w.example' + path, { method, body: body && JSON.stringify(body), headers: { 'X-Agent-Person': person } }),
  new URL('https://w.example' + path),
];

test('route: unauthorized, foreign uid writes and read-only calendar are refused', async () => {
  fakeICloud();
  assert.equal((await agentCalRoute(...req('GET', '/agent/calendars'), env, ctx, false)).status, 401);
  assert.equal((await agentCalRoute(...req('PUT', '/agent/events/ABC-123', { calendar: 'alex', title: 't', start: '2026-11-12T12:00' }), env, ctx, true)).status, 403);
  const r = await agentCalRoute(...req('PUT', '/agent/events/hb-x', { calendar: 'jordan', title: 't', start: '2026-11-12T12:00' }), env, ctx, true);
  assert.equal(r.status, 403);
  assert.equal((await agentCalRoute(...req('GET', '/walks'), env, ctx, true)), null);
  const nul = new Request('https://w.example/agent/events/hb-x', { method: 'PUT', body: 'null' });
  assert.equal((await agentCalRoute(nul, new URL(nul.url), env, ctx, true)).status, 400);
});

test('route: upsert writes <calendar>/<uid>.ics and clears the same uid from the other writable calendar', async () => {
  const calls = fakeICloud();
  const r = await agentCalRoute(...req('PUT', '/agent/events/hb-dog-meal-2026-11-12-lunch', { calendar: 'family', title: 'Rex · Lunch', start: '2026-11-12T12:30' }), env, ctx, true);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [
    'PUT https://caldav.icloud.com/1/calendars/l/hb-dog-meal-2026-11-12-lunch.ics',
    'DELETE https://caldav.icloud.com/1/calendars/h/hb-dog-meal-2026-11-12-lunch.ics',
  ]);
  assert.deepEqual(r.body.movedFrom, ['alex']);
  assert.equal((await agentCalRoute(...req('DELETE', '/agent/events/hb-gone?calendar=family'), env, ctx, true)).status, 404);
  const list = await agentCalRoute(...req('GET', '/agent/calendars'), env, ctx, true);
  assert.deepEqual(list.body.map((c) => [c.alias, c.write, c.found]), [['alex', true, true], ['family', true, true], ['jordan', false, true]]);
});

const C = 'https://caldav.icloud.com/1/calendars/';
const phoneEvent = (uid, title, start, end) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18//EN',
  ...VTIMEZONE, 'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:20261101T000000Z', 'SUMMARY:' + title,
  'DTSTART;TZID=America/New_York:' + start, 'DTEND;TZID=America/New_York:' + end, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

test('route: delete removes any event by exact uid from where the server keeps it', async () => {
  const objects = new Map([
    [C + 'h/0F3A-phone-file.ics', phoneEvent('5D1C2B9E-AAAA-4C1E-9F00-123456789ABC', 'Dentist', '20261112T090000', '20261112T100000')],
    [C + 'h/other.ics', phoneEvent('5D1C2B9E-AAAA-4C1E-9F00-123456789ABC-2', 'Not this one', '20261112T110000', '20261112T120000')],
    [C + 'a/jordan.ics', phoneEvent('JORDAN-1', 'Jordan only', '20261112T090000', '20261112T100000')],
  ]);
  const calls = fakeICloud(objects);
  const r = await agentCalRoute(...req('DELETE', '/agent/events/' + encodeURIComponent('5D1C2B9E-AAAA-4C1E-9F00-123456789ABC')), env, ctx, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deletedFrom, ['alex']);
  assert.deepEqual(r.body.deleted, [{ calendar: 'alex', title: 'Dentist', start: '2026-11-12T09:00:00-05:00', recurring: false }]);
  assert.equal(calls[0], 'DELETE ' + C + 'h/0F3A-phone-file.ics');
  assert.ok(objects.has(C + 'h/other.ics'), 'a uid that only starts the same is kept');

  // Unknown uid: a clean 404 (after trying <uid>.ics on each writable calendar).
  const gone = await agentCalRoute(...req('DELETE', '/agent/events/NOPE'), env, ctx, true);
  assert.equal(gone.status, 404);
  assert.match(gone.body.error, /no event with uid "NOPE"/);
  // An occurrence id points at its series.
  assert.match((await agentCalRoute(...req('DELETE', '/agent/events/' + encodeURIComponent('yoga@2026-11-12T18:30:00')), env, ctx, true)).body.error, /uid "yoga" deletes the whole series/);

  // Someone else's calendar stays off limits: named → 403, unnamed → not found on writable ones.
  assert.equal((await agentCalRoute(...req('DELETE', '/agent/events/JORDAN-1?calendar=jordan'), env, ctx, true)).status, 403);
  assert.equal((await agentCalRoute(...req('DELETE', '/agent/events/JORDAN-1'), env, ctx, true)).status, 404);
  assert.ok(objects.has(C + 'a/jordan.ics'));
});

test('route: delete finds a phone event when iCloud refuses UID searches (412)', async () => {
  const objects = new Map([
    [C + 'h/0F3A-phone-file.ics', phoneEvent('Test-Phone-UID-1234@example', 'Dentist', '20261112T090000', '20261112T100000')],
    [C + 'h/other.ics', phoneEvent('Test-Phone-UID-1234@example-2', 'Not this one', '20261112T110000', '20261112T120000')],
  ]);
  const calls = fakeICloud(objects, { noUidFilter: true });
  const r = await agentCalRoute(...req('DELETE', '/agent/events/' + encodeURIComponent('Test-Phone-UID-1234@example') + '?calendar=alex'), env, ctx, true);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['DELETE ' + C + 'h/0F3A-phone-file.ics']);
  assert.ok(objects.has(C + 'h/other.ics'));
});

test('route: /agent/events lists local times with offsets, in time order', async () => {
  const objects = new Map([
    [C + 'h/b.ics', phoneEvent('B', 'Summer time', '20261030T064500', '20261030T071500')],
    [C + 'h/a.ics', agentICS('hb-winter', { title: 'Winter', start: '2026-11-12T12:30', end: '2026-11-12T13:00' }, 0)],
  ]);
  fakeICloud(objects);
  const r = await agentCalRoute(...req('GET', '/agent/events?calendar=alex&from=2026-10-01&to=2026-11-20'), env, ctx, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.from, '2026-10-01T00:00:00-04:00');
  assert.equal(r.body.to, '2026-11-20T00:00:00-05:00');
  assert.deepEqual(r.body.events.map((e) => [e.uid, e.start, e.end]), [
    ['B', '2026-10-30T06:45:00-04:00', '2026-10-30T07:15:00-04:00'],
    ['hb-winter', '2026-11-12T12:30:00-05:00', '2026-11-12T13:00:00-05:00'],
  ]);
});

test('agentICS writes New York wall time (EST, EDT and across the DST change) that reads back exactly', () => {
  const read = (ics, from, to) => expandICS(ics, { name: 'Alex' }, new Date(from), new Date(to))[0];
  const winter = agentICS('hb-w', { title: 'W', start: '2026-11-12T12:30', end: '2026-11-12T13:00' }, 0);
  assert.match(winter, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York\r\n/);
  assert.match(winter, /DTSTART;TZID=America\/New_York:20261112T123000\r\nDTEND;TZID=America\/New_York:20261112T130000/);
  assert.equal(read(winter, '2026-11-12T00:00Z', '2026-11-13T00:00Z').start, '2026-11-12T17:30:00.000Z');

  const summer = agentICS('hb-s', { title: 'S', start: '2026-07-01T06:45:00-04:00', end: '2026-07-01T11:45:00Z' }, 0);
  assert.match(summer, /DTSTART;TZID=America\/New_York:20260701T064500\r\nDTEND;TZID=America\/New_York:20260701T074500/);
  const s = read(summer, '2026-07-01T00:00Z', '2026-07-02T00:00Z');
  assert.deepEqual([s.start, s.end], ['2026-07-01T10:45:00.000Z', '2026-07-01T11:45:00.000Z']);

  // 00:30 EDT → 03:00 EST on the night clocks go back: 3.5 hours.
  const cross = agentICS('hb-c', { title: 'C', start: '2026-11-01T00:30', end: '2026-11-01T03:00' }, 0);
  assert.match(cross, /DTSTART;TZID=America\/New_York:20261101T003000\r\nDTEND;TZID=America\/New_York:20261101T030000/);
  const c = read(cross, '2026-10-31T00:00Z', '2026-11-02T00:00Z');
  assert.deepEqual([c.start, c.end], ['2026-11-01T04:30:00.000Z', '2026-11-01T08:00:00.000Z']);
  // Spring forward: 01:30 EST → 03:30 EDT is one hour.
  const spring = read(agentICS('hb-sp', { title: 'Sp', start: '2026-03-08T01:30', end: '2026-03-08T03:30' }, 0), '2026-03-07T00:00Z', '2026-03-09T00:00Z');
  assert.deepEqual([spring.start, spring.end], ['2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z']);
});

test('icsTime keeps the repeated hour unambiguous; localISO and TZID without a VTIMEZONE', () => {
  // 1:30 happens twice on Nov 1 (EDT, then EST): both stay UTC; the hours around it are local.
  assert.equal(icsTime('DTSTART', Date.parse('2026-11-01T05:30:00Z')), 'DTSTART:20261101T053000Z');
  assert.equal(icsTime('DTSTART', Date.parse('2026-11-01T06:30:00Z')), 'DTSTART:20261101T063000Z');
  assert.equal(icsTime('DTSTART', Date.parse('2026-11-01T04:59:00Z')), 'DTSTART;TZID=America/New_York:20261101T005900');
  assert.equal(icsTime('DTSTART', Date.parse('2026-11-01T07:00:00Z')), 'DTSTART;TZID=America/New_York:20261101T020000');
  const first = agentICS('hb-r', { title: 'R', start: '2026-11-01T05:30:00Z', end: '2026-11-01T06:30:00Z' }, 0);
  assert.match(first, /DTSTART:20261101T053000Z\r\nDTEND:20261101T063000Z/);
  const r = expandICS(first, { name: 'A' }, new Date('2026-11-01T00:00Z'), new Date('2026-11-02T00:00Z'))[0];
  assert.deepEqual([r.start, r.end], ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.equal(localISO(Date.parse('2026-11-01T05:30:00Z')), '2026-11-01T01:30:00-04:00');
  assert.equal(localISO(Date.parse('2026-11-01T06:30:00Z')), '2026-11-01T01:30:00-05:00');
  const bare = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:x\r\nDTSTART;TZID=America/New_York:20260701T090000\r\nDTEND;TZID=America/New_York:20260701T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  assert.equal(expandICS(bare, { name: 'A' }, new Date('2026-07-01T00:00Z'), new Date('2026-07-02T00:00Z'))[0].start, '2026-07-01T13:00:00.000Z');
});

test('an unknown timezone is a 400, not a 502', () => {
  assert.throws(() => parseTime('2026-11-12T12:30', 'Mars/Olympus'), (e) => e.status === 400 && /bad timezone/.test(e.message));
  assert.equal(new Date(parseTime('2026-11-12T12:30', 'America/Los_Angeles')).toISOString(), '2026-11-12T20:30:00.000Z');
});
