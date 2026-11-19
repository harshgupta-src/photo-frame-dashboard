// Home tab: Home Assistant controls (js/homecfg.js says what's shown; js/homectl.js turns states
// into tile models and service calls).
//   status strip   inside temperature/humidity, outside, who's home, lights on + "All off"
//   rooms          a tile per device: tap toggles, drag sideways sets brightness / fan speed (sent on
//                  release), press and hold opens a sheet with a big slider, presets and warmth
//   thermostat     ± (debounced, one call per burst), modes, eco
//   media          now playing on the first active player, play/pause, skip, volume, mute
// Every action paints its expected result at once (an overlay) with a small busy dot. HA's pushed
// state clears it when it matches; a failed call rolls it back; with no confirmation after CONFIRM_MS
// the entity is fetched again and HA's state wins.
// Cheap by design for the frame: built once, ~250 nodes, no images or infinite animations. 'ha'
// changes repaint only the widgets of the changed entities, and only when their output changed; while
// another tab is up nothing is touched (App.onScreen) and show() catches up.
import { HOME } from '../homecfg.js';
import * as H from '../homectl.js';

(function () {
  'use strict';
  var BOOT = Date.now(), CONFIRM_MS = 5000, TEMP_DEBOUNCE_MS = 600, HOLD_MS = 500, STALE_MS = 45000, TICK_MS = 10000;
  var I = window.ICONS;
  // Icons this view needs that the shared set doesn't have.
  var extra = {
    fan: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4C11 6 12 3 14.5 3c2.6 0 2.6 4-1.4 7.4M13.6 12c4.4-1 7.4 0 7.4 2.5 0 2.6-4 2.6-7.4-1.4M12 13.6c1 4.4 0 7.4-2.5 7.4-2.6 0-2.6-4 1.4-7.4M10.4 12C6 13 3 12 3 9.5 3 6.9 7 6.9 10.4 10.9"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    prev: '<path d="M18 5v14L8 12z" fill="currentColor"/><path d="M6 5v14"/>',
    next: '<path d="M6 5v14l10-7z" fill="currentColor"/><path d="M18 5v14"/>',
    vol: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
    leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l8-8"/>',
  };
  Object.keys(extra).forEach(function (k) { if (!I[k]) I[k] = extra[k]; });

  var ha = function () { return App.ha || {}; };
  var states = function () { return ha().states || {}; };
  var rooms = HOME.rooms.map(function (r) { return { name: r.name, items: r.items.map(H.item) }; });
  var climate = HOME.climate && H.item(HOME.climate);
  var players = (HOME.media || []).map(H.item);
  var people = (HOME.people || []).map(H.item);
  var allLights = [];
  rooms.forEach(function (r) { r.items.forEach(function (it) { if (H.domainOf(it.id) === 'light') allLights.push(it.id); }); });
  var itemById = {}, roomOf = {};
  rooms.forEach(function (r) { r.items.forEach(function (it) { itemById[it.id] = it; roomOf[it.id] = r; }); });

  var V = {
    el: null, ov: {}, timers: {}, seq: 0, widgets: [], byId: {}, layout: '', drag: null, sheet: null, tick: null,
    sendTemp: H.debounce(function () { sendPending(climate.id); }, TEMP_DEBOUNCE_MS),
  };
  var esc = function (s) { return App.esc(s == null ? '' : s); };
  var unit = function () { return ha().unit || '°C'; };
  var disp = HOME.tempUnit === 'F' ? 'F' : 'C';
  var deg = function (v) { return v == null ? '–' : String(v).replace('.0', '') + '°'; };

  // ------------------------------------------------------------ overlays and service calls
  function mergedState(id) { return H.merged(states()[id], V.ov[id]); }
  function setOv(id, ov, merge) {
    var old = V.ov[id];
    if (merge && old) ov = { on: ov.on != null ? ov.on : old.on, state: ov.state != null ? ov.state : old.state, attributes: Object.assign({}, old.attributes, ov.attributes) };
    V.ov[id] = Object.assign({}, ov, { token: ++V.seq, sent: false });
  }
  function drop(id) {
    delete V.ov[id];
    clearTimeout(V.timers[id]);
    delete V.timers[id];
  }
  // Paint now, call HA now (or after a debounce: then sendPending() does the call).
  function act(ids, a, opts) {
    ids = [].concat(ids);
    ids.forEach(function (id) { setOv(id, a.ov, a.merge); V.ov[id].call = a; });
    sync(ids);
    if (!(opts && opts.later)) send(ids, a);
  }
  function sendPending(id) {
    var o = V.ov[id];
    if (o && o.call && !o.sent) send([id], o.call);
  }
  function send(ids, a) {
    var tokens = {};
    ids.forEach(function (id) {
      var o = V.ov[id];
      if (!o) return;
      o.sent = true;
      tokens[id] = o.token;
      clearTimeout(V.timers[id]);
      V.timers[id] = setTimeout(function () { recheck(id, o.token); }, CONFIRM_MS);
    });
    var mine = function (id) { return V.ov[id] && V.ov[id].token === tokens[id]; };
    if (!ha().call) { ids.forEach(drop); sync(ids); return; }
    ha().call('POST', H.servicePath(a), a.data).then(function (changed) {
      // HA answers with the states the call changed: often the confirmation itself.
      take(Array.isArray(changed) ? changed : []);
    }, function (err) {
      var mineIds = ids.filter(mine);
      mineIds.forEach(drop);
      sync(mineIds);
      var who = ids.length === 1 ? nameOf(ids[0]) : ids.length + ' devices';
      App.toast('Couldn’t reach <b>' + esc(who) + '</b> · ' + esc(err && err.message || 'Home Assistant error'), { tone: 'error', icon: 'bolt' });
    });
  }
  // Newer states from a call or a refetch → App.ha.states, then the usual 'ha' event.
  function stamp(e) { var t = e && Date.parse(e.last_updated); return isFinite(t) ? t : 0; }
  function take(list) {
    var s = states(), ids = [];
    list.forEach(function (e) {
      if (!e || !e.entity_id) return;
      var cur = s[e.entity_id];
      if (cur && stamp(cur) > stamp(e)) return;
      if (!e.attributes) e.attributes = (cur && cur.attributes) || {};
      s[e.entity_id] = e;
      ids.push(e.entity_id);
    });
    if (ids.length) App.emit('ha', ids);
  }
  // No confirmation in time: fetch the entity and let HA's state win.
  function recheck(id, token) {
    var still = function () { return V.ov[id] && V.ov[id].token === token; };
    if (!still()) return;
    ha().call('GET', '/api/states/' + id).then(function (e) { take([e]); }, function () {}).then(function () {
      if (!still()) return;
      drop(id);
      sync([id]);
    });
  }
  App.on('ha', function (ids) {
    ids = ids || [];
    ids.forEach(function (id) {
      var o = V.ov[id];
      if (o && o.sent && H.settled(states()[id], o)) drop(id);
    });
    if (V.el && App.onScreen('control')) sync(ids);
  });

  function nameOf(id) {
    var it = itemById[id] || (climate && climate.id === id && climate) || players.filter(function (p) { return p.id === id; })[0];
    var e = states()[id];
    return (it && it.name) || (e && e.attributes.friendly_name) || id;
  }
  function tileOf(id) { var it = itemById[id]; return it ? H.tileModel(it, states()[id], V.ov[id], roomOf[id].name) : null; }

  // ------------------------------------------------------------ widgets
  // A widget: an element, the entity ids it shows, and a render() → { sig, html, cls?, k? }. Only a
  // changed sig touches the DOM.
  function paintWidget(w) {
    if (V.drag && w.el.contains(V.drag.el)) { w.stale = true; return; }
    var r = w.render();
    if (r.sig === w.sig) return;
    w.sig = r.sig;
    if (r.cls != null) w.el.className = r.cls;
    if (r.k != null) w.el.style.setProperty('--k', r.k);
    if (r.html != null) w.el.innerHTML = r.html;
  }
  function sync(ids) {
    if (!V.el) return;
    if (layoutKey() !== V.layout) { build(); return; }
    var seen = [];
    (ids ? ids.reduce(function (acc, id) { return acc.concat(V.byId[id] || []); }, []) : V.widgets).forEach(function (w) {
      if (seen.indexOf(w) > -1) return;
      seen.push(w);
      paintWidget(w);
    });
    if (V.sheet && (!ids || ids.indexOf(V.sheet.id) > -1)) paintSheet();
  }
  function addWidget(el, deps, render) {
    var w = { el: el, deps: deps, render: render, sig: null };
    V.widgets.push(w);
    deps.forEach(function (id) { (V.byId[id] = V.byId[id] || []).push(w); });
    return w;
  }

  function tileRender(id) {
    return function () {
      var t = tileOf(id);
      if (!t) return { sig: '-', html: '' };
      var cls = 'ct-tile ct-tile--' + t.kind + (t.on ? ' is-on' : '') + (t.offline ? ' is-offline' : '') + (t.busy ? ' is-busy' : '') + (t.dim ? ' is-dim' : '');
      var k = (t.level / 100).toFixed(2);
      var html = '<span class="ct-fill"></span><i class="ct-busy"></i>' +
        '<span class="ct-ico">' + App.icon(t.icon, 30) + '</span>' +
        '<span class="ct-name">' + esc(t.name) + '</span>' +
        '<span class="ct-val num">' + esc(t.text) + '</span>';
      return { sig: cls + k + html, cls: cls, k: k, html: html };
    };
  }
  function roomCount(r) {
    return function () {
      var on = r.items.filter(function (it) { var t = tileOf(it.id); return t && t.on; }).length;
      var html = on ? on + ' on' : '';
      return { sig: html, html: html };
    };
  }

  function insideRender() {
    var c = climate && H.climateModel(states()[climate.id], null, unit(), disp);
    var html = c && c.current != null
      ? App.icon('thermo', 26) + '<span><b class="num">' + deg(c.current) + '</b>' + (c.humidity != null ? '<small>' + c.humidity + '% humidity</small>' : '<small>Inside</small>') + '</span>'
      : '';
    return { sig: html, html: html, cls: 'ct-stat' + (html ? '' : ' is-empty') };
  }
  function outsideRender() {
    var w = null;
    try { w = window.DATA && window.DATA.weather && App.weatherNow(); } catch (e) { w = null; }
    var html = w && w.temp != null
      ? App.icon(w.cond || 'cloud', 26) + '<span><b class="num">' + Math.round(w.temp) + '°</b><small>Outside</small></span>'
      : '';
    return { sig: html, html: html, cls: 'ct-stat' + (html ? '' : ' is-empty') };
  }
  function peopleRender() {
    var html = people.map(function (it) {
      var p = H.presence(it, states()[it.id]);
      if (!p) return '';
      return '<span class="ct-person' + (p.home ? ' is-home' : '') + '"><i>' + esc(p.name.charAt(0)) + '</i><span>' + esc(p.name) + '<small>' + esc(p.where) + '</small></span></span>';
    }).join('');
    return { sig: html, html: html };
  }
  function allOffRender() {
    var n = H.lightsOn(allLights, states(), V.ov).length;
    var html = App.icon('bulb', 26) + '<span><b class="num">' + n + '</b><small>' + (n === 1 ? 'light on' : 'lights on') + '</small></span>' +
      '<span class="ct-alloff-btn">All off</span>';
    return { sig: html, html: html, cls: 'ct-stat ct-alloff' + (n ? ' is-on' : '') };
  }

  function climateRender() {
    var e = climate && states()[climate.id];
    var c = e && H.climateModel(e, V.ov[climate.id], unit(), disp);
    if (!c) return { sig: '', html: '', cls: 'ct-clim is-empty' };
    var action = { heating: 'Heating', cooling: 'Cooling', idle: 'Idle', off: 'Off', fan: 'Fan' }[c.action] || '';
    var setter = function (key, v, label) {
      return '<div class="ct-th' + (label ? ' ct-th--dual' : '') + '"><button class="ct-th-btn" data-act="temp" data-k="' + key + '" data-dir="-1" aria-label="Lower">' + App.icon('minus', 34) + '</button>' +
        '<div class="ct-th-set"><b class="num">' + deg(v) + '</b><small>' + (label || 'Set to') + '</small></div>' +
        '<button class="ct-th-btn" data-act="temp" data-k="' + key + '" data-dir="1" aria-label="Raise">' + App.icon('plus', 34) + '</button></div>';
    };
    var body = c.offline ? '<div class="ct-th"><div class="ct-th-set"><b class="ct-th-off">Offline</b></div></div>'
      : c.mode === 'off' ? '<div class="ct-th"><div class="ct-th-set"><b class="ct-th-off">Off</b><small>Inside ' + deg(c.current) + '</small></div></div>'
      : c.dual ? setter('target_temp_low', c.low, 'Heat to') + setter('target_temp_high', c.high, 'Cool to')
      : setter('temperature', c.target);
    var html = '<div class="ct-card-h"><span class="label label--light">' + esc(climate.name || 'Thermostat') + '</span><i class="ct-busy"></i>' +
      (action && c.mode !== 'off' ? '<span class="ct-verb ct-verb--' + esc(c.action) + '">' + action + '</span>' : '') + '</div>' + body +
      (c.offline ? '' : '<div class="ct-modes">' + c.modes.map(function (m) {
        return '<button class="' + (c.mode === m ? 'is-on' : '') + '" data-act="mode" data-v="' + m + '">' + H.MODE_LABEL[m] + '</button>';
      }).join('') + (c.hasEco ? '<button class="ct-eco' + (c.eco ? ' is-on' : '') + '" data-act="eco" aria-label="Eco">' + App.icon('leaf', 22) + '</button>' : '') + '</div>');
    var cls = 'ct-clim' + (c.busy ? ' is-busy' : '') + (c.offline ? ' is-offline' : '');
    return { sig: cls + html, cls: cls, html: html };
  }

  function mediaRender() {
    var it = H.pickPlayer(players, states());
    var m = it && H.mediaModel(it, states()[it.id], V.ov[it.id]);
    if (!m) return { sig: '', html: '', cls: 'ct-media is-empty' };
    V.mediaId = m.id;
    var b = function (what, icon, size, on) { return '<button class="ct-m-btn' + (on ? ' ct-m-btn--main' : '') + '" data-act="media" data-v="' + what + '" aria-label="' + what + '">' + App.icon(icon, size) + '</button>'; };
    var html = '<div class="ct-card-h"><span class="label">' + esc(m.name) + ' · ' + esc(m.stateText) + '</span><i class="ct-busy"></i></div>' +
      '<b class="ct-m-title">' + esc(m.title || (m.offline ? 'Offline' : 'Nothing playing')) + '</b>' +
      '<span class="ct-m-sub">' + esc(m.sub) + '</span>' +
      (m.offline ? '' : '<div class="ct-m-ctl">' +
        (m.canPrev ? b('prev', 'prev', 26) : '') + (m.canPlay ? b('play', m.playing ? 'pause' : 'play', 32, true) : '') + (m.canNext ? b('next', 'next', 26) : '') +
        (m.canMute ? '<span class="ct-m-gap"></span>' + b('mute', m.muted ? 'mute' : 'vol', 26) : '') + '</div>') +
      (m.canVol && m.volume != null ? slider('vol', m.id, m.muted ? 0 : m.volume, m.muted ? 'Muted' : 'Volume ' + m.volume + '%') : '');
    var cls = 'ct-media' + (m.busy ? ' is-busy' : '') + (m.playing ? ' is-playing' : '');
    return { sig: cls + html, cls: cls, html: html };
  }
  function slider(kind, id, level, label, big) {
    return '<div class="ct-slider' + (big ? ' ct-slider--big' : '') + '" data-slider="' + kind + '" data-id="' + id + '" style="--k:' + (level / 100).toFixed(2) + '">' +
      '<span class="ct-sl-fill"></span><span class="ct-sl-val num">' + esc(label) + '</span></div>';
  }

  // Connection banner: no HA here, still connecting, or no fresh state for a while.
  function connState() {
    var h = ha();
    if (!h.ready) return h.web ? 'signin' : 'none';
    if (!h.updated) return Date.now() - BOOT > STALE_MS / 2 ? 'down' : 'connecting';
    var live = h.isLive ? h.isLive() : h.live;
    if (!live && Date.now() - h.updated > STALE_MS) return 'stale';
    return 'ok';
  }
  function bannerRender() {
    var s = connState(), h = ha(), html = '';
    if (s === 'signin') html = App.icon('bolt', 26) + '<span><b>Sign in to Home Assistant</b> to control the house from here.</span><button class="btn btn--solid" data-act="signin">Sign in</button>';
    else if (s === 'none') html = App.icon('bolt', 26) + '<span><b>Home Assistant isn’t connected</b> on this screen.</span>';
    else if (s === 'connecting') html = App.icon('bolt', 26) + '<span><b>Connecting to Home Assistant…</b></span>';
    else if (s === 'down') html = App.icon('bolt', 26) + '<span><b>Can’t reach Home Assistant</b> · retrying every 15 seconds</span>';
    else if (s === 'stale') html = App.icon('bolt', 26) + '<span><b>Can’t reach Home Assistant</b> · last update ' + esc(App.fmt.mins((Date.now() - h.updated) / 60000)) + ' ago</span>';
    V.el.classList.toggle('is-stale', s === 'stale' || s === 'down');
    return { sig: s + html, html: html, cls: 'ct-banner' + (html ? ' is-shown ct-banner--' + s : '') };
  }

  // ------------------------------------------------------------ layout
  // Which configured entities HA has: the rooms are rebuilt only when that changes.
  function layoutKey() {
    var s = states();
    return rooms.map(function (r) { return r.items.filter(function (it) { return s[it.id]; }).map(function (it) { return it.id; }).join(','); }).join('|');
  }
  function build() {
    var el = V.el, s = states();
    V.layout = layoutKey();
    V.widgets = []; V.byId = {};
    var roomsHtml = rooms.map(function (r, i) {
      var items = r.items.filter(function (it) { return s[it.id]; });
      if (!items.length) return '';
      return '<section class="ct-room" data-n="' + Math.min(items.length, 4) + '" style="--n:' + Math.min(items.length, 4) + '"><div class="ct-room-h"><h3>' + esc(r.name) + '</h3><span class="label" data-room="' + i + '"></span></div>' +
        '<div class="ct-tiles">' + items.map(function (it) { return '<div class="ct-tile" data-id="' + it.id + '"></div>'; }).join('') + '</div></section>';
    }).join('');
    el.innerHTML = '<div class="ct">' +
      '<div class="ct-bar"><div data-w="inside"></div><div data-w="outside"></div><div class="ct-people" data-w="people"></div><button data-w="alloff" data-act="alloff"></button></div>' +
      '<div data-w="banner"></div>' +
      '<div class="ct-main"><div class="ct-rooms">' + (roomsHtml || (ha().updated ? '<p class="ct-none">None of the devices in js/homecfg.js are in Home Assistant.</p>' : '')) + '</div>' +
      '<div class="ct-side"><div data-w="climate"></div><div data-w="media"></div></div></div></div>';
    var q = function (sel) { return el.querySelector(sel); };
    addWidget(q('[data-w="banner"]'), [], bannerRender);
    addWidget(q('[data-w="inside"]'), climate ? [climate.id] : [], insideRender);
    addWidget(q('[data-w="outside"]'), [], outsideRender);
    addWidget(q('[data-w="people"]'), people.map(function (p) { return p.id; }), peopleRender);
    addWidget(q('[data-w="alloff"]'), allLights, allOffRender);
    addWidget(q('[data-w="climate"]'), climate ? [climate.id] : [], climateRender);
    addWidget(q('[data-w="media"]'), players.map(function (p) { return p.id; }), mediaRender);
    App.$$('.ct-tile', el).forEach(function (t) { addWidget(t, [t.dataset.id], tileRender(t.dataset.id)); });
    rooms.forEach(function (r, i) {
      var c = q('[data-room="' + i + '"]');
      if (c) addWidget(c, r.items.map(function (it) { return it.id; }), roomCount(r));
    });
    V.widgets.forEach(paintWidget);
  }

  // ------------------------------------------------------------ gestures
  // Tiles: tap toggles; a sideways drag sets the level (sent on release); holding opens the sheet.
  // Sliders (volume, the sheet's level): drag or tap anywhere on the track. touch-action: pan-y on
  // tiles keeps vertical scrolling (phones) with the browser, which then cancels the pointer.
  function onDown(e) {
    if (e.button > 0 || V.drag) return;
    var sl = e.target.closest('[data-slider]');
    if (sl) return sliderDown(e, sl);
    var tile = e.target.closest('.ct-tile[data-id]');
    if (!tile || tile.classList.contains('is-offline')) return;
    var t = tileOf(tile.dataset.id);
    if (!t) return;
    var d = V.drag = { el: tile, id: t.id, t: t, x: e.clientX, y: e.clientY, mode: 'tap', w: tile.getBoundingClientRect().width, level: t.level, pid: e.pointerId };
    tile.classList.add('is-press');
    if (t.dim || t.presets.length) {
      d.hold = setTimeout(function () {
        if (V.drag !== d || d.mode !== 'tap') return;
        endDrag();
        openSheet(t.id);
      }, HOLD_MS);
    }
  }
  function sliderDown(e, sl) {
    var d = V.drag = { el: sl, id: sl.dataset.id, kind: sl.dataset.slider, mode: 'slide', r: sl.getBoundingClientRect(), pid: e.pointerId };
    try { sl.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    sl.classList.add('is-drag');
    slideTo(d, e.clientX);
    e.preventDefault();
  }
  function slideTo(d, x) {
    d.level = Math.round(H.clamp((x - d.r.left) / d.r.width * 100, 0, 100));
    d.el.style.setProperty('--k', (d.level / 100).toFixed(2));
    var v = d.el.querySelector('.ct-sl-val');
    if (v) v.textContent = d.kind === 'vol' ? 'Volume ' + d.level + '%' : d.level ? d.level + '%' : 'Off';
  }
  function onMove(e) {
    var d = V.drag;
    if (!d || e.pointerId !== d.pid) return;
    if (d.mode === 'slide') { slideTo(d, e.clientX); return; }
    var dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.mode === 'tap') {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { endDrag(); return; } // a scroll
      if (Math.abs(dx) < 12) return;
      if (!d.t.dim) { endDrag(); return; }
      d.mode = 'level';
      clearTimeout(d.hold);
      try { d.el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      d.el.classList.add('is-drag');
      d.x0 = e.clientX;
    }
    var lvl = Math.round(H.clamp(d.level + (e.clientX - d.x0) / d.w * 100, 0, 100));
    if (d.t.kind === 'fan') lvl = H.snapLevel(lvl, d.t.step);
    d.out = lvl;
    d.el.style.setProperty('--k', (lvl / 100).toFixed(2));
    d.el.classList.toggle('is-on', lvl > 0);
    var v = d.el.querySelector('.ct-val');
    if (v) v.textContent = lvl ? lvl + '%' : 'Off';
  }
  function endDrag() {
    var d = V.drag;
    if (!d) return null;
    V.drag = null;
    clearTimeout(d.hold);
    d.el.classList.remove('is-press', 'is-drag');
    var dirty = V.widgets.filter(function (w) { return w.stale; });
    dirty.forEach(function (w) { w.stale = false; w.sig = null; paintWidget(w); });
    return d;
  }
  function onUp(e) {
    var d = V.drag;
    if (!d || e.pointerId !== d.pid) return;
    endDrag();
    if (d.mode === 'slide') {
      if (d.kind === 'vol') {
        var m = H.mediaModel({}, states()[d.id], V.ov[d.id]);
        if (m) act(d.id, H.mediaAction(m, 'vol', null, d.level));
      } else {
        var t = tileOf(d.id);
        if (t) act(d.id, H.levelAction(t, t.kind === 'fan' ? H.snapLevel(d.level, t.step) : d.level));
      }
    } else if (d.mode === 'level') {
      if (d.out != null && d.out !== d.t.level) act(d.id, H.levelAction(d.t, d.out));
      else sync([d.id]);
    } else act(d.id, H.toggleAction(tileOf(d.id) || d.t));
  }
  function onCancel(e) {
    var d = V.drag;
    if (!d || e.pointerId !== d.pid) return;
    endDrag();
    var w = V.byId[d.id] || [];
    w.forEach(function (x) { x.sig = null; });
    sync([d.id]);
    if (V.sheet) paintSheet();
  }

  function onClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var k = b.dataset.act, v = b.dataset.v;
    if (V.el && V.el.classList.contains('is-stale') && k !== 'signin') App.toast('Home Assistant isn’t answering · trying anyway', { icon: 'bolt', ms: 2500 });
    if (k === 'alloff') return allOff();
    if (k === 'signin') return ha().web && ha().web.signIn();
    if (k === 'temp') {
      var e1 = mergedState(climate.id);
      if (!e1) return;
      var a = H.tempAction(e1, b.dataset.k, H.stepTemp(e1, b.dataset.k, +b.dataset.dir, unit()));
      act(climate.id, a, { later: true });
      V.sendTemp();
      return;
    }
    if (k === 'mode') { V.sendTemp.flush(); return act(climate.id, H.modeAction(climate.id, v)); }
    if (k === 'eco') { var c = H.climateModel(states()[climate.id], V.ov[climate.id], unit(), disp); return act(climate.id, H.ecoAction(climate.id, !c.eco)); }
    if (k === 'media') {
      var id = V.mediaId, m = id && H.mediaModel({}, states()[id], V.ov[id]);
      if (m) act(id, H.mediaAction(m, v, states()[id]));
      return;
    }
    var sid = V.sheet && V.sheet.id, t = sid && tileOf(sid);
    if (!t) return;
    if (k === 'lvl') act(sid, H.levelAction(t, +v));
    else if (k === 'warm') act(sid, H.warmthAction(states()[sid], +v));
    else if (k === 'preset') act(sid, H.presetAction(t, v));
    else if (k === 'power') act(sid, H.toggleAction(t));
  }

  function allOff() {
    var ids = H.lightsOn(allLights, states(), V.ov);
    if (!ids.length) { App.toast('All the lights are off', { icon: 'bulb', ms: 2000 }); return; }
    act(ids, { domain: 'light', service: 'turn_off', data: { entity_id: ids }, ov: { on: false } });
    App.toast('Turned off ' + ids.length + (ids.length === 1 ? ' light' : ' lights'), {
      icon: 'bulb', undo: function () { act(ids, { domain: 'light', service: 'turn_on', data: { entity_id: ids }, ov: { on: true } }); },
    });
  }

  // ------------------------------------------------------------ sheet (press and hold a tile)
  function sheetHtml(id) {
    var t = tileOf(id), e = states()[id];
    if (!t) return '';
    var chips = function (list) { return '<div class="ct-chips">' + list.join('') + '</div>'; };
    var chip = function (actName, v, label, on) { return '<button class="' + (on ? 'is-on' : '') + '" data-act="' + actName + '" data-v="' + esc(v) + '">' + esc(label) + '</button>'; };
    var html = '<div class="label">' + esc(roomOf[id].name) + '</div><h2 class="serif sheet-h">' + esc(t.name) + '<i class="ct-busy' + (t.busy ? ' is-on' : '') + '"></i></h2>';
    if (t.offline) return html + '<p class="sheet-p">Offline · Home Assistant can’t reach it right now.</p>';
    if (t.dim) html += slider('level', id, t.level, t.level ? t.level + '%' : 'Off', true);
    if (t.kind === 'light') {
      html += chips([chip('power', '', t.on ? 'Turn off' : 'Turn on', t.on)].concat(t.dim ? [10, 25, 50, 75, 100].map(function (p) { return chip('lvl', p, p + '%', t.on && t.level === p); }) : []));
      if (H.hasColorTemp(e.attributes)) {
        var kNow = t.on && H.merged(e, V.ov[id]).attributes.color_temp_kelvin;
        html += '<div class="label ct-sheet-l">Warmth</div>' + chips(H.WARMTH.map(function (w) { return chip('warm', w[1], w[0], kNow && Math.abs(kNow - w[1]) < 250); }));
      }
    } else if (t.kind === 'fan') {
      var a = H.merged(e, V.ov[id]).attributes;
      html += chips([chip('power', '', t.on ? 'Turn off' : 'Turn on', t.on)].concat(t.presets.map(function (p) { return chip('preset', p, p, t.on && a.preset_mode === p); })));
    }
    return html;
  }
  function paintSheet() {
    if (!V.sheet || (V.drag && V.sheet.box.contains(V.drag.el))) return;
    var html = sheetHtml(V.sheet.id);
    if (html !== V.sheet.html) { V.sheet.html = html; V.sheet.box.innerHTML = html; }
  }
  function openSheet(id) {
    App.sheet('<div class="sheet-pad ct-sheet"></div>', {
      cls: 'ct-sheet-wrap',
      onClose: function () { V.sheet = null; if (V.drag) endDrag(); },
      onMount: function (s) {
        V.sheet = { id: id, box: s.querySelector('.ct-sheet'), html: '' };
        bindPointer(s);
        s.addEventListener('click', onClick);
        paintSheet();
      },
    });
  }
  function bindPointer(el) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  }

  // ------------------------------------------------------------ view
  function startTick() {
    clearInterval(V.tick);
    // Only the banner (HA gone quiet?) and the outside temperature need a clock.
    V.tick = setInterval(function () {
      if (!App.onScreen('control')) return;
      V.widgets.slice(0, 3).forEach(paintWidget);
    }, TICK_MS);
  }
  function stopTick() { clearInterval(V.tick); V.tick = null; }

  App.register('control', {
    show: function (el) {
      if (V.el !== el) {
        V.el = el;
        bindPointer(el);
        el.addEventListener('click', onClick);
        el.addEventListener('contextmenu', function (e) { if (e.target.closest('.ct-tile, [data-slider]')) e.preventDefault(); });
        build();
      } else sync(null);
      startTick();
    },
    resume: function () { sync(null); startTick(); },
    hide: function () { stopTick(); if (V.drag) endDrag(); V.sendTemp.flush(); },
  });

  // Demo-drawer hooks (js/system.js) from the old demo Home tab: there are no locks, garage or
  // cameras in this house, so they only update the sample data or say so.
  var D = window.DATA;
  App.setDevice = function (id, patch) {
    var d = D && D.devices && D.devices.filter(function (x) { return x.id === id; })[0];
    if (d) Object.assign(d, patch);
  };
  App.openGarageSheet = function () { App.toast('No garage door is connected', { icon: 'garage', ms: 2500 }); };
  App.cameraSheet = function () { App.toast('No cameras are connected', { icon: 'camera', ms: 2500 }); };
})();
