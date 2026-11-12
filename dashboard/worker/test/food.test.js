import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foodFacts, checkAdvice, cupsText, foodRoute } from '../src/food.js';

const NOW = Date.parse('2026-11-12T17:00:00Z');
const WEIGHTS = [['2026-09-13', 10.4, true], ['2026-09-19', 11.3, true], ['2026-10-17', 15], ['2026-10-31', 16.8], ['2026-11-07', 17.2]]
  .map(([d, kg, estimate]) => ({ at: d + 'T17:00:00Z', kg, estimate: !!estimate }));
const day = (date, meals, cups, mixed = false) => ({ date, meals, cups, mixed });
// Her real plan: mixed food until Nov 12, then 5 meals of 100% Purina, then 4 meals from Nov 16.
const PLAN = [day('2026-11-10', 5, 3.5, true), day('2026-11-11', 5, 3.5, true), day('2026-11-12', 5, 3.5, true),
  ...[13, 14, 15].map((d) => day('2026-11-' + d, 5, 3.5)), ...[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((d) => day('2026-11-' + d, 4, 3.5))];
const facts = (plan = PLAN, now = NOW, history = []) => foodFacts({ birthday: '2026-05-17', weights: WEIGHTS, plan, now, history });
const bump = (date, more = {}) => ({ decision: 'bump', date, fromCups: 3.5, toCups: 3.75, healthy: true, ...more });

test('facts: age, adult projection, label band and the plan changes', () => {
  const f = facts();
  assert.equal(f.age.weeks, 25.6);
  assert.ok(f.adult.kg > 27 && f.adult.kg < 33, f.adult.kg);
  assert.equal(f.band.matureLb, '50–75');
  assert.deepEqual([f.band.name, f.nextStage.date, f.nextStage.low], ['1½–5 months', '2026-11-17', 3.67]);
  assert.equal(f.cups, 3.5);
  assert.deepEqual(f.transition, ['2026-11-12']);
  assert.deepEqual(f.changes.map((c) => [c.date, c.what]), [['2026-11-13', 'food transition ends'], ['2026-11-16', '5 → 4 meals']]);
  assert.equal(cupsText(11 / 3), '3 2/3');
});

test('one change at a time: no bump mid-transition or within 7 days of another change', () => {
  const f = facts();
  assert.match(checkAdvice(bump('2026-11-12'), f), /mid-transition/);
  assert.match(checkAdvice(bump('2026-11-20'), f), /4 meals on 2026-11-16/);
  assert.equal(checkAdvice(bump('2026-11-23'), f), null);
  // A later move to 3 meals blocks the week before it too.
  const later = PLAN.concat([27, 28].map((d) => day('2026-11-' + d, 3, 3.5)));
  assert.match(checkAdvice(bump('2026-11-23'), facts(later)), /4 → 3 meals/);
  assert.match(checkAdvice(bump('2026-11-23', { healthy: false }), f), /healthy/);
  assert.match(checkAdvice(bump('2026-11-23', { toCups: 4 }), f), /exactly \+1\/4/);
  assert.match(checkAdvice(bump('2026-11-23'), facts([])), /no meal plan/);
  assert.equal(checkAdvice({ decision: 'hold' }, f), null);
});

test('routes: store a checked bump, show it, mark it done', async () => {
  const kv = new Map(), env = { DATA: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  const call = (method, path, body) => foodRoute(new Request('https://x' + path, { method, body: body && JSON.stringify(body) }), new URL('https://x' + path),
    env, { read: true, write: true }, async (plan, history) => facts(plan, NOW, history), NOW);
  assert.equal((await call('PUT', '/dog/food', { ...bump('2026-11-14'), plan: PLAN })).status, 422);
  const ok = await call('PUT', '/dog/food', { ...bump('2026-11-23'), meal: 'Breakfast', reason: 'below the floor', plan: PLAN });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/dog/food')).body.advice.toCups, 3.75);
  const done = await call('POST', '/dog/food/done', { by: 'harsh' });
  assert.deepEqual([done.status, done.body.advice.doneBy], [200, 'harsh']);
  // The done bump now counts as a change: no second bump the same week.
  const f = (await call('POST', '/dog/food/facts', { plan: PLAN })).body.facts;
  assert.equal(f.lastBump, '2026-11-23');
  assert.match(checkAdvice(bump('2026-11-26', { fromCups: 3.5 }), f), /1\/4 cup bump on 2026-11-23/);
});
