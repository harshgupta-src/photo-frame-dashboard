// Home tab logic (js/views/control.js), free of DOM APIs so node --test can run it
// (test/homectl.test.js): Home Assistant state + the view's optimistic overlay → tile / card models,
// and the service call for each action.
//
// Overlays: an action shows its expected result at once as an overlay on the entity's state,
//   { on?: bool, state?: string, attributes?: {...}, after?: last_updated }
// merged() is what the view paints; settled() says whether HA's state has caught up with it (then the
// overlay is dropped and HA's own state shows). An overlay that never settles is dropped by the view
// after a timeout, so HA always wins in the end.

export var MP = { PAUSE: 1, VOLUME_SET: 4, VOLUME_MUTE: 8, PREV: 16, NEXT: 32, TURN_ON: 128, TURN_OFF: 256, PLAY: 16384 };
export var FAN = { SET_SPEED: 1, PRESET: 8 };
export var MODE_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Auto', auto: 'Auto', off: 'Off' };
var OFFISH = { off: 1, standby: 1, unavailable: 1, unknown: 1 };
// How close a numeric attribute has to be to count as confirmed (lights round brightness_pct).
var TOL = { brightness: 4, volume_level: 0.02, percentage: 1, color_temp_kelvin: 60, temperature: 0.26, target_temp_low: 0.26, target_temp_high: 0.26 };

export function domainOf(id) {
  var s = String(id), i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : '';
}
export function item(x) { return typeof x === 'string' ? { id: x } : x; }
export function isOffline(e) { return !e || e.state === 'unavailable' || e.state === 'unknown'; }
export function isOn(e) { return !!e && !OFFISH[e.state]; }

export function merged(e, ov) {
  if (!e || !ov) return e;
  var state = ov.state != null ? ov.state : e.state;
  if (ov.on != null && !OFFISH[state] !== ov.on) state = ov.on ? 'on' : 'off';
  return { entity_id: e.entity_id, state: state, attributes: Object.assign({}, e.attributes, ov.attributes), last_updated: e.last_updated };
}

function close(k, have, want) {
  if (typeof want === 'number' && typeof have === 'number') return Math.abs(have - want) <= (TOL[k] != null ? TOL[k] : 0.001);
  return have === want;
}
export function settled(e, ov) {
  if (!ov || !e) return true;
  if (ov.on != null && isOn(e) !== ov.on) return false;
  if (ov.state != null && e.state !== ov.state) return false;
  var a = ov.attributes || {}, ea = e.attributes || {};
  if (!Object.keys(a).every(function (k) { return close(k, ea[k], a[k]); })) return false;
  // Nothing particular expected (next track…): any update will do.
  if (ov.on == null && ov.state == null && !Object.keys(a).length) return e.last_updated !== ov.after;
  return true;
}

export function pctOf(brightness) { return brightness == null ? 100 : Math.max(1, Math.min(100, Math.round(brightness / 2.55))); }
export function dimmable(a) {
  var modes = (a && a.supported_color_modes) || [];
  return modes.some(function (m) { return m !== 'onoff'; });
}
export function hasColorTemp(a) { return ((a && a.supported_color_modes) || []).indexOf('color_temp') > -1; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function stripRoom(name, room) {
  if (room && name.toLowerCase().indexOf(room.toLowerCase() + ' ') === 0) name = name.slice(room.length + 1);
  return name;
}

// A room tile → { id, kind, name, icon, offline, busy, on, dim, level (0–100), text, presets }, or
// null when HA doesn't have the entity.
export function tileModel(it, e, ov, room) {
  if (!e) return null;
  var kind = domainOf(e.entity_id), m = merged(e, ov), a = m.attributes || {};
  var t = {
    id: e.entity_id, kind: kind, name: it.name || stripRoom(a.friendly_name || e.entity_id, room),
    icon: { light: 'bulb', fan: 'fan', media_player: 'tv' }[kind] || 'power',
    offline: isOffline(e), busy: !!ov, on: false, dim: false, level: 0, text: '', presets: [],
  };
  if (t.offline) { t.busy = false; t.text = 'Offline'; return t; }
  t.on = isOn(m);
  if (kind === 'light') {
    t.dim = dimmable(a);
    t.level = t.on ? pctOf(a.brightness) : 0;
    t.text = t.on ? (t.dim ? t.level + '%' : 'On') : 'Off';
  } else if (kind === 'fan') {
    t.dim = !!((a.supported_features || 0) & FAN.SET_SPEED);
    t.presets = a.preset_modes || [];
    t.step = a.percentage_step || 0;
    t.level = t.on ? (a.percentage || 0) : 0;
    t.text = t.on ? (a.preset_mode || (a.percentage ? a.percentage + '%' : 'On')) : 'Off';
  } else if (kind === 'media_player') {
    t.text = t.on ? (m.state === 'playing' ? 'Playing' : 'On') : 'Off';
  } else t.text = t.on ? 'On' : 'Off';
  if (!t.dim) t.level = t.on ? 100 : 0;
  return t;
}

// → { domain, service, data, ov }
export function toggleAction(t) {
  var turnOn = !t.on;
  return { domain: t.kind, service: turnOn ? 'turn_on' : 'turn_off', data: { entity_id: t.id }, ov: { on: turnOn } };
}
export function levelAction(t, level) {
  level = Math.round(clamp(level, 0, 100));
  if (level <= 0) return { domain: t.kind, service: 'turn_off', data: { entity_id: t.id }, ov: { on: false } };
  if (t.kind === 'fan') {
    level = snapLevel(level, t.step);
    return { domain: 'fan', service: 'set_percentage', data: { entity_id: t.id, percentage: level }, ov: { on: true, attributes: { percentage: level } } };
  }
  return { domain: 'light', service: 'turn_on', data: { entity_id: t.id, brightness_pct: level }, ov: { on: true, attributes: { brightness: Math.round(level * 2.55) } } };
}
// Fan speed in its own steps (Windmill: 20 % per step), at least one step.
export function snapLevel(level, step) {
  if (!step || level <= 0) return Math.round(level);
  return clamp(Math.round(level / step) * step, step, 100);
}
export function presetAction(t, preset) {
  return { domain: 'fan', service: 'set_preset_mode', data: { entity_id: t.id, preset_mode: preset }, ov: { on: true, attributes: { preset_mode: preset } } };
}
export var WARMTH = [['Warm', 2700], ['Soft', 3200], ['Neutral', 4000], ['Daylight', 5500]];
export function warmthAction(e, kelvin) {
  var a = (e && e.attributes) || {};
  var k = Math.round(clamp(kelvin, a.min_color_temp_kelvin || 2000, a.max_color_temp_kelvin || 6500));
  return { domain: 'light', service: 'turn_on', data: { entity_id: e.entity_id, color_temp_kelvin: k }, ov: { on: true, attributes: { color_temp_kelvin: k } } };
}
// Lights among ids that are on (as painted) → "All off".
export function lightsOn(ids, states, ovs) {
  return ids.filter(function (id) { return domainOf(id) === 'light' && isOn(merged(states[id], ovs && ovs[id])) && !isOffline(states[id]); });
}

// ---------------------------------------------------------------- climate
// HA's unit ('°F' / '°C', from /api/config) → the display unit ('F' / 'C'): °C to the half degree.
export function toDisp(v, haUnit, disp) {
  if (v == null || !isFinite(v)) return null;
  var haF = /F/.test(haUnit || ''), dF = disp === 'F';
  if (haF && !dF) v = (v - 32) * 5 / 9;
  else if (!haF && dF) v = v * 9 / 5 + 32;
  return dF ? Math.round(v) : Math.round(v * 2) / 2;
}
export function climateModel(e, ov, haUnit, disp) {
  if (!e) return null;
  var m = merged(e, ov), a = m.attributes || {}, c = function (v) { return toDisp(v, haUnit, disp); };
  var modes = (a.hvac_modes || []).filter(function (x) { return MODE_LABEL[x]; });
  return {
    id: e.entity_id, offline: isOffline(e), busy: !!ov, mode: m.state, modes: modes,
    action: a.hvac_action || '', current: c(a.current_temperature), humidity: a.current_humidity == null ? null : Math.round(a.current_humidity),
    dual: m.state === 'heat_cool' || m.state === 'auto', target: c(a.temperature), low: c(a.target_temp_low), high: c(a.target_temp_high),
    eco: a.preset_mode === 'eco', hasEco: (a.preset_modes || []).indexOf('eco') > -1,
  };
}
// One +/- press on key ('temperature', 'target_temp_low' or 'target_temp_high'), in HA's unit.
export function stepTemp(e, key, dir, haUnit) {
  var a = (e && e.attributes) || {}, F = /F/.test(haUnit || '');
  var step = a.target_temp_step || (F ? 1 : 0.5);
  var v = a[key] != null ? a[key] : a.temperature != null ? a.temperature : a.current_temperature != null ? a.current_temperature : F ? 70 : 21;
  v = Math.round((v + dir * step) / step) * step;
  return clamp(v, a.min_temp != null ? a.min_temp : -Infinity, a.max_temp != null ? a.max_temp : Infinity);
}
// set_temperature with what's painted (e = merged state, so a pending low/high pair goes together).
export function tempAction(e, key, value) {
  var a = e.attributes || {}, data = { entity_id: e.entity_id }, attrs = {};
  attrs[key] = value;
  if (key === 'temperature') data.temperature = value;
  else {
    data.target_temp_low = key === 'target_temp_low' ? value : a.target_temp_low;
    data.target_temp_high = key === 'target_temp_high' ? value : a.target_temp_high;
  }
  return { domain: 'climate', service: 'set_temperature', data: data, ov: { attributes: attrs }, merge: true };
}
export function modeAction(id, mode) {
  return { domain: 'climate', service: 'set_hvac_mode', data: { entity_id: id, hvac_mode: mode }, ov: { state: mode } };
}
export function ecoAction(id, on) {
  var p = on ? 'eco' : 'none';
  return { domain: 'climate', service: 'set_preset_mode', data: { entity_id: id, preset_mode: p }, ov: { attributes: { preset_mode: p } }, merge: true };
}

// ---------------------------------------------------------------- media
var RANK = { playing: 3, paused: 2, on: 1, idle: 1, buffering: 2 };
// The player to show: playing, else paused, else on, else the first one HA has.
export function pickPlayer(list, states) {
  var best = null, bestRank = -1;
  list.map(item).forEach(function (it) {
    var e = states[it.id];
    if (!e) return;
    var r = RANK[e.state] || 0;
    if (r > bestRank) { best = it; bestRank = r; }
  });
  return best;
}
var STATE_TEXT = { playing: 'Playing', paused: 'Paused', idle: 'Idle', on: 'On', off: 'Off', standby: 'Off', buffering: 'Loading', unavailable: 'Offline', unknown: 'Offline' };
export function mediaModel(it, e, ov) {
  if (!e) return null;
  var m = merged(e, ov), a = m.attributes || {}, f = a.supported_features || 0;
  var artist = a.media_artist || a.media_album_artist || a.media_series_title || '';
  var from = a.app_name || a.source || '';
  return {
    id: e.entity_id, name: it.name || a.friendly_name || e.entity_id, offline: isOffline(e), busy: !!ov,
    state: m.state, stateText: STATE_TEXT[m.state] || m.state, playing: m.state === 'playing',
    title: a.media_title || '', sub: [artist, from].filter(Boolean).join(' · '),
    canPlay: !!(f & (MP.PAUSE | MP.PLAY)), canPrev: !!(f & MP.PREV), canNext: !!(f & MP.NEXT),
    canVol: !!(f & MP.VOLUME_SET) && isOn(m), canMute: !!(f & MP.VOLUME_MUTE) && isOn(m),
    volume: a.volume_level == null ? null : Math.round(a.volume_level * 100), muted: !!a.is_volume_muted,
  };
}
export function mediaAction(m, what, e, value) {
  var d = { entity_id: m.id };
  if (what === 'play') return { domain: 'media_player', service: 'media_play_pause', data: d, ov: { state: m.playing ? 'paused' : 'playing' } };
  if (what === 'next' || what === 'prev') {
    return { domain: 'media_player', service: what === 'next' ? 'media_next_track' : 'media_previous_track', data: d, ov: { after: e && e.last_updated } };
  }
  if (what === 'mute') {
    d.is_volume_muted = !m.muted;
    return { domain: 'media_player', service: 'volume_mute', data: d, ov: { attributes: { is_volume_muted: !m.muted } }, merge: true };
  }
  var v = Math.round(clamp(value, 0, 100)) / 100;
  d.volume_level = v;
  return { domain: 'media_player', service: 'volume_set', data: d, ov: { attributes: { volume_level: v } }, merge: true };
}

// ---------------------------------------------------------------- people
// person.* state is the zone name ("Maya's Bathroom"); home = zone.home among in_zones.
export function presence(it, e) {
  if (!e) return null;
  var a = e.attributes || {}, zones = a.in_zones;
  var home = Array.isArray(zones) ? zones.indexOf('zone.home') > -1 : e.state === 'home';
  var where = home ? 'Home' : e.state === 'not_home' ? 'Away' : isOffline(e) ? '?' : e.state;
  return { id: e.entity_id, name: it.name || String(a.friendly_name || e.entity_id).split(' ')[0], home: home, where: where };
}

// A debounced call; flush() sends a pending one now, cancel() drops it. Timers are injectable for tests.
export function debounce(fn, ms, timers) {
  var set = (timers && timers.set) || setTimeout, clear = (timers && timers.clear) || clearTimeout;
  var t = null, args = null;
  function run() { t = null; var a = args; args = null; fn.apply(null, a); }
  function d() { args = arguments; if (t) clear(t); t = set(run, ms); }
  d.flush = function () { if (t) { clear(t); run(); } };
  d.cancel = function () { if (t) clear(t); t = null; args = null; };
  d.pending = function () { return !!t; };
  return d;
}

export function servicePath(a) { return '/api/services/' + a.domain + '/' + a.service; }
