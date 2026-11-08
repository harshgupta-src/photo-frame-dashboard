import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, summarize, walkICS, renderLog, eventTitle, walkersOf, WalkError } from '../src/walks.js';

const now = Date.parse('2026-11-08T16:00:00Z'); // 11:00 in New York
const TZ = 'America/New_York';
const walk = (id, start, min, extra = {}) => ({
  id, startedAt: Date.parse(start), endedAt: min == null ? null : Date.parse(start) + min * 60e3,
  pee: true, poop: false, walkers: [{ id: 'harsh', name: 'Harsh' }], notes: null, dog: 'Rex', source: 'frame', ...extra,
});

test('rejects a frame clock that has not synced (1970) and walks over 6 hours', () => {
  assert.throws(() => normalize({ startedAt: 1000 }, now), WalkError);
  assert.throws(() => normalize({ startedAt: now - 7 * 3600e3, endedAt: now }, now), /6 hours/);
  assert.throws(() => normalize({ startedAt: now, endedAt: now - 1 }, now), /before/);
  assert.throws(() => normalize({ startedAt: now + 3600e3 }, now), /future/);
});

test('shifts times by the client clock error when it reports one', () => {
  const clientNow = now - 3600e3; // frame clock an hour slow
  const f = normalize({ startedAt: clientNow - 30 * 60e3, endedAt: clientNow, clientNow }, now);
  assert.equal(f.startedAt, now - 30 * 60e3);
  assert.equal(f.endedAt, now);
  const g = normalize({ startedAt: now - 60e3, clientNow: now - 30e3 }, now); // small skew is left alone
  assert.equal(g.startedAt, now - 60e3);
});

test('walkers from ids, names or a phrase; booleans from Shortcut answers', () => {
  assert.deepEqual(walkersOf('Harsh and Ambuja'), [{ id: 'harsh', name: 'Harsh' }, { id: 'ambuja', name: 'Ambuja' }]);
  assert.deepEqual(walkersOf([{ id: 'harsh', name: 'Harsh' }, 'harsh']), [{ id: 'harsh', name: 'Harsh' }]);
  const f = normalize({ startedAt: now - 60e3, pee: 'Yes', poop: 'No' }, now);
  assert.equal(f.pee, true);
  assert.equal(f.poop, false);
  assert.equal(normalize({ startedAt: now - 60e3 }, now).pee, null);
});

test('summary: today in the home time zone, last pee and poop', () => {
  const walks = [
    walk('active1', '2026-11-08T15:50:00Z', null),
    walk('w3', '2026-11-08T12:00:00Z', 30, { poop: true }),
    walk('w2', '2026-11-08T04:30:00Z', 20), // 11:30pm on the 7th in New York
    walk('w1', '2026-11-07T12:00:00Z', 40, { pee: false }),
  ];
  const s = summarize(walks, now, TZ);
  assert.equal(s.active.id, 'active1');
  assert.equal(s.active.minutesSoFar, 10);
  assert.equal(s.last.id, 'w3');
  assert.equal(s.today.date, '2026-11-08');
  assert.deepEqual([s.today.walks, s.today.minutes, s.today.poops], [1, 30, 1]);
  assert.equal(s.lastPoop, '2026-11-08T12:30:00.000Z');
  assert.equal(s.last7Days.walks, 3);
  assert.equal(s.last7Days.avgMinutes, 30);
});

test('calendar event: UTC times, escaped text, folded lines', () => {
  const w = walk('abc123', '2026-11-08T15:00:00Z', 32, { poop: true, notes: 'Met a dog, pulled; ok', walkers: [{ id: 'a', name: 'Harsh' }, { id: 'b', name: 'Ambuja' }] });
  const ics = walkICS(w, now);
  assert.match(ics, /UID:dog-walk-abc123@frame-data\r\n/);
  assert.match(ics, /DTSTART:20261108T150000Z\r\nDTEND:20261108T153200Z/);
  assert.match(ics, /Met a dog\\, pulled\\; ok/);
  assert.equal(eventTitle(w), 'Rex walk — Harsh & Ambuja · 💧💩');
  assert.equal(eventTitle({ ...w, pee: false, poop: false, walkers: [] }), 'Rex walk · no potty');
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test('markdown log is stable for the same data and day', () => {
  const walks = [walk('w2', '2026-11-08T12:00:00Z', 30, { poop: true }), walk('w1', '2026-10-01T12:00:00Z', 40)];
  const a = renderLog(walks, now, TZ, 'Rex'), b = renderLog(walks, now + 3600e3, TZ, 'Rex');
  assert.equal(a, b);
  assert.match(a, /^---\ntype: log\ngenerated: true/);
  assert.match(a, /### Sun 2026-11-08 · 1 walk, 30 min/);
  assert.match(a, /\| 7:00am \| 7:30am \| 30 \| ✓ \| ✓ \| Harsh \|/);
  assert.match(a, /\| 2026-10 \| 1 \| 1 \| 1 \| 40 \| 0 \|/);
  assert.doesNotMatch(a, /2026-10-01 ·/); // older than 30 days: only in the monthly table
});
