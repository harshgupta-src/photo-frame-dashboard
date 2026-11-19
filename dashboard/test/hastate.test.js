import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCH_DOMAINS, fromPoll, parsePush, applyPush, haDown } from '../js/hastate.js';
import { every } from '../js/poll.js';

const st = (id, state, at = '2026-11-19T15:00:00.000000+00:00', attributes = {}) =>
  ({ entity_id: id, state, attributes, last_changed: at, last_updated: at });
const byId = (list) => Object.fromEntries(list.map((e) => [e.entity_id, e]));
const T1 = '2026-11-19T15:00:00.000000+00:00', T2 = '2026-11-19T15:05:00.000000+00:00';

test('the dashboard watches the domains it reads', () => {
  assert.deepEqual([...WATCH_DOMAINS].sort(), ['climate', 'fan', 'light', 'media_player', 'person', 'todo']);
});

test('a poll reports only entities that changed, appeared or disappeared', () => {
  const prev = byId([st('light.a', 'on'), st('light.b', 'off'), st('sensor.x', '1')]);
  const same = fromPoll(prev, [st('light.a', 'on'), st('light.b', 'off'), st('sensor.x', '1')]);
  assert.deepEqual(same.changed, []);
  const r = fromPoll(prev, [st('light.a', 'off', T2), st('sensor.x', '1'), st('climate.t', 'heat')]);
  assert.deepEqual(r.changed.sort(), ['climate.t', 'light.a', 'light.b']);
  assert.equal(r.states['light.a'].state, 'off');
  assert.ok(!('light.b' in r.states));
});

test('a poll undoes an optimistic toggle HA never confirmed', () => {
  const prev = byId([st('light.a', 'off')]);
  prev['light.a'].state = 'on'; // the Home card flipped it before HA answered
  assert.deepEqual(fromPoll(prev, [st('light.a', 'off')]).changed, ['light.a']);
});

test('while live, a poll snapshot older than the stream keeps the streamed copy', () => {
  const prev = byId([st('light.a', 'on', T2)]);
  const r = fromPoll(prev, [st('light.a', 'off', T1), st('sensor.x', '1')], true);
  assert.equal(r.states['light.a'].state, 'on');
  assert.deepEqual(r.changed, ['sensor.x']);
  assert.equal(fromPoll(prev, [st('light.a', 'off', T1)], false).states['light.a'].state, 'off');
});

test('pushes arrive as objects or JSON text', () => {
  assert.deepEqual(parsePush({ live: false }), { live: false });
  assert.deepEqual(parsePush('{"live":true,"states":[]}'), { live: true, states: [] });
  assert.equal(parsePush('not json'), null);
  assert.equal(parsePush(null), null);
});

test('a full push replaces the watched domains and keeps polled entities of other domains', () => {
  const states = byId([st('light.a', 'on'), st('light.gone', 'off'), st('todo.grocery', '3'), st('sensor.x', '1'), st('group.lamps', 'on')]);
  const changed = applyPush(states, { full: true, live: true, states: [st('light.a', 'on'), st('todo.grocery', '2', T2), st('light.new', 'off')] }, WATCH_DOMAINS);
  assert.deepEqual(changed.sort(), ['light.gone', 'light.new', 'todo.grocery']);
  assert.deepEqual(Object.keys(states).sort(), ['group.lamps', 'light.a', 'light.new', 'sensor.x', 'todo.grocery']);
  assert.equal(states['todo.grocery'].state, '2');
});

test('a delta push merges changes and removals; unchanged repeats report nothing', () => {
  const states = byId([st('light.a', 'off', T1, { brightness: 10 }), st('light.b', 'on'), st('sensor.x', '1')]);
  assert.deepEqual(applyPush(states, { live: true, states: [st('light.a', 'on', T2)], removed: ['light.b', 'light.unknown'] }), ['light.a', 'light.b']);
  assert.equal(states['light.a'].state, 'on');
  assert.ok(!('light.b' in states) && 'sensor.x' in states);
  assert.deepEqual(applyPush(states, { live: true, states: [st('light.a', 'on', T2)] }), []);
});

test('a pushed entity without attributes keeps its old ones (views read attributes)', () => {
  const states = byId([st('climate.t', 'heat', T1, { current_temperature: 21 })]);
  applyPush(states, { live: true, states: [{ entity_id: 'climate.t', state: 'off', last_updated: T2 }] });
  assert.equal(states['climate.t'].attributes.current_temperature, 21);
  applyPush(states, { live: true, states: [{ entity_id: 'light.z', state: 'on', last_updated: T2 }] });
  assert.deepEqual(states['light.z'].attributes, {});
});

test('a dropped stream or junk changes nothing', () => {
  const states = byId([st('light.a', 'on')]);
  assert.deepEqual(applyPush(states, { live: false }), []);
  assert.deepEqual(applyPush(states, null), []);
  assert.deepEqual(applyPush(states, { live: true, states: [null, {}, { state: 'x' }] }), []);
  assert.deepEqual(Object.keys(states), ['light.a']);
});

test('every() skips ticks while hidden and catches up once when shown', async () => {
  const listeners = [];
  const doc = { hidden: false, addEventListener: (e, f) => listeners.push(f), removeEventListener: () => {} };
  let runs = 0, resumes = 0;
  const stop = every(10, () => runs++, { doc, resume: () => resumes++ });
  await new Promise((r) => setTimeout(r, 35));
  assert.ok(runs >= 2);
  doc.hidden = true;
  const before = runs;
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(runs, before);
  doc.hidden = false;
  listeners.forEach((f) => f());
  listeners.forEach((f) => f()); // a second visibilitychange doesn't run it again
  stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resumes, 1);
});

test('haDown: no state yet past half the window, or a stale poll without the live stream', () => {
  assert.equal(haDown({ ready: false }, 1e6, 0, 45000), false);
  assert.equal(haDown({ ready: true, updated: null }, 20000, 0, 45000), false);
  assert.equal(haDown({ ready: true, updated: null }, 23000, 0, 45000), true);
  assert.equal(haDown({ ready: true, updated: 1000 }, 47000, 0, 45000), true);
  assert.equal(haDown({ ready: true, updated: 1000, isLive: () => true }, 47000, 0, 45000), false);
  assert.equal(haDown({ ready: true, updated: 10000 }, 47000, 0, 45000), false);
});
