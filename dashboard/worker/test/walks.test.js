import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, summarize, walkICS, renderLog, eventTitle, walkersOf, WalkError } from '../src/walks.js';
import { expandICS } from '../src/ics.js';

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
  assert.deepEqual(walkersOf('Harsh and ambuja'), [{ id: 'harsh', name: 'Harsh', named: false }, { id: 'ambuja', name: 'Ambuja', named: false }]);
  assert.deepEqual(walkersOf([{ id: 'harsh', name: 'Harsh G' }, 'harsh']), [{ id: 'harsh', name: 'Harsh G', named: true }]);
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

test('calendar event: New York times, escaped text, folded lines', () => {
  const w = walk('abc123', '2026-11-08T15:00:00Z', 32, { poop: true, notes: 'Met a dog, pulled; ok', walkers: [{ id: 'a', name: 'Harsh' }, { id: 'b', name: 'Ambuja' }] });
  const ics = walkICS(w, now);
  assert.match(ics, /UID:dog-walk-abc123@frame-data\r\n/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261108T100000\r\nDTEND;TZID=America\/New_York:20261108T103200/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
  const [ev] = expandICS(ics, { name: 'Life Log' }, new Date('2026-11-08T00:00:00Z'), new Date('2026-11-09T00:00:00Z'));
  assert.deepEqual([ev.start, ev.end], ['2026-11-08T15:00:00.000Z', '2026-11-08T15:32:00.000Z']);
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

test('plan: local times in the home zone; walks match by planId, else the nearest within 90 min', async () => {
  const { normalizePlan, matchPlan } = await import('../src/walkplan.js');
  const p = normalizePlan({ walks: [{ start: '16:00', durationMin: 40, walkers: 'harsh & ambuja' }, { start: '07:30', end: '08:00', walkers: ['harsh'] }] },
    '2026-11-09', 'America/New_York', { harsh: 'Harsh G' }, Date.parse('2026-11-09T09:30:00Z'));
  assert.deepEqual(p.items.map((x) => [new Date(x.start).toISOString(), x.walkers.map((w) => w.name).join('+')]),
    [['2026-11-09T12:30:00.000Z', 'Harsh G'], ['2026-11-09T21:00:00.000Z', 'Harsh G+Ambuja']]);
  assert.throws(() => normalizePlan({ walks: [{ start: '23:50', walkers: 'harsh', durationMin: 2 }] }, '2026-11-09', 'UTC'), /5 to 180/);
  const [am, pm] = p.items;
  const m = matchPlan(p.items, [
    { id: 'a', startedAt: am.start + 80 * 60e3, endedAt: am.start + 100 * 60e3 },
    { id: 'b', startedAt: am.start, endedAt: am.end, planId: pm.id },
  ]);
  assert.deepEqual([m.get(am.id).id, m.get(pm.id).id], ['a', 'b']);
  assert.equal(matchPlan(p.items, [{ id: 'c', startedAt: am.start + 91 * 60e3 }]).size, 0);
});

test('plan: a walk planned after another walk ended is not matched to it', async () => {
  const { matchPlan } = await import('../src/walkplan.js');
  const t = Date.parse('2026-11-09T15:00:00Z');
  const walk = { id: 'w', startedAt: t, endedAt: t + 30 * 60e3 };
  const replanned = { id: 'p', start: t + 80 * 60e3, end: t + 110 * 60e3, created: t + 31 * 60e3 };
  assert.equal(matchPlan([replanned], [walk]).size, 0);
  assert.equal(matchPlan([{ ...replanned, created: t - 3600e3 }], [walk]).get('p'), walk);
});

test('walk-sheet defaults: walkers from the planned walk (alone, together, Ambuja only), else who started it', async () => {
  const { suggestWalk } = await import('../src/walkexpect.js');
  const t = Date.parse('2026-11-19T16:15:00Z'), mod = (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();
  const plans = [{ walks: [
    { id: 'p1', start: '2026-11-19T11:15:00Z', walkerIds: ['ambuja'] },
    { id: 'p2', start: '2026-11-19T16:15:00Z', walkerIds: ['harsh'] },
    { id: 'p3', start: '2026-11-19T21:10:00Z', walkerIds: ['harsh', 'ambuja'] },
  ] }];
  const ids = (rec) => suggestWalk(rec, plans, [], mod, (id) => id !== 'guest', t + 3600e3).walkerIds;
  const started = [{ id: 'ambuja', name: 'Ambuja' }];
  assert.deepEqual(ids({ startedAt: t + 5 * 60e3, endedAt: t + 30 * 60e3, walkers: started }), ['harsh'], 'nearest plan: Harsh alone');
  assert.deepEqual(ids({ startedAt: t, planId: 'p3', walkers: started }), ['harsh', 'ambuja'], 'named plan: together');
  assert.deepEqual(ids({ startedAt: Date.parse('2026-11-19T11:30:00Z'), walkers: [] }), ['ambuja'], 'Ambuja only');
  assert.deepEqual(ids({ startedAt: t, walkers: started, picked: true }), ['ambuja'], 'picked on the tile wins');
  assert.deepEqual(ids({ startedAt: Date.parse('2026-11-19T02:00:00Z'), walkers: started }), ['ambuja'], 'no plan near: who started it');
  // As on the Worker (matchPlan): a walk taken early still counts for its planned walk, but one planned
  // (created) after the walk ended isn't this walk's.
  const early = { startedAt: t - 60 * 60e3, endedAt: t - 40 * 60e3 };
  assert.equal(suggestWalk(early, plans, [], mod).plan.id, 'p2');
  const replanned = [{ walks: [{ id: 'p2', start: '2026-11-19T16:15:00Z', created: new Date(t - 30 * 60e3).toISOString(), walkerIds: ['harsh'] }] }];
  assert.equal(suggestWalk(early, replanned, [], mod).plan, null);
});

test('plan: the frame and the Worker agree on which planned walk a walk is for', async () => {
  const { normalizePlan, matchPlan, planJSON } = await import('../src/walkplan.js');
  const { planFor } = await import('../src/walkexpect.js');
  const made = Date.parse('2026-11-19T15:30:00Z'), at = (hm) => Date.parse('2026-11-19T' + hm + ':00Z');
  const p = normalizePlan({ walks: [{ start: '16:15', walkers: ['harsh'] }] }, '2026-11-19', 'UTC', {}, made);
  const json = planJSON(p, new Map(), made, [], 'UTC');
  for (const [w, want] of [
    [{ id: 'early', startedAt: at('15:40'), endedAt: at('16:00') }, p.items[0].id],
    [{ id: 'before', startedAt: at('15:00'), endedAt: at('15:20') }, null],
  ]) {
    assert.equal(matchPlan(p.items, [w]).has(p.items[0].id) ? p.items[0].id : null, want, 'Worker ' + w.id);
    assert.equal(planFor(w, [json], at('18:00'))?.id ?? null, want, 'frame ' + w.id);
  }
});

test('plan: a new walk at the same minute as a kept one gets its own id instead of failing the PUT', async () => {
  const { normalizePlan } = await import('../src/walkplan.js');
  const date = '2026-11-19', kept = date + '-1600';
  const p = normalizePlan({ walks: [{ id: kept, start: '16:30', walkers: ['harsh'] }, { start: '16:00', walkers: ['ambuja'] }] }, date, 'UTC');
  assert.deepEqual(p.items.map((x) => x.id), [kept + '-2', kept]);
  assert.throws(() => normalizePlan({ walks: [{ start: '16:00', walkers: ['harsh'] }, { start: '16:00', walkers: ['ambuja'] }] }, date, 'UTC'), /share an id/);
  assert.throws(() => normalizePlan({ walks: [{ id: kept, start: '16:00', walkers: ['harsh'] }, { id: kept, start: '17:00', walkers: ['ambuja'] }] }, date, 'UTC'), /share an id/);
});

test('plan: a walk around midnight counts for one day\'s plan only', async () => {
  const { matchPlans } = await import('../src/walkplan.js');
  const t = Date.parse('2026-11-20T00:00:00Z');
  const today = { date: '2026-11-19', items: [{ id: 'late', start: t - 50 * 60e3, end: t - 20 * 60e3 }] };
  const tomorrow = { date: '2026-11-20', items: [{ id: 'early', start: t + 30 * 60e3, end: t + 60 * 60e3 }] };
  const w = { id: 'w', startedAt: t - 40 * 60e3, endedAt: t - 10 * 60e3 };
  const m = matchPlans([today, tomorrow], [w]);
  assert.equal(m.get('2026-11-19').get('late'), w);
  assert.equal(m.get('2026-11-20').size, 0);
});

test('walk-sheet defaults: pee/poop from the plan, else 14 days of history at this time, else her routine', async () => {
  const { expectPotty, normalizeExpect, routineExpect } = await import('../src/walkexpect.js');
  const NY = 'America/New_York', { minuteOfDay } = await import('../src/walkplan.js'), mod = minuteOfDay(NY);
  const at = Date.parse('2026-11-19T16:00:00Z'); // 11:00 in New York
  assert.deepEqual(expectPotty({ pee: true, poop: false }, [], at, mod), { pee: true, poop: false, from: 'plan' });
  // 11 AM walks of the last days: poop 3 of 4 (75%) → yes; walks at 4 PM (no poop) don't count.
  const hist = [1, 2, 3, 4].map((d) => ({ id: 'a' + d, startedAt: at - d * 864e5 + 20 * 60e3, endedAt: at - d * 864e5 + 50 * 60e3, pee: true, poop: d !== 2 }))
    .concat([1, 2, 3].map((d) => ({ id: 'b' + d, startedAt: at - d * 864e5 + 5 * 3600e3, endedAt: at - d * 864e5 + 5.5 * 3600e3, pee: true, poop: false })));
  assert.deepEqual(expectPotty(null, hist, at, mod), { pee: true, poop: true, from: 'history', n: 4 });
  assert.equal(expectPotty(null, hist, at + 5 * 3600e3, mod).poop, false, '4 PM: no poop');
  assert.equal(expectPotty(null, hist, at - 15 * 864e5, mod).from, 'usual', 'too little history');
  // Routine fallback: always pee; poop on the morning, late-morning and after-dinner walks.
  assert.deepEqual([6 * 60, 11 * 60, 16 * 60, 21 * 60].map((m) => routineExpect(m).poop), [true, true, false, true]);
  assert.deepEqual(expectPotty(null, [], at, mod), { pee: true, poop: true, from: 'usual' });
  assert.deepEqual(normalizeExpect({ pee: 'yes', poop: 0 }), { pee: true, poop: false });
  assert.equal(normalizeExpect({ pee: true }), null);
});

test('plan: no walks after 22:00 unless lateUntil (a late calendar event) allows them', async () => {
  const { normalizePlan, planJSON } = await import('../src/walkplan.js');
  const NY = 'America/New_York', now = Date.parse('2026-11-19T09:30:00Z');
  const body = { walks: [{ start: '06:15', walkers: ['harsh'] }, { start: '21:00', walkers: ['harsh', 'ambuja'], expect: { pee: true, poop: true } },
    { start: '22:30', walkers: ['harsh'] }] };
  const p = normalizePlan(body, '2026-11-19', NY, {}, now);
  assert.deepEqual(p.items.map((x) => new Date(x.start).toISOString()), ['2026-11-19T11:15:00.000Z', '2026-11-20T02:00:00.000Z'], 'last walk 21:00');
  assert.deepEqual(p.dropped.map((x) => x.start), ['2026-11-20T03:30:00.000Z']);
  assert.deepEqual(p.items[1].expect, { pee: true, poop: true });
  const j = planJSON(p, new Map(), now, [], NY);
  assert.deepEqual(j.walks.map((x) => x.expect.from), ['usual', 'plan']);
  // Out late (an event ends at 22:15): a walk by 22:45 is fine, one at 23:00 is not.
  const late = normalizePlan({ ...body, lateUntil: '22:45', walks: [...body.walks, { start: '23:00', walkers: ['harsh'] }] }, '2026-11-19', NY, {}, now);
  assert.deepEqual(late.items.map((x) => new Date(x.start).toISOString().slice(11, 16)), ['11:15', '02:00', '03:30']);
  assert.equal(late.dropped.length, 1);
  // A walk already walked keeps its place.
  const kept = normalizePlan(body, '2026-11-19', NY, {}, now, new Set(['2026-11-19-0330']));
  assert.equal(kept.items.length, 3);
});

test('plan calendars: WALK_PLAN_CALENDARS keys in any order', async () => {
  const { planCalendarName } = await import('../src/walkplan.js');
  const env = { WALK_PLAN_CALENDARS: '{"harsh": "H", "Harsh + Ambuja": "Family"}' };
  assert.equal(planCalendarName(env, ['ambuja', 'harsh']), 'Family');
  assert.equal(planCalendarName(env, ['harsh']), 'H');
});

test('route points: numeric-string times count; missing coordinates are not 0, 0', async () => {
  const { normalizeRoute } = await import('../src/walks.js');
  const r = normalizeRoute({ points: [
    { who: 'harsh', lat: 40.7, lon: -74, t: '1795554000.0' },
    { who: 'harsh', lat: '', lon: -74, t: 1795554010 },
    { who: 'harsh', lon: -74, t: 1795554020 },
    { who: 'harsh', lat: 40.7001, lon: -74, t: new Date(1795554030e3).toISOString() },
  ] });
  assert.deepEqual(r.paths.harsh.map((p) => [p[0], p[3]]), [[40.7, 1795554000], [40.7001, 1795554030]]);
});

test('walk-sheet defaults: a planId the replan no longer has falls back to the nearest planned walk', async () => {
  const { planFor } = await import('../src/walkexpect.js');
  const plans = [{ walks: [{ id: 'new', start: '2026-11-19T16:30:00Z', walkerIds: ['harsh'] }] }];
  assert.equal(planFor({ startedAt: Date.parse('2026-11-19T16:15:00Z'), planId: 'gone' }, plans, Date.parse('2026-11-19T17:00:00Z')).id, 'new');
});
