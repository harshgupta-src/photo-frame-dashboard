import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlanEvent, withPlans } from '../js/planevents.js';

var opts = { dog: 'Maya', isPerson: (id) => id === 'harsh' || id === 'ambuja' };
var at = (h, m) => new Date(2026, 10, 24, h, m || 0);
var cal = (uid, h, title) => ({ id: uid, title: title || '🐕 Maya walk — Harsh', people: ['harsh'], start: at(h), end: at(h, 40) });
var item = (id, h, status, who, m) => ({ id, start: at(h, m).toISOString(), end: at(h, (m || 0) + 40).toISOString(), walkers: who || ['Harsh'], walkerIds: (who || ['Harsh']).map((n) => n.toLowerCase()), status });

test('recognises plan copies from the Worker and from HA calendars', () => {
  assert.ok(isPlanEvent({ id: 'walk-plan-2026-11-24-1600@frame-data' }));
  assert.ok(isPlanEvent({ id: 'calendar.harsh|walk-plan-2026-11-24-1600@frame-data|2026-11-24T16:00:00-05:00' }));
  assert.ok(!isPlanEvent({ id: 'dog-walk-abc@frame-data' }));
  assert.ok(!isPlanEvent({ id: 'dentist-1' }));
});

test('a replan replaces the stale calendar copy; walked ones drop off', () => {
  var events = [cal('dentist', 9, 'Dentist'), cal('walk-plan-2026-11-24-1600@frame-data', 16), cal('walk-plan-2026-11-24-0700@frame-data', 7)];
  var plans = [{ date: '2026-11-24', walks: [item('2026-11-24-0700', 7, 'done'), item('2026-11-24-1630', 16, 'planned', ['Ambuja'], 30)] }];
  var out = withPlans(events, plans, ['2026-11-24', '2026-11-25'], opts);
  assert.deepEqual(out.map((e) => e.title), ['Dentist', '🐕 Maya walk — Ambuja']);
  assert.deepEqual(out[1].people, ['ambuja']);
  assert.equal(+out[1].start, +at(16, 30));
});

test('keeps calendar copies for days the walk sync has not fetched', () => {
  var events = [cal('walk-plan-2026-11-24-1600@frame-data', 16)];
  assert.equal(withPlans(events, [], [], opts).length, 1);
  assert.equal(withPlans(events, [], ['2026-11-24'], opts).length, 0); // fetched: no plan that day
});
