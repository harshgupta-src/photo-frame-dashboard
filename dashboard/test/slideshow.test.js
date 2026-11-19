import { test } from 'node:test';
import assert from 'node:assert/strict';

// slideshow.js attaches to window.App; give it just enough of the app to load.
let NOW = new Date(2026, 10, 19, 14, 0);
globalThis.window = { DATA: { photos: [] } };
globalThis.App = {
  now: () => NOW,
  fmt: { month: (d) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] },
  person: (id) => id,
  esc: (s) => String(s),
};
await import('../js/slideshow.js');
const { photoMemory, photoMeta, photoQueue, photoWhere } = globalThis.App;

function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
const mem = (date, now) => photoMemory({ date }, now);

test('on this day and this week match earlier years only, across the year end and Feb 29', () => {
  const nov19 = new Date(2026, 10, 19);
  assert.deepEqual(mem('2024-11-19', nov19), { years: 2, onThisDay: true, thisWeek: true });
  assert.deepEqual(mem('2025-11-22', nov19), { years: 1, onThisDay: false, thisWeek: true });
  assert.deepEqual(mem('2025-11-16', nov19), { years: 1, onThisDay: false, thisWeek: true });
  assert.equal(mem('2025-11-23', nov19).thisWeek, false);
  assert.equal(mem('2026-11-19', nov19).thisWeek, false); // today is not a memory
  assert.equal(mem('2026-11-17', nov19).thisWeek, false);
  // Dec 30 is three days before Jan 2, but only a memory if it was a year or more ago.
  assert.deepEqual(mem('2024-12-30', new Date(2026, 0, 2)), { years: 1, onThisDay: false, thisWeek: true });
  assert.equal(mem('2025-12-30', new Date(2026, 0, 2)).thisWeek, false);
  assert.deepEqual(mem('2023-01-02', new Date(2026, 11, 31)), { years: 4, onThisDay: false, thisWeek: true });
  // Feb 29 has its anniversary on Feb 28 in other years, and on Feb 29 in leap years.
  assert.equal(mem('2024-02-29', new Date(2025, 1, 28)).onThisDay, true);
  assert.equal(mem('2024-02-29', new Date(2025, 2, 1)).onThisDay, false);
  assert.equal(mem('2024-02-29', new Date(2028, 1, 29)).onThisDay, true);
  assert.equal(mem('2024-02-29', new Date(2028, 1, 28)).onThisDay, false);
});

test('kickers say how long ago', () => {
  NOW = new Date(2026, 10, 19, 14, 0);
  assert.equal(photoMeta({ date: '2024-11-19' }).kicker, '2 years ago today');
  assert.equal(photoMeta({ date: '2025-11-21' }).kicker, '1 year ago this week');
  assert.equal(photoMeta({ date: '2025-06-01' }).kicker, '1 year ago');
  assert.equal(photoMeta({ date: '2026-03-01' }).kicker, 'This year');
  assert.equal(photoWhere({ place: 'Lisbon, Portugal', caption: 'Tram 28' }), 'Lisbon, Portugal · Tram 28');
  assert.equal(photoWhere({ place: '', caption: 'x'.repeat(80) }), '');
});

test('a cycle features memories more, spreads their copies out, and opens with on-this-day', () => {
  const now = new Date(2026, 10, 19);
  const pool = [];
  for (let i = 0; i < 20; i++) pool.push({ id: 'p' + i, date: '2026-0' + (1 + (i % 9)) + '-10' });
  const today = { id: 'today', date: '2023-11-19' }, week = { id: 'week', date: '2025-11-17' }, fav = { id: 'fav', date: '2026-02-02', fav: true };
  pool.push(today, week, fav);
  for (let seed = 1; seed <= 200; seed++) {
    const q = photoQueue(pool, now, seeded(seed));
    const n = (p) => q.filter((x) => x === p).length;
    assert.equal(q[0], today);
    assert.equal(n(today), 4); assert.equal(n(week), 2); assert.equal(n(fav), 2); assert.equal(n(pool[0]), 1);
    assert.equal(q.length, 20 + 4 + 2 + 2);
    for (const p of [today, week, fav]) {
      const at = q.map((x, i) => (x === p ? i : -1)).filter((i) => i >= 0);
      for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 3, `${p.id} copies ${at} (seed ${seed})`);
    }
  }
});

test('small albums still avoid showing the same photo twice in a row', () => {
  const now = new Date(2026, 10, 19);
  const pool = [{ id: 'a', date: '2024-11-19' }, { id: 'b', date: '2026-01-01', fav: true }, { id: 'c', date: '2026-02-01' }, { id: 'd', date: '2026-03-01' }];
  for (let seed = 1; seed <= 200; seed++) {
    const q = photoQueue(pool, now, seeded(seed));
    assert.equal(q.length, 8);
    for (let i = 1; i < q.length; i++) assert.notEqual(q[i], q[i - 1], `seed ${seed}: ${q.map((p) => p.id)}`);
  }
});
