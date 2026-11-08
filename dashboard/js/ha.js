// Home Assistant, through the kiosk app's window.HomeHQ bridge (kiosk MainActivity.HaBridge): the
// token stays on the frame, so it is never part of the hosted dashboard. Without the bridge (a
// desktop browser, or HA not set up on the frame) App.ha.ready is false and the Home card keeps its
// demo data.
//   App.ha.states     entity_id → state object, refreshed every POLL_MS while the page is visible
//   App.ha.lights()   [{ id, name, ids, on, total }] for the Home card's buttons
//   App.ha.toggle(id) turn a button's lights off if any are on, otherwise on
//   App.ha.call(method, path, body)  raw bridge call (the kiosk allows only a few paths)
// VITE_HA_ROOM in .env.local adds a room button, "Name:pattern" with * as a wildcard, e.g.
// "Living room:light.living_room_*". An "All lights" button is always there.
(function () {
  'use strict';
  var bridge = window.HomeHQ;
  var POLL_MS = 15000, TIMEOUT_MS = 15000;
  var calls = {}, seq = 0, timer = null;
  var ha = App.ha = { ready: false, states: {}, unit: '°C', updated: null };

  if (!bridge || !bridge.haReady || !bridge.haReady()) return;
  ha.ready = true;

  window.haReply = function (id, status, text) {
    var c = calls[id];
    if (!c) return;
    delete calls[id];
    clearTimeout(c.timer);
    if (status >= 200 && status < 300) c.ok(text ? JSON.parse(text) : null);
    else c.fail(new Error(status ? 'HA ' + status : text));
  };
  function call(method, path, body) {
    return new Promise(function (ok, fail) {
      var id = 'h' + (++seq);
      calls[id] = { ok: ok, fail: fail, timer: setTimeout(function () { delete calls[id]; fail(new Error('HA timed out')); }, TIMEOUT_MS) };
      bridge.call(id, method, path, body ? JSON.stringify(body) : '');
    });
  }

  function glob(p) { return new RegExp('^' + p.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); }
  var buttons = [];
  var room = import.meta.env.VITE_HA_ROOM;
  if (room && room.indexOf(':') > 0) buttons.push({ id: 'room', name: room.slice(0, room.indexOf(':')).trim(), match: glob(room.slice(room.indexOf(':') + 1)) });
  buttons.push({ id: 'all', name: 'All lights', match: /^light\./ });

  // Lights that belong to an HA light group are left to the group, so a 3-bulb lamp counts once.
  function lightIds() {
    var s = ha.states, members = {};
    Object.keys(s).forEach(function (id) { (s[id].attributes.entity_id || s[id].attributes.group_entities || []).forEach(function (m) { if (m !== id) members[m] = 1; }); });
    return Object.keys(s).filter(function (id) { return /^light\./.test(id) && !members[id] && s[id].state !== 'unavailable'; }).sort();
  }
  ha.lights = function () {
    var all = lightIds();
    return buttons.map(function (b) {
      var ids = all.filter(function (id) { return b.match.test(id); });
      return { id: b.id, name: b.name, ids: ids, total: ids.length, on: ids.filter(function (id) { return ha.states[id].state === 'on'; }).length };
    });
  };
  ha.toggle = function (bid) {
    var b = ha.lights().filter(function (x) { return x.id === bid; })[0];
    if (!b || !b.total) return Promise.resolve();
    var turnOn = !b.on;
    b.ids.forEach(function (id) { ha.states[id].state = turnOn ? 'on' : 'off'; });
    App.emit('ha');
    return call('POST', '/api/services/light/turn_' + (turnOn ? 'on' : 'off'), { entity_id: b.ids })
      .then(function () { setTimeout(refresh, 1500); })
      .catch(function (e) {
        App.toast('Couldn’t reach Home Assistant · ' + App.esc(e.message), { tone: 'error', icon: 'bolt' });
        refresh();
      });
  };

  // Inside temperature from the thermostat, in the dashboard's °C.
  ha.inside = function () {
    var s = ha.states, id = Object.keys(s).filter(function (k) { return /^climate\./.test(k); })[0];
    var t = id && s[id].attributes.current_temperature;
    if (t == null) return null;
    return Math.round(ha.unit === '°F' ? (t - 32) * 5 / 9 : t);
  };

  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, POLL_MS);
    if (document.hidden) return Promise.resolve();
    return call('GET', '/api/states').then(function (list) {
      var s = {};
      list.forEach(function (e) { s[e.entity_id] = e; });
      ha.states = s;
      ha.updated = new Date();
      App.emit('ha');
    }).catch(function (e) { console.warn('Home Assistant:', e.message); });
  }
  ha.refresh = refresh;
  ha.call = call; // live.js reads calendars and to-do lists through the bridge too
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  call('GET', '/api/config').then(function (c) { ha.unit = c.unit_system.temperature; }).catch(function () {}).then(refresh);
})();
