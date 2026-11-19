import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/homectl.js';

const T1 = '2026-11-19T15:00:00+00:00', T2 = '2026-11-19T15:00:02+00:00';
const st = (id, state, attributes = {}, at = T1) => ({ entity_id: id, state, attributes, last_updated: at });
const lamp = (state, brightness, at) => st('light.lamp', state, { supported_color_modes: ['color_temp', 'xy'], brightness, friendly_name: 'Living Room Lamp', min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, at);

test('a dimmable light tile: level from brightness, name without the room', () => {
  const t = H.tileModel({ id: 'light.lamp' }, lamp('on', 128), null, 'Living Room');
  assert.equal(t.name, 'Lamp');
  assert.equal(t.on, true);
  assert.equal(t.dim, true);
  assert.equal(t.level, 50);
  assert.equal(t.text, '50%');
  assert.equal(t.busy, false);
  const off = H.tileModel({ id: 'light.lamp', name: 'Table' }, lamp('off', null), null, 'Living Room');
  assert.deepEqual([off.name, off.on, off.level, off.text], ['Table', false, 0, 'Off']);
});

test('unavailable entities are offline tiles; missing ones have no tile', () => {
  const t = H.tileModel({ id: 'light.lamp' }, st('light.lamp', 'unavailable'), { on: true }, '');
  assert.deepEqual([t.offline, t.on, t.busy, t.text], [true, false, false, 'Offline']);
  assert.equal(H.tileModel({ id: 'light.x' }, undefined, null, ''), null);
});

test('an overlay paints the expected state until HA confirms it', () => {
  const e = lamp('off', null);
  const a = H.toggleAction(H.tileModel({ id: 'light.lamp' }, e, null, ''));
  assert.deepEqual([a.domain, a.service, a.data], ['light', 'turn_on', { entity_id: 'light.lamp' }]);
  const t = H.tileModel({ id: 'light.lamp' }, e, a.ov, '');
  assert.deepEqual([t.on, t.busy], [true, true]);
  assert.equal(H.settled(e, a.ov), false);
  assert.equal(H.settled(lamp('on', 255, T2), a.ov), true);
});

test('brightness: sent as a percentage, confirmed within rounding, 0 turns off', () => {
  const t = H.tileModel({ id: 'light.lamp' }, lamp('on', 255), null, '');
  const a = H.levelAction(t, 40);
  assert.deepEqual([a.service, a.data.brightness_pct], ['turn_on', 40]);
  assert.equal(H.settled(lamp('on', 104, T2), a.ov), true);
  assert.equal(H.settled(lamp('on', 255, T2), a.ov), false);
  assert.equal(H.levelAction(t, 0).service, 'turn_off');
});

test('fan speed snaps to its steps; presets show as its state', () => {
  const e = st('fan.f', 'on', { supported_features: 57, percentage: 40, percentage_step: 20, preset_mode: 'Low', preset_modes: ['Low', 'High'] });
  const t = H.tileModel({ id: 'fan.f' }, e, null, '');
  assert.deepEqual([t.dim, t.level, t.text, t.presets], [true, 40, 'Low', ['Low', 'High']]);
  assert.deepEqual(H.levelAction(t, 67).data, { entity_id: 'fan.f', percentage: 60 });
  assert.deepEqual(H.levelAction(t, 3).data, { entity_id: 'fan.f', percentage: 20 });
  assert.equal(H.presetAction(t, 'High').service, 'set_preset_mode');
});

test('a TV is on unless off/standby, and the toggle uses media_player', () => {
  const t = H.tileModel({ id: 'media_player.tv' }, st('media_player.tv', 'idle'), null, '');
  assert.equal(t.on, true);
  const a = H.toggleAction(t);
  assert.deepEqual([a.domain, a.service], ['media_player', 'turn_off']);
  assert.equal(H.settled(st('media_player.tv', 'standby'), a.ov), true);
});

test('thermostat in °F shown in °C; steps in HA units, clamped', () => {
  const e = st('climate.t', 'heat', { temperature: 74, current_temperature: 73, current_humidity: 41.4, min_temp: 50, max_temp: 90, hvac_modes: ['heat', 'cool', 'heat_cool', 'off', 'dry'], preset_modes: ['none', 'eco'], preset_mode: 'none', hvac_action: 'heating' });
  const c = H.climateModel(e, null, '°F', 'C');
  assert.deepEqual([c.target, c.current, c.humidity, c.dual, c.hasEco, c.eco], [23.5, 23, 41, false, true, false]);
  assert.deepEqual(c.modes, ['heat', 'cool', 'heat_cool', 'off']);
  assert.equal(H.stepTemp(e, 'temperature', 1, '°F'), 75);
  assert.equal(H.stepTemp(st('climate.t', 'heat', { temperature: 90, max_temp: 90 }), 'temperature', 1, '°F'), 90);
  assert.equal(H.stepTemp(st('climate.t', 'heat', { temperature: 21 }), 'temperature', -1, '°C'), 20.5);
  const a = H.tempAction(e, 'temperature', 75);
  assert.deepEqual(a.data, { entity_id: 'climate.t', temperature: 75 });
  assert.equal(H.climateModel(e, a.ov, '°F', 'F').target, 75);
});

test('heat_cool sends the low/high pair together', () => {
  const e = st('climate.t', 'heat_cool', { target_temp_low: 68, target_temp_high: 76 });
  const a = H.tempAction(e, 'target_temp_high', 77);
  assert.deepEqual(a.data, { entity_id: 'climate.t', target_temp_low: 68, target_temp_high: 77 });
  assert.equal(H.climateModel(e, null, '°F', 'F').dual, true);
});

test('media: the playing player wins; controls follow supported_features', () => {
  const states = {
    'media_player.a': st('media_player.a', 'idle', { supported_features: 8321599 }),
    'media_player.b': st('media_player.b', 'playing', { supported_features: 2048, media_title: 'Song', media_artist: 'Band' }),
  };
  assert.equal(H.pickPlayer(['media_player.a', 'media_player.b', 'media_player.gone'], states).id, 'media_player.b');
  const b = H.mediaModel({ id: 'media_player.b' }, states['media_player.b'], null);
  assert.deepEqual([b.title, b.sub, b.canPlay, b.canVol], ['Song', 'Band', false, false]);
  const a = H.mediaModel({ id: 'media_player.a', name: 'Sonos' }, st('media_player.a', 'playing', { supported_features: 8321599, volume_level: 0.25 }), null);
  assert.deepEqual([a.name, a.canPlay, a.canNext, a.canVol, a.canMute, a.volume], ['Sonos', true, true, true, true, 25]);
  assert.equal(H.mediaAction(a, 'play').ov.state, 'paused');
  assert.deepEqual(H.mediaAction(a, 'vol', null, 40).data, { entity_id: 'media_player.a', volume_level: 0.4 });
});

test('next track has no expected state: any newer update settles it', () => {
  const e = st('media_player.a', 'playing', {}, T1);
  const ov = H.mediaAction({ id: 'media_player.a' }, 'next', e).ov;
  assert.equal(H.settled(e, ov), false);
  assert.equal(H.settled(st('media_player.a', 'playing', {}, T2), ov), true);
});

test('presence: home from in_zones, else the zone name or Away', () => {
  assert.deepEqual(H.presence({ id: 'person.h', name: 'Harsh' }, st('person.h', "Maya's Bathroom", { in_zones: ['zone.maya', 'zone.home'] })), { id: 'person.h', name: 'Harsh', home: true, where: 'Home' });
  assert.equal(H.presence({ id: 'person.a' }, st('person.a', "Ambuja's Work", { in_zones: ['zone.work'], friendly_name: 'Ambuja Banerjee' })).where, "Ambuja's Work");
  assert.equal(H.presence({ id: 'person.a' }, st('person.a', 'not_home', { friendly_name: 'Ambuja Banerjee' })).name, 'Ambuja');
});

test('All off takes only lit, reachable lights as painted', () => {
  const states = { 'light.a': lamp('on', 10), 'light.b': st('light.b', 'off'), 'light.c': st('light.c', 'unavailable'), 'fan.f': st('fan.f', 'on') };
  assert.deepEqual(H.lightsOn(['light.a', 'light.b', 'light.c', 'fan.f'], states, { 'light.b': { on: true } }), ['light.a', 'light.b']);
});

test('debounce sends once per burst with the last arguments; flush sends now', () => {
  const q = [];
  const timers = { set: (fn) => { q.push(fn); return q.length; }, clear: (id) => { q[id - 1] = null; } };
  const sent = [];
  const d = H.debounce((v) => sent.push(v), 600, timers);
  d(1); d(2); d(3);
  q.filter(Boolean).forEach((fn) => fn());
  assert.deepEqual(sent, [3]);
  q.length = 0;
  d(4);
  d.flush();
  assert.deepEqual(sent, [3, 4]);
  d(5); d.cancel();
  q.filter(Boolean).forEach((fn) => fn());
  assert.deepEqual(sent, [3, 4]);
});
