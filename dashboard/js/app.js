// Core shell: router, demo clock, idle/ambient, toasts, sheets, helpers.
import { assetKey, decide, markApplied } from './update.js';

(function () {
  'use strict';
  var D = window.DATA;
  var App = window.App = { state: D, views: {}, current: null, mode: 'day', calMode: 'normal' };
  var $ = App.$ = function (s, r) { return (r || document).querySelector(s); };
  App.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ------------------------------------------------------------ events
  var handlers = {};
  App.on = function (e, fn) { (handlers[e] = handlers[e] || []).push(fn); };
  App.emit = function (e, a) { (handlers[e] || []).forEach(function (fn) { fn(a); }); };

  // ------------------------------------------------------------ time (demo clock)
  var offset = 0;
  App.now = function () { return new Date(Date.now() + offset); };
  App.setTime = function (h, m) {
    if (h == null) offset = 0;
    else { var d = new Date(); d.setHours(h, m, 0, 0); offset = d - Date.now(); }
    lastMin = -1;
    App.emit('time');
    App.rerender();
  };
  App.dayStart = function (d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  App.addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  App.sameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  // Sleep (black screen): from 10 PM until 6 AM, or 45 min before the night's first timed event if
  // that is earlier. Times use setHours, so DST nights keep 10 PM / 6 AM on the wall clock.
  App.sleepWindow = function (now) {
    var from = new Date(now);
    if (from.getHours() < 12) from = App.addDays(from, -1);
    from.setHours(22, 0, 0, 0);
    var to = App.addDays(from, 1);
    to.setHours(6, 0, 0, 0);
    App.events().forEach(function (ev) {
      if (ev.allDay) return;
      var w = new Date(+ev.start - 45 * 60000);
      if (w > from && w < to) to = w; // an event between 10 and 10:45 PM doesn't cancel the night
    });
    return { from: from, to: to };
  };
  App.isSleep = function (now) {
    now = now || App.now();
    var w = App.sleepWindow(now);
    return now >= w.from && now < w.to;
  };

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  App.fmt = {
    time: function (d, ampm) {
      var h = d.getHours(), m = d.getMinutes();
      var s = (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m;
      return ampm === false ? s : s + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    // "4 PM", "3:45 PM"
    hour: function (d) {
      var h = d.getHours(), m = d.getMinutes();
      return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    ampm: function (d) { return d.getHours() >= 12 ? 'PM' : 'AM'; },
    range: function (a, b) {
      var same = App.fmt.ampm(a) === App.fmt.ampm(b);
      return (same ? App.fmt.time(a, false) : App.fmt.time(a)) + ' – ' + App.fmt.time(b);
    },
    day: function (d) { return DAYS[d.getDay()]; },
    dayShort: function (d) { return DAYS[d.getDay()].slice(0, 3); },
    month: function (d) { return MONTHS[d.getMonth()]; },
    monthShort: function (d) { return MON_SHORT[d.getMonth()]; },
    mins: function (m) {
      m = Math.max(0, Math.round(m));
      if (m < 60) return m + ' min';
      var h = Math.floor(m / 60), r = m % 60;
      return h + ' hr' + (r ? ' ' + r + ' min' : '');
    },
    rel: function (d) {
      var t = App.dayStart(App.now()), x = App.dayStart(d), diff = Math.round((x - t) / 864e5);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
      return DAYS[d.getDay()];
    }
  };
  App.esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ------------------------------------------------------------ icons + people
  App.icon = function (name, size, cls) {
    size = size || 24;
    return '<svg class="i ' + (cls || '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (window.ICONS[name] || '') + '</svg>';
  };
  App.person = function (id) {
    if (id === 'family' || id === 'any') return D.family;
    for (var i = 0; i < D.people.length; i++) if (D.people[i].id === id) return D.people[i];
    return D.family;
  };
  App.pstyle = function (p) {
    if (typeof p === 'string') p = App.person(p);
    // Near-black "everyone" colour would vanish on the dark theme; use the light ink instead.
    if (App.theme === 'dark' && p.color === '#111111') return '--c:#EDE8DE;--c-rgb:237 232 222;--c-ink:#111111';
    return '--c:' + p.color + ';--c-rgb:' + p.rgb + ';--c-ink:' + p.ink;
  };
  App.avatar = function (p, size, cls) {
    if (typeof p === 'string') p = App.person(p);
    size = size || 48;
    return '<span class="avatar ' + (cls || '') + '" style="' + App.pstyle(p) + ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.46) + 'px">' + (p.id === 'family' ? '★' : p.name[0]) + '</span>';
  };
  App.dots = function (ids, size) {
    return '<span class="dots">' + ids.map(function (id) { return '<i style="' + App.pstyle(id) + (size ? ';width:' + size + 'px;height:' + size + 'px' : '') + '"></i>'; }).join('') + '</span>';
  };

  // ------------------------------------------------------------ calendar helpers
  App.events = function () {
    var list = D.events.slice();
    var today = App.dayStart(App.now());
    if (App.calMode === 'busy') list = list.concat(D.busyExtras);
    if (App.calMode === 'empty') list = list.filter(function (e) { return e.allDay || !App.sameDay(e.start, today); });
    return list;
  };
  App.isFamily = function (e) { return e.people.length >= D.people.length; };
  App.evColor = function (e) { return App.isFamily(e) ? D.family : App.person(e.people[0]); };
  App.timedOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return !ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    }).sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  };
  App.allDayOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    });
  };
  App.leaveBy = function (e) { return e.travel ? new Date(+e.start - e.travel * 60000) : e.start; };
  // The next thing someone needs to act on: earliest upcoming "leave by" today.
  App.nextEvent = function () {
    var now = App.now();
    var list = App.timedOn(now).filter(function (e) { return e.start > now; });
    list.sort(function (a, b) { return App.leaveBy(a) - App.leaveBy(b); });
    return list[0] || null;
  };
  App.findEvent = function (id) {
    return App.events().filter(function (e) { return e.id === id; })[0];
  };

  // ------------------------------------------------------------ chores + weather helpers
  App.currentRoutine = function () {
    var h = App.now().getHours();
    for (var i = 0; i < D.routines.length; i++) if (h >= D.routines[i].from && h < D.routines[i].to) return D.routines[i];
    return D.routines[2];
  };
  // Live weather is indexed by timestamp (W.time, unix seconds), so DST days with 23 or 25 hours
  // still line up; the sample data has no timestamps and is indexed by hour of day.
  function wxIndex(W, d) {
    if (!W.time) return d.getHours();
    var s = d / 1000, i = W.time.length - 1;
    while (i > 0 && W.time[i] > s) i--;
    return i;
  }
  function wxDate(W, i) { return W.time ? new Date(W.time[i] * 1000) : new Date(2000, 0, 1, i); }
  function wxDayEnd(W, d) {
    if (!W.time) return 24;
    var end = App.addDays(App.dayStart(d), 1) / 1000, i = 0;
    while (i < W.time.length && W.time[i] < end) i++;
    return i;
  }
  App.weatherNow = function () {
    var W = D.weather, now = App.now(), h = wxIndex(W, now), dayEnd = wxDayEnd(W, now);
    var rainAt = -1;
    for (var i = h; i < dayEnd; i++) if (W.p[i] >= 50) { rainAt = i; break; }
    var summary, advice, cool = 12;
    var wet = rainAt > -1 && W.c[rainAt] === 'snow' ? 'Snow' : 'Rain';
    if (rainAt === h) {
      var stop = h; while (stop < dayEnd && W.p[stop] >= 50) stop++;
      summary = wet + ' until ' + App.fmt.hour(wxDate(W, stop));
      advice = wet === 'Snow' ? 'Boots and a warm coat' : 'Umbrella weather';
    } else if (rainAt > -1) {
      summary = wet + ' from ' + App.fmt.hour(wxDate(W, rainAt));
      var soccer = App.timedOn(App.now()).filter(function (e) { return /soccer/i.test(e.title) && e.start > App.now(); })[0];
      advice = wet === 'Snow' ? 'Bring a warm coat' : soccer ? 'Pack a rain jacket for soccer' : 'Grab a rain jacket';
    } else {
      summary = W.t[h] < cool ? 'Clear and cool' : 'Dry all day';
      advice = W.t[h] < cool ? 'Jacket weather' : 'Light layers';
    }
    var labels = { sun: 'Sunny', moon: 'Clear', partly: 'Partly cloudy', cloud: 'Overcast', rain: 'Rain', snow: 'Snow' };
    return { temp: W.t[h], cond: W.c[h], label: labels[W.c[h]], hi: W.hi, lo: W.lo, summary: summary, advice: advice, hour: h };
  };
  App.hourly = function (count) {
    var W = D.weather, h = wxIndex(W, App.now()), out = [];
    for (var i = 0; i < count; i++) {
      // Live data covers today and tomorrow (48 hours); the sample data only has today's 24.
      var x = W.t[h + i] == null ? (h + i) % 24 : h + i, hr = W.time ? wxDate(W, x).getHours() : x % 24;
      out.push({ h: hr, t: W.t[x], c: W.c[x], p: W.p[x], label: i === 0 ? 'Now' : ((hr % 12 || 12) + (hr >= 12 ? 'p' : 'a')) });
    }
    return out;
  };

  // ------------------------------------------------------------ live weather (Open-Meteo, no key)
  // Home location from CONFIG; timezone=auto takes the zone from the coordinates. Unix timestamps rather than local times: Open-Meteo applies one
  // fixed UTC offset to the whole response, so its local times are an hour off after a DST change.
  var WX_URL = 'https://api.open-meteo.com/v1/forecast?latitude=' + window.CONFIG.lat + '&longitude=' + window.CONFIG.lon +
    '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&timeformat=unixtime&forecast_days=2';
  var WX_KEY = 'wx-' + window.CONFIG.lat + ',' + window.CONFIG.lon + '-c2';
  function wxCond(code, day) {
    if (code <= 1) return day ? 'sun' : 'moon';
    if (code === 2) return 'partly';
    if (code === 3 || code === 45 || code === 48) return 'cloud';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    return 'rain';
  }
  function applyWeather(j) {
    var H = j.hourly, R = Math.round;
    D.weather = {
      hi: R(j.daily.temperature_2m_max[0]), lo: R(j.daily.temperature_2m_min[0]),
      time: H.time,
      t: H.temperature_2m.map(R),
      c: H.weather_code.map(function (code, i) { return wxCond(code, H.is_day[i]); }),
      p: H.precipitation_probability.map(function (p) { return p || 0; })
    };
  }
  // Is the response's first day today? (Its midnight can be an hour off on DST days, so test noon.)
  function isToday(j) { return App.sameDay(new Date((j.daily.time[0] + 12 * 3600) * 1000), new Date()); }
  function loadWeather() {
    fetch(WX_URL).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
      if (!isToday(j)) return;
      applyWeather(j);
      try { localStorage.setItem(WX_KEY, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
      App.emit('data');
      App.rerender();
    }).catch(function (e) { console.warn('Weather fetch failed', e); });
  }
  App.startWeather = function () {
    try {
      var cached = JSON.parse(localStorage.getItem(WX_KEY) || 'null');
      if (cached && isToday(cached)) applyWeather(cached);
    } catch (e) { /* ignore a bad cache */ }
    loadWeather();
    setInterval(loadWeather, 15 * 60000);
  };

  // ------------------------------------------------------------ router
  App.register = function (name, view) { App.views[name] = view; };
  // Views are built once and kept laid out (hidden with content-visibility), so switching tabs
  // only has to paint. A view is rebuilt when its data changed ('data'/'time' events) or, for
  // time-sensitive views (minutely: true), when the minute has rolled over since it was built.
  function minuteKey() { return Math.floor(App.now().getTime() / 60000); }
  function build(name, opts) {
    var view = App.views[name];
    view.show($('#view-' + name), opts || {});
    view._built = true; view._dirty = false; view._min = minuteKey();
  }
  App.go = function (name, opts) {
    opts = opts || {};
    if (!App.views[name]) name = 'home';
    if (App.current && App.current !== name && App.views[App.current].hide) App.views[App.current].hide();
    App.$$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
    App.$$('.rail-item').forEach(function (b) { b.classList.toggle('is-active', b.dataset.go === name); });
    App.current = name;
    var view = App.views[name];
    if (!view._built || view._dirty || opts.rerender || (view.minutely && view._min !== minuteKey())) build(name, opts);
    else if (view.resume) view.resume($('#view-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  };
  // Build a hidden view and lay it out now (cached by content-visibility; no paint happens).
  function prebuild(name) {
    var el = $('#view-' + name), view = App.views[name];
    build(name);
    if (view.hide) view.hide();
    el.classList.add('is-warming');
    el.offsetHeight;
    el.classList.remove('is-warming');
  }
  // Pre-build (startup) and re-build (after data changes) hidden views in the background, one per
  // slot, so navigating to them never pays the rebuild cost.
  var refreshTimer = null;
  function refreshStale(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function next() {
      var name = Object.keys(App.views).filter(function (k) {
        var v = App.views[k];
        return k !== App.current && (!v._built || v._dirty);
      })[0];
      if (!name) return;
      prebuild(name);
      refreshTimer = setTimeout(next, 400);
    }, delay);
  }
  function markStale() {
    Object.keys(App.views).forEach(function (k) { if (k !== App.current) App.views[k]._dirty = true; });
    refreshStale(1500);
  }
  App.on('data', markStale);
  App.on('time', markStale);
  App.rerender = function () {
    if (App.current) App.views[App.current].show($('#view-' + App.current), { rerender: true });
  };

  App.categorize = function (name) {
    var n = name.toLowerCase();
    var hit = D.catalog.filter(function (c) { return c[0].toLowerCase() === n; })[0] ||
      D.catalog.filter(function (c) { var a = c[0].toLowerCase(); return a.indexOf(n) > -1 || n.indexOf(a) > -1; })[0] ||
      D.catalog.filter(function (c) { return n.split(/\s+/).some(function (w) { return w.length > 3 && c[0].toLowerCase().indexOf(w) > -1; }); })[0];
    return hit ? hit[1] : 'Other';
  };

  // ------------------------------------------------------------ toasts (single, with undo)
  var toastTimer;
  App.toast = function (html, opts) {
    opts = opts || {};
    var box = $('#toasts');
    box.innerHTML = '';
    clearTimeout(toastTimer);
    var ms = opts.ms || 5000;
    var t = document.createElement('div');
    t.className = 'toast' + (opts.tone ? ' toast--' + opts.tone : '');
    t.style.setProperty('--ms', ms + 'ms');
    t.innerHTML = (opts.icon ? App.icon(opts.icon, 26) : '') + '<span class="toast-msg">' + html + '</span>' +
      (opts.undo ? '<button class="toast-undo">' + App.icon('undo', 22) + 'Undo</button>' : '');
    box.appendChild(t);
    t.classList.add('is-in');
    function kill() { t.remove(); }
    toastTimer = setTimeout(kill, ms);
    if (opts.undo) t.querySelector('.toast-undo').addEventListener('click', function () { clearTimeout(toastTimer); opts.undo(); kill(); });
  };

  // ------------------------------------------------------------ sheets (modal cards)
  App.sheet = function (html, opts) {
    opts = opts || {};
    var layer = $('#sheetLayer');
    layer.innerHTML = '<div class="sheet-scrim"></div><div class="sheet ' + (opts.cls || '') + '">' +
      '<button class="sheet-x" data-close aria-label="Close">' + App.icon('x', 28) + '</button>' + html + '</div>';
    layer.classList.add('is-open');
    function close() {
      if (!layer.classList.contains('is-open')) return;
      layer.classList.remove('is-open');
      if (opts.onClose) opts.onClose();
      layer.innerHTML = '';
    }
    App.closeSheet = close;
    layer.querySelector('.sheet-scrim').addEventListener('click', close);
    App.$$('[data-close]', layer).forEach(function (b) { b.addEventListener('click', close); });
    if (opts.onMount) opts.onMount(layer.querySelector('.sheet'), close);
    return close;
  };
  App.closeSheet = function () {};

  // Stage-local coordinates for an element's center (stage may be scaled on desktop)
  App.centerOf = function (el) {
    var stage = $('#stage').getBoundingClientRect(), r = el.getBoundingClientRect(), k = App.stageScale();
    return { x: (r.left + r.width / 2 - stage.left) / k, y: (r.top + r.height / 2 - stage.top) / k };
  };

  // ------------------------------------------------------------ press-and-hold
  App.hold = function (el, ms, cb) {
    var t = null;
    el.style.setProperty('--hold', ms + 'ms');
    el.addEventListener('pointerdown', function () {
      if (cb.enabled && !cb.enabled()) return;
      el.classList.add('is-holding');
      t = setTimeout(function () { t = null; el.classList.remove('is-holding'); cb.done(); }, ms);
    });
    function cancel(e) {
      if (!t) return;
      clearTimeout(t); t = null;
      el.classList.remove('is-holding');
      if (cb.cancel && e.type === 'pointerup') cb.cancel();
    }
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
  };

  // ------------------------------------------------------------ modes: day / ambient / night
  App.setMode = function (m) {
    var stage = $('#stage');
    App.mode = m;
    stage.dataset.mode = m;
    App.emit('mode', m);
  };

  // ------------------------------------------------------------ idle
  App.idle = { home: 60, ambient: 120 };
  var idleSec = 0;
  function onIdleTick() {
    idleSec++;
    var blocked = $('#takeover').classList.contains('is-open');
    if (updatePending && idleSec >= 30 && !blocked && updateSafe()) { applyUpdate(); return; }
    var asleep = App.isSleep();
    if (!asleep && (App.mode === 'night' || App.mode === 'nightdash')) { App.setMode('day'); App.go('home'); return; }
    if (App.mode === 'nightdash' && idleSec >= 20) { App.setMode('night'); return; }
    if (asleep && !blocked && (App.mode === 'ambient' || (App.mode === 'day' && idleSec >= 60))) {
      App.closeSheet(); App.go('home'); App.setMode('night'); return;
    }
    if (App.mode !== 'day' || blocked) return;
    if (idleSec === App.idle.home && App.current !== 'home') { App.closeSheet(); App.go('home'); }
    if (idleSec >= App.idle.ambient) {
      App.closeSheet();
      App.go('home');
      App.setMode('ambient');
    }
  }
  App.resetIdle = function () { idleSec = 0; };

  // ------------------------------------------------------------ self-update (hosted builds)
  // A deploy changes the hashed /assets/ files index.html points at. Every 5 min, fetch index.html
  // and compare its asset set with this page's, both read by the same parser (js/update.js). A new
  // build must show up in two checks in a row, and is applied at most once per 6 h (persisted), so a
  // reload that lands on the old build again can't loop. Applied once nobody has touched the screen
  // for 30 s and no takeover, sheet, demo drawer or dog walk is open. UPDATE-FREEZE.md has the why.
  // No-op on the dev server (no /assets/ tags) and on the APK's bundled copy.
  var updatePending = null, updateState = { candidate: null, seen: 0 }, myAssets = '';
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function captureAssets() {
    myAssets = assetKey(App.$$('script[src], link[href]').map(function (n) { return n.outerHTML; }).join('\n'));
  }
  function checkUpdate() {
    if (location.hostname === '127.0.0.1') return; // bundled offline copy: updates come with the APK
    var storage = store();
    if (!myAssets || !storage) return;
    fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      // A redirect or non-HTML answer is a captive portal or an error page, not our index.html.
      var html = r.ok && !r.redirected && /text\/html/i.test(r.headers.get('Content-Type') || '');
      return html ? r.text() : '';
    }).then(function (html) {
      var live = assetKey(html);
      var verdict = decide(updateState, myAssets, live, storage, Date.now());
      updatePending = verdict === 'apply' ? live : null;
      if (verdict === 'blocked') console.warn('Update already tried in the last 6 h; not reloading again');
    }).catch(function () { /* offline: try again next time */ });
  }
  function updateSafe() {
    if ($('#sheetLayer').classList.contains('is-open') || $('#demo').classList.contains('is-open')) return false;
    return !(App.walk && App.walk.active);
  }
  function applyUpdate() {
    var key = updatePending, storage = store();
    updatePending = null;
    if (storage && markApplied(storage, key, Date.now())) location.reload();
  }

  // ------------------------------------------------------------ stage scaling
  // Landscape is designed at 1280×800. Screens wider than 16:10 (e.g. 1920×1080 frames) widen the
  // stage to their aspect instead of pillarboxing; narrower screens letterbox as before.
  // Portrait (the frame stood on its side; the kiosk follows the accelerometer) is designed at
  // 800×1280 and grows taller on narrower screens. css/portrait.css holds the portrait layouts.
  var SHORT = 800, LONG = 1280;
  App.portrait = false;
  App.stageW = LONG;
  App.stageH = SHORT;
  // Screen px per stage px (the stage is scaled on desktop browsers).
  App.stageScale = function () { return $('#stage').getBoundingClientRect().width / App.stageW || 1; };
  function fit() {
    var stage = $('#stage'), vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh) return;
    var portrait = vh > vw, w, h;
    if (portrait) { w = SHORT; h = Math.max(LONG, Math.round(SHORT * vh / vw)); }
    else { h = SHORT; w = Math.max(LONG, Math.round(SHORT * vw / vh)); }
    App.stageW = w; App.stageH = h;
    stage.style.setProperty('--stage-w', w + 'px');
    stage.style.setProperty('--stage-h', h + 'px');
    var s = Math.min(vw / w, vh / h);
    stage.style.transform = Math.abs(s - 1) < 0.01 ? '' : 'scale(' + s + ')';
    if (portrait === App.portrait && document.documentElement.dataset.orient) return;
    var flipped = !!document.documentElement.dataset.orient;
    App.portrait = portrait;
    document.documentElement.dataset.orient = portrait ? 'portrait' : 'landscape';
    if (!flipped) return;
    // Rotated: layouts that are measured or chosen in JS (hero title fit, slideshow layouts) are
    // rebuilt for the new shape.
    App.closeSheet();
    App.emit('orient', portrait);
    Object.keys(App.views).forEach(function (k) { if (App.views[k]._built) App.views[k]._dirty = true; });
    if (App.current) App.go(App.current, { rerender: true });
    refreshStale(1500);
  }

  // ------------------------------------------------------------ clock tick
  // Date-based; scheduled as a setTimeout chain aligned to the next whole second, so timer drift
  // never accumulates. lastMin is the absolute minute (not getMinutes()), so a stall of exactly an
  // hour still re-renders. A gap of over 90 s (frozen main thread, paused timers, NTP correction)
  // re-renders everything for the current time instead of waiting or reloading.
  var CLOCK_SET = Date.UTC(2026, 0, 1);
  var lastMin = -1, lastTick = Date.now(), tickTimer = null;
  function tick() {
    var real = Date.now();
    // Frames without an RTC boot at 1970 and jump forward when NTP syncs; reload once then, so
    // everything dated at load (caches, mock data) starts from the real date.
    if (lastTick < CLOCK_SET && real >= CLOCK_SET) { location.reload(); return; }
    var gap = Math.abs(real - lastTick);
    lastTick = real;
    if (gap > 90000) { lastMin = -1; App.emit('time'); App.rerender(); }
    var n = App.now(), min = Math.floor(n.getTime() / 60000);
    App.emit('second', n);
    if (min !== lastMin) {
      lastMin = min;
      $('#railClock').innerHTML = '<b>' + App.fmt.time(n, false) + '</b><span>' + App.fmt.ampm(n) + '</span>';
      App.emit('minute', n);
    }
    onIdleTick();
  }
  function tickLoop() {
    clearTimeout(tickTimer);
    try { tick(); } finally { tickTimer = setTimeout(tickLoop, 1000 - (Date.now() % 1000) + 5); }
  }

  // ------------------------------------------------------------ boot
  App.start = function () {
    App.startWeather();
    if (App.startCalendar) App.startCalendar();
    fit();
    window.addEventListener('resize', fit);
    // Switch tabs the instant a finger lands (pointerdown), not on release. Keyboard "clicks"
    // (detail === 0) still work.
    $('#rail').addEventListener('pointerdown', function (e) {
      var b = e.target.closest('[data-go]');
      if (b && e.button === 0) App.go(b.dataset.go);
    });
    $('#rail').addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]');
      if (b && e.detail === 0) App.go(b.dataset.go);
    });
    document.addEventListener('pointerdown', App.resetIdle, true);
    window.addEventListener('hashchange', function () { App.go(location.hash.slice(1)); });
    App.go(location.hash.slice(1) || 'home');
    try { sessionStorage.removeItem('selfheal'); } catch (e) { /* storage disabled */ }
    captureAssets();
    tickLoop();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickLoop(); });
    setInterval(checkUpdate, 5 * 60000);
    App.emit('ready');
    refreshStale(1500);
    setTimeout(function () { App.toast('Tip: press and hold the <b>clock</b> in the sidebar for demo controls', { ms: 6000, icon: 'bolt' }); }, 1200);
  };
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})();
