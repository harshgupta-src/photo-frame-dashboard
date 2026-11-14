// Home Assistant. On the frame it goes through the kiosk app's window.HomeHQ bridge (kiosk
// MainActivity.HaBridge): the token stays on the frame, so it is never part of the hosted dashboard.
// Elsewhere (the dashboard installed on a phone, IPHONE.md) the page talks to HA itself once the
// person has signed in with their HA account (js/haweb.js, VITE_HA_URL). Without either (a desktop
// browser, or HA not set up) App.ha.ready is false and the Home card keeps its demo data.
//   App.ha.states     entity_id → state object, refreshed every POLL_MS while the page is visible
//   App.ha.lights()   [{ id, name, ids, on, total }] for the Home card's buttons
//   App.ha.toggle(id) turn a button's lights off if any are on, otherwise on
//   App.ha.call(method, path, body)  raw call (only the kiosk's allowed paths, on both transports)
//   App.ha.web        phone sign-in: { signedIn, signIn(), useToken(t), signOut() }, or null on the frame
// VITE_HA_ROOM in .env.local adds a room button, "Name:pattern" with * as a wildcard, e.g.
// "Living room:light.living_room_*". An "All lights" button is always there.
import { createWebHA, authorizeUrl, STATE_KEY } from './haweb.js';

(function () {
  'use strict';
  var bridge = window.HomeHQ;
  var POLL_MS = 15000, TIMEOUT_MS = 15000;
  var calls = {}, seq = 0, timer = null;
  var ha = App.ha = { ready: false, states: {}, unit: '°C', updated: null, web: null };
  var call;

  if (bridge && bridge.haReady && bridge.haReady()) {
    window.haReply = function (id, status, text) {
      var c = calls[id];
      if (!c) return;
      delete calls[id];
      clearTimeout(c.timer);
      if (status >= 200 && status < 300) c.ok(text ? JSON.parse(text) : null);
      else c.fail(new Error(status ? 'HA ' + status : text));
    };
    call = function (method, path, body) {
      return new Promise(function (ok, fail) {
        var id = 'h' + (++seq);
        calls[id] = { ok: ok, fail: fail, timer: setTimeout(function () { delete calls[id]; fail(new Error('HA timed out')); }, TIMEOUT_MS) };
        bridge.call(id, method, path, body ? JSON.stringify(body) : '');
      });
    };
  } else if (!bridge && import.meta.env.VITE_HA_URL && webSetup()) {
    call = ha.web.call;
  } else return;
  ha.ready = true;

  // Phone sign-in. HA's login page sends the browser back to /?ha_auth=1&code=…&state=…; the code is
  // swapped for tokens and the page reloads clean, so every view is built knowing HA is there.
  function webSetup() {
    var store;
    try { store = window.localStorage; } catch (e) { return false; }
    var haUrl = import.meta.env.VITE_HA_URL.replace(/\/+$/, ''), origin = location.origin;
    var api = createWebHA({ haUrl: haUrl, clientId: origin + '/', storage: store, fetch: window.fetch.bind(window) });
    var web = ha.web = {
      signedIn: api.signedIn(),
      signIn: function () {
        var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
        store.setItem(STATE_KEY, state);
        location.href = authorizeUrl(haUrl, origin + '/', origin + '/?ha_auth=1', state);
      },
      useToken: function (t) { return api.useToken(t).then(function () { location.reload(); }); },
      signOut: function () { return api.signOut().then(function () { location.reload(); }); },
      call: function (method, path, body) {
        return api.call(method, path, body).catch(function (e) {
          if (e.message === 'signed out' && web.signedIn) {
            web.signedIn = false;
            App.toast('Signed out of Home Assistant · press and hold the clock to sign in again', { tone: 'error', icon: 'bolt', ms: 8000 });
          }
          throw e;
        });
      },
    };
    var q = new URLSearchParams(location.search);
    if (q.get('ha_auth')) {
      var code = q.get('code'), ok = code && q.get('state') && q.get('state') === store.getItem(STATE_KEY);
      store.removeItem(STATE_KEY);
      var back = function () { location.replace(origin + '/' + location.hash); };
      if (ok) api.exchange(code).then(back, function (e) { alert('Home Assistant sign-in failed: ' + e.message); back(); });
      else back();
      return false;
    }
    return web.signedIn;
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
