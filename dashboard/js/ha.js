// Home Assistant. On the frame it goes through the kiosk app's window.HomeHQ bridge (kiosk
// MainActivity.HaBridge): the token stays on the frame, so it is never part of the hosted dashboard.
// Elsewhere (the dashboard installed on a phone, IPHONE.md) the page talks to HA itself once the
// person has signed in with their HA account (js/haweb.js, VITE_HA_URL). Without either (a desktop
// browser, or HA not set up) App.ha.ready is false and the Home card keeps its demo data.
//   App.ha.states     entity_id → state object, refreshed every POLL_MS while the page is visible
//   App.ha.live       true while the kiosk streams state changes (below)
//   App.ha.lights()   [{ id, name, ids, on, total }] for the Home card's buttons
//   App.ha.toggle(id) turn a button's lights off if any are on, otherwise on
//   App.ha.call(method, path, body)  raw call (only the kiosk's allowed paths, on both transports)
//   App.ha.web        phone sign-in: { signedIn, signIn(), useToken(t), signOut() }, or null on the frame
// VITE_HA_ROOM in .env.local adds a room button, "Name:pattern" with * as a wildcard, e.g.
// "Living room:light.living_room_*". An "All lights" button is always there.
// Emits 'ha' with the changed entity ids, only when something changed.
//
// Live push (kiosk 1.4+): once the first poll is in, HomeHQ.haWatch('["light",…]') asks the kiosk to
// stream those domains (hastate.js WATCH_DOMAINS) from HA's websocket. It calls window.haPush(msg):
//   {full: true, live: true, states}   the watched domains' entities (replaces them)
//   {live: true, states, removed}      changed entities / removed ids
//   {live: false}                      the stream dropped
// While the stream is up (HomeHQ.haLive()) the 15 s /api/states poll slows to a 5 min safety poll;
// without it (older kiosk, phones, stream down) the 15 s poll stays.
import { createWebHA, authorizeUrl, STATE_KEY } from './haweb.js';
import { WATCH_DOMAINS, fromPoll, parsePush, applyPush } from './hastate.js';

(function () {
  'use strict';
  var bridge = window.HomeHQ;
  var POLL_MS = 15000, LIVE_POLL_MS = 5 * 60000, TIMEOUT_MS = 15000;
  var calls = {}, seq = 0, timer = null, lastPoll = 0, watching = false, loaded = false, pending = null;
  var ha = App.ha = { ready: false, states: {}, unit: '°C', updated: null, web: null, live: false };
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
    App.emit('ha', b.ids.slice());
    return call('POST', '/api/services/light/turn_' + (turnOn ? 'on' : 'off'), { entity_id: b.ids })
      // The stream normally confirms within a second; the poll is the check that it did.
      .then(function () { setTimeout(refresh, isLive() ? 5000 : 1500); })
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

  function isLive() {
    if (!ha.live) return false;
    try { return !bridge || !bridge.haLive || !!bridge.haLive(); } catch (e) { return true; }
  }
  // Views hear about changes only while visible; changes made while hidden are sent in one go when
  // the page is shown again.
  function changed(ids) {
    if (!ids.length) return;
    if (document.hidden) { pending = (pending || []).concat(ids); return; }
    App.emit('ha', ids);
  }
  function flush() {
    if (!pending || document.hidden) return;
    var seen = {}, ids = pending.filter(function (id) { return seen[id] ? false : (seen[id] = 1); });
    pending = null;
    App.emit('ha', ids);
  }
  // Checked every POLL_MS: polls unless the stream is up and the last poll is recent. Asking
  // haLive() each time also catches a stream that died without a {live: false}.
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(pollTick, ms); }
  function pollTick() {
    if (!document.hidden && isLive() && Date.now() - lastPoll < LIVE_POLL_MS) { schedule(POLL_MS); return; }
    refresh();
  }

  function refresh() {
    clearTimeout(timer);
    timer = null;
    if (document.hidden) return Promise.resolve(); // visibilitychange picks it up again
    schedule(POLL_MS);
    lastPoll = Date.now();
    return call('GET', '/api/states').then(function (list) {
      var r = fromPoll(ha.states, list, isLive());
      ha.states = r.states;
      ha.updated = new Date();
      if (!loaded) { loaded = true; App.emit('ha', r.changed); } else changed(r.changed);
      watch();
    }).catch(function (e) { console.warn('Home Assistant:', e.message); });
  }

  // Ask the kiosk (1.4+) to stream the watched domains; once is enough, it reconnects by itself.
  function watch() {
    if (watching || !bridge || typeof bridge.haWatch !== 'function') return;
    watching = true;
    try { bridge.haWatch(JSON.stringify(WATCH_DOMAINS)); } catch (e) { console.warn('haWatch failed', e); }
  }
  if (bridge) {
    window.haPush = function (raw) {
      var msg = parsePush(raw);
      if (!msg) return;
      if (msg.live === false) {
        var was = ha.live;
        ha.live = false;
        if (was) refresh(); // stream down: back to the 15 s poll, starting now
        return;
      }
      if (msg.live) ha.live = true;
      var ids = applyPush(ha.states, msg, WATCH_DOMAINS);
      if (ids.length || msg.full) ha.updated = new Date();
      changed(ids);
    };
  }

  ha.refresh = refresh;
  ha.isLive = isLive;
  ha.call = call; // live.js reads calendars and to-do lists through the bridge too
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    flush();
    pollTick();
  });
  call('GET', '/api/config').then(function (c) { ha.unit = c.unit_system.temperature; }).catch(function () {}).then(refresh);
})();
