import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentICS, parseTime, canWrite, agentCalRoute } from '../src/agentcal.js';
import { expandICS } from '../src/ics.js';

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
  assert.match(agentICS('hb-x', { title: 'Snack', start: '2026-11-12T21:00' }, 0), /DTEND:20261113T023000Z/);
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

// Fake iCloud: principal → home → three calendars; records PUT/DELETE.
function fakeICloud() {
  const calls = [];
  const ms = (inner) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, { status: 207 });
  const cal = (path, name) => `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), m = init.method || 'GET';
    if (m === 'PUT' || m === 'DELETE') { calls.push(m + ' ' + u); return new Response(null, { status: m === 'PUT' ? 201 : 404 }); }
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

test('route: unauthorized, foreign uid and read-only calendar are refused', async () => {
  fakeICloud();
  assert.equal((await agentCalRoute(...req('GET', '/agent/calendars'), env, ctx, false)).status, 401);
  assert.equal((await agentCalRoute(...req('DELETE', '/agent/events/ABC-123'), env, ctx, true)).status, 403);
  const r = await agentCalRoute(...req('PUT', '/agent/events/hb-x', { calendar: 'jordan', title: 't', start: '2026-11-12T12:00' }), env, ctx, true);
  assert.equal(r.status, 403);
  assert.equal((await agentCalRoute(...req('GET', '/walks'), env, ctx, true)), null);
});

test('route: upsert writes <calendar>/<uid>.ics and clears the same uid from the other writable calendar', async () => {
  const calls = fakeICloud();
  const r = await agentCalRoute(...req('PUT', '/agent/events/hb-dog-meal-2026-11-12-lunch', { calendar: 'family', title: 'Rex · Lunch', start: '2026-11-12T12:30' }), env, ctx, true);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [
    'PUT https://caldav.icloud.com/1/calendars/l/hb-dog-meal-2026-11-12-lunch.ics',
    'DELETE https://caldav.icloud.com/1/calendars/h/hb-dog-meal-2026-11-12-lunch.ics',
  ]);
  const list = await agentCalRoute(...req('GET', '/agent/calendars'), env, ctx, true);
  assert.deepEqual(list.body.map((c) => [c.alias, c.write, c.found]), [['alex', true, true], ['family', true, true], ['jordan', false, true]]);
});
