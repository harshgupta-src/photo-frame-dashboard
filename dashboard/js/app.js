// Core shell: router, demo clock, idle/ambient, toasts, sheets, helpers.
import { assetKey, decide, markApplied } from './update.js';
import { every } from './poll.js';

(function () {
  'use strict';
  var D = window.DATA;
  var App = window.App = { state: D, views: {}, current: null, mode: 'day', calMode: 'normal' };
  // The dashboard installed on a phone (IPHONE.md) rather than shown on the frame: no kiosk, a small
  // touch screen. Phones skip the wall-display behaviour (idle → ambient → sleep).
  // Dev only: /?sim=iphone fakes an iPhone home-screen app (insets, status bar) in a desktop browser.
  // /?sim=ipad fakes an iPad home-screen app the same way.
  var SIM = import.meta.env.DEV && (location.search.match(/[?&]sim=(iphone|ipad)/) || [])[1];
  var mm = function (q) { return !!(window.matchMedia && matchMedia(q).matches); };
  // A tablet (iPad, in Safari or from the home screen): touch, but too big for the phone layout.
  // It gets the frame's layouts, filled to its screen, without the wall-display behaviour.
  var ipad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  App.tablet = SIM ? SIM === 'ipad' : !window.HomeHQ && Math.min(screen.width, screen.height) >= 600 &&
    (ipad || mm('(pointer: coarse)'));
  App.phone = SIM ? SIM === 'iphone' : !window.HomeHQ && !App.tablet && (navigator.standalone === true ||
    mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') ||
    (mm('(pointer: coarse)') && Math.min(screen.width, screen.height) < 600));
  // Held in the hand rather than hung on the wall: no idle → ambient → sleep, update on resume.
  App.handheld = App.phone || App.tablet;
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
  // Asked every second by the idle loop: the answer for "now" is kept for the minute (it walks every
  // event), and recomputed early when the events or the demo clock change.
  var sleepMemo = { key: '', val: false };
  App.isSleep = function (now) {
    var key = now ? '' : Math.floor(Date.now() / 60000) + '|' + offset + '|' + App.calMode;
    if (key && key === sleepMemo.key) return sleepMemo.val;
    now = now || App.now();
    var w = App.sleepWindow(now), val = now >= w.from && now < w.to;
    if (key) sleepMemo = { key: key, val: val };
    return val;
  };
  function forgetSleep() { sleepMemo.key = ''; }

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
  // The next thing someone needs to act on: earliest upcoming "leave by" today (skipping the dog's
  // meals and walks while she's at a sitter).
  App.nextEvent = function () {
    var now = App.now();
    var away = App.dog && App.dog.away();
    var list = App.timedOn(now).filter(function (e) { return e.start > now && !(away && App.dog.hidden(e, away)); });
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
    var summary, advice, cool = 12, feels = W.f && W.f[h] != null ? W.f[h] : W.t[h];
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
      summary = feels < cool ? 'Clear and cool' : 'Dry all day';
      advice = feels < cool ? 'Jacket weather' : 'Light layers';
    }
    var labels = { sun: 'Sunny', moon: 'Clear', partly: 'Partly cloudy', cloud: 'Overcast', rain: 'Rain', snow: 'Snow' };
    return { temp: W.t[h], feels: feels, cond: W.c[h], label: labels[W.c[h]], hi: W.hi, lo: W.lo, summary: summary, advice: advice, hour: h };
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
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,is_day' +
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
      f: (H.apparent_temperature || H.temperature_2m).map(function (x, i) { return R(x == null ? H.temperature_2m[i] : x); }),
      c: H.weather_code.map(function (code, i) { return wxCond(code, H.is_day[i]); }),
      p: H.precipitation_probability.map(function (p) { return p || 0; })
    };
  }
  // Is the response's first day today? (Its midnight can be an hour off on DST days, so test noon.)
  function isToday(j) { return App.sameDay(new Date((j.daily.time[0] + 12 * 3600) * 1000), new Date()); }
  function loadWeather() {
    fetch(WX_URL).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
      if (!isToday(j)) return;
      var before = JSON.stringify(D.weather);
      applyWeather(j);
      try { localStorage.setItem(WX_KEY, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
      if (JSON.stringify(D.weather) === before) return; // unchanged: skip the redraw
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
    // Paused while hidden, caught up on return (an iPhone app back from the background shows fresh weather).
    every(15 * 60000, loadWeather);
  };

  // ------------------------------------------------------------ router
  App.register = function (name, view) { App.views[name] = view; };
  // A view is built the first time it's shown and then kept (hidden with content-visibility), so
  // going back to it only has to paint. While hidden it isn't touched: data and clock changes
  // ('data'/'time' events) only mark it dirty, and it's rebuilt when it's next shown. Time-sensitive
  // views (minutely: true) are also rebuilt when the minute has rolled over since they were built.
  // Views can have:
  //   hide()     stop timers/slideshows when it goes off screen (another tab, or ambient/night over it)
  //   resume(el) start them again when it comes back without a rebuild
  //   release(el) let go of images and heavy DOM; it's then rebuilt (show) on the next visit.
  //              Called when leaving a view marked heavy: true, and for every view at night.
  // Nothing else is pre-built: a hidden view costs no layout, style or image memory on the frame.
  function minuteKey() { return Math.floor(App.now().getTime() / 60000); }
  // Ambient (the photo overlay) and night (black) cover the dashboard: the view underneath is paused.
  function covered() { return App.mode === 'ambient' || App.mode === 'night'; }
  // Is this view what's on screen right now? Event handlers use it to skip DOM work for hidden views.
  App.onScreen = function (name) { return App.current === name && !covered(); };
  function build(name, opts) {
    var view = App.views[name];
    view.show($('#view-' + name), opts || {});
    view._built = true; view._dirty = false; view._min = minuteKey();
  }
  function stale(view) { return !view._built || view._dirty || (view.minutely && view._min !== minuteKey()); }
  function release(name) {
    var view = App.views[name];
    if (!view._built || !view.release) return;
    view.release($('#view-' + name));
    view._dirty = true;
  }
  App.go = function (name, opts) {
    opts = opts || {};
    if (!App.views[name]) name = 'home';
    var prev = App.current;
    if (prev && prev !== name) {
      // Leaving a half-typed field: drop the soft keyboard with it (and let the frame idle again).
      var focused = document.activeElement;
      if (focused && focused.closest && focused.closest('#view-' + prev)) focused.blur();
      if (App.views[prev].hide) App.views[prev].hide();
      if (App.views[prev].heavy) release(prev);
    }
    App.$$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
    App.$$('.rail-item').forEach(function (b) { b.classList.toggle('is-active', b.dataset.go === name); });
    App.current = name;
    var view = App.views[name];
    if (covered()) view._dirty = true; // (re)built when the overlay goes away
    else if (opts.rerender || stale(view)) build(name, opts);
    else if (view.resume) view.resume($('#view-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  };
  // Hidden views are rebuilt when next shown; so is the current one if an overlay covers it.
  function markStale() {
    forgetSleep();
    Object.keys(App.views).forEach(function (k) {
      if (App.views[k]._built && !App.onScreen(k)) App.views[k]._dirty = true;
    });
  }
  App.on('data', markStale);
  App.on('time', markStale);
  App.rerender = function () {
    if (!App.current) return;
    if (covered()) { App.views[App.current]._dirty = true; return; }
    App.views[App.current].show($('#view-' + App.current), { rerender: true });
  };
  // Drop the images and heavy DOM of every view that isn't on screen (photo slideshows, the dog
  // view's map tiles, camera snapshots…); they come back when the view is shown again. Done
  // automatically at night; callable any time memory is short.
  App.releaseImages = function () {
    Object.keys(App.views).forEach(function (k) {
      if (!App.onScreen(k)) { if (k === App.current && App.views[k].hide) App.views[k].hide(); release(k); }
    });
    App.emit('release');
  };
  // Android onTrimMemory (via window.frameMemory): RUNNING_LOW (10) and worse → let go of images now.
  App.on('memory', function (level) { if (level >= 10) App.releaseImages(); });
  // Covered by ambient/night: pause the view underneath (night also releases its images). Uncovered:
  // bring it up to date and start it again.
  var wasCovered = false;
  function modeChanged() {
    var now = covered(), view = App.current && App.views[App.current];
    if (!view) { wasCovered = now; return; }
    if (now && !wasCovered && view.hide) view.hide();
    if (App.mode === 'night') App.releaseImages();
    if (!now && wasCovered) {
      if (stale(view)) build(App.current);
      else if (view.resume) view.resume($('#view-' + App.current));
    }
    wasCovered = now;
  }

  App.categorize = function (name) {
    var n = name.toLowerCase();
    var hit = D.catalog.filter(function (c) { return c[0].toLowerCase() === n; })[0] ||
      D.catalog.filter(function (c) { var a = c[0].toLowerCase(); return a.indexOf(n) > -1 || n.indexOf(a) > -1; })[0] ||
      D.catalog.filter(function (c) { return n.split(/\s+/).some(function (w) { return w.length > 3 && c[0].toLowerCase().indexOf(w) > -1; }); })[0];
    return hit ? hit[1] : 'Other';
  };

  // ------------------------------------------------------------ toasts (with undo)
  // A new toast replaces plain ones but stacks above any still offering Undo (up to 3), so
  // deleting two things in a row leaves both undoable.
  var TOAST_MAX = 3;
  App.toast = function (html, opts) {
    opts = opts || {};
    var box = $('#toasts');
    Array.prototype.slice.call(box.children).forEach(function (old) { if (!old._undo) old._kill(); });
    while (box.children.length >= TOAST_MAX) box.firstChild._kill();
    var ms = opts.ms || 5000;
    var t = document.createElement('div');
    t.className = 'toast' + (opts.tone ? ' toast--' + opts.tone : '');
    t.style.setProperty('--ms', ms + 'ms');
    t.innerHTML = (opts.icon ? App.icon(opts.icon, 26) : '') + '<span class="toast-msg">' + html + '</span>' +
      (opts.undo ? '<button class="toast-undo">' + App.icon('undo', 22) + 'Undo</button>' : '');
    box.appendChild(t);
    t.classList.add('is-in');
    var timer = setTimeout(kill, ms);
    function kill() { clearTimeout(timer); t.remove(); }
    t._kill = kill; t._undo = !!opts.undo;
    if (opts.undo) t.querySelector('.toast-undo').addEventListener('click', function () { kill(); opts.undo(); });
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
    modeChanged();
    App.emit('mode', m);
  };

  // ------------------------------------------------------------ idle
  App.idle = { home: 60, ambient: 120 };
  var idleSec = 0, takeoverEl = null;
  function onIdleTick() {
    takeoverEl = takeoverEl || $('#takeover');
    idleSec++;
    if (App.handheld) return; // phones and tablets update on resume (resumeUpdate) and never idle into ambient/sleep
    if (App.current && App.views[App.current].stay) return; // e.g. a recipe open in a desktop browser
    var blocked = takeoverEl.classList.contains('is-open');
    if (updatePending && idleSec >= 30 && !blocked && updateSafe()) { applyUpdate(); return; }
    // Typing on the soft keyboard sends the page no touches (and keys only sometimes): give someone
    // mid-edit longer before going home or to sleep, then drop the keyboard with the sheet.
    if (editing()) { if (idleSec < EDIT_IDLE) return; document.activeElement.blur(); }
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
  var EDIT_IDLE = 300;
  function editing() {
    var a = document.activeElement;
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  }

  // ------------------------------------------------------------ self-update (hosted builds)
  // A deploy changes the hashed /assets/ files index.html points at. The page fetches index.html
  // and compares its asset set with its own, both read by the same parser (js/update.js).
  //  - Pushed: `npm run deploy` tells Home Assistant, which tells the kiosk over MQTT, which calls
  //    window.frameUpdate(build). One check is enough; it retries a few times while the deploy
  //    propagates.
  //  - Polled (fallback): every 5 min, or hourly while the kiosk's MQTT push is connected. A new
  //    build must show up in two polls in a row.
  // A build is applied at most once per 6 h (persisted), so a reload that lands on the old build
  // again can't loop. Applied once nobody has touched the screen for 30 s and no takeover, sheet,
  // demo drawer or dog walk is open, behind an "Updating…" screen so the frame never sits on a
  // frozen photo while the new page loads. UPDATE-FREEZE.md has the why.
  // No-op on the dev server (no /assets/ tags) and on the APK's bundled copy.
  var POLL_MS = 5 * 60000, PUSHED_POLL_MS = 60 * 60000, PUSH_RETRY_MS = [20000, 60000, 180000];
  var updatePending = null, updateState = { candidate: null, seen: 0 }, myAssets = '', lastCheck = 0, pushTimer = null;
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function captureAssets() {
    myAssets = assetKey(App.$$('script[src], link[href]').map(function (n) { return n.outerHTML; }).join('\n'));
  }
  function pushConnected() {
    try { return !!(window.HomeHQ && window.HomeHQ.updatePush && window.HomeHQ.updatePush()); } catch (e) { return false; }
  }
  // Resolves to the verdict (see decide in js/update.js), or 'off' when checks don't apply here.
  function checkUpdate(need) {
    if (location.hostname === '127.0.0.1') return Promise.resolve('off'); // bundled copy: updates come with the APK
    var storage = store();
    if (!myAssets || !storage) return Promise.resolve('off');
    lastCheck = Date.now();
    return fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      // A redirect or non-HTML answer is a captive portal or an error page, not our index.html.
      var html = r.ok && !r.redirected && /text\/html/i.test(r.headers.get('Content-Type') || '');
      return html ? r.text() : '';
    }).then(function (html) {
      var live = assetKey(html);
      var verdict = decide(updateState, myAssets, live, storage, Date.now(), need);
      updatePending = verdict === 'apply' ? live : null;
      if (verdict === 'blocked') console.warn('Update already tried in the last 6 h; not reloading again');
      return verdict;
    }).catch(function () { return 'none'; /* offline: try again next time */ });
  }
  function pollUpdate() {
    // Hourly while pushes arrive, but a build seen once is confirmed on the next 5-min slot.
    if (!pushConnected() || updateState.seen || Date.now() - lastCheck >= PUSHED_POLL_MS - 5000) checkUpdate(2);
  }
  // Called by the kiosk when a deploy is announced. `build` is the deployed asset key, if known.
  window.frameUpdate = function (build) {
    if (!myAssets && !App.started) { App.on('ready', function () { window.frameUpdate(build); }); return; }
    if (build && build === myAssets) return;
    clearTimeout(pushTimer);
    var attempt = 0;
    (function run() {
      checkUpdate(1).then(function (v) {
        // 'none': the deploy hasn't reached this edge yet (or the fetch failed); ask again shortly.
        if (v === 'none' && attempt < PUSH_RETRY_MS.length) pushTimer = setTimeout(run, PUSH_RETRY_MS[attempt++]);
      });
    })();
  };
  // Phones: a phone app is opened and put away rather than left idle, so look for a new build each
  // time it comes back to the front and apply it straight away, before it's being used.
  function resumeUpdate() {
    if (document.hidden) {
      if (updatePending && updateSafe()) applyUpdate();
      return;
    }
    checkUpdate(1).then(function (v) { if (v === 'apply' && updateSafe()) applyUpdate(); });
  }
  function updateSafe() {
    if ($('#sheetLayer').classList.contains('is-open') || $('#demo').classList.contains('is-open') || editing()) return false;
    return !(App.walk && App.walk.active);
  }
  function applyUpdate() {
    var key = updatePending, storage = store();
    updatePending = null;
    if (!storage || !markApplied(storage, key, Date.now())) return;
    var done = false;
    function reload() { if (!done) { done = true; location.reload(); } }
    // The last frame stays on screen until the new page paints, so make that frame say so. Not at
    // night: the screen is black and should stay that way.
    if (App.mode !== 'night') {
      var o = document.createElement('div');
      o.className = 'updating';
      o.innerHTML = '<div class="updating-box"><b>Updating…</b><span>Back in a moment</span></div>';
      document.body.appendChild(o);
      requestAnimationFrame(function () { requestAnimationFrame(reload); });
    }
    setTimeout(reload, 1000); // rAF doesn't run while the page is hidden
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
  // Phone notches and home indicators (env(safe-area-inset-*), with viewport-fit=cover): the stage
  // starts below the top inset and is fitted beside the side insets. It still runs to the bottom
  // edge, and --safe-b (in stage px) pads the tab bar up above the home indicator. All 0 on the frame.
  var insetProbe = null;
  function insets() {
    if (SIM) return SIM === 'ipad' ? { t: 24, r: 0, b: 20, l: 0 } : { t: 62, r: 0, b: 34, l: 0 };
    if (!insetProbe) {
      insetProbe = document.createElement('div');
      insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(insetProbe);
    }
    var cs = getComputedStyle(insetProbe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  }
  function fit() {
    var stage = $('#stage'), vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh) return;
    // An iOS home-screen app draws edge to edge but reports a viewport short by the status bar
    // (e.g. 812 of 874 pt), leaving a blank band at the bottom. Use the whole screen there.
    if (navigator.standalone && vh > vw && screen.width === vw && screen.height > vh) vh = screen.height;
    var full = vh !== window.innerHeight ? vh + 'px' : '';
    document.documentElement.style.height = document.body.style.height = full;
    stage.style.top = full && vh / 2 + 'px';
    var ins = insets(), aw = vw - ins.l - ins.r, ah = vh - ins.t;
    var portrait = ah > aw, w, h;
    // Phones get their own layout (css/phone.css) at the phone's real size rather than the frame's
    // scaled down: the stage is the whole screen and the views pad themselves inside the insets.
    if (App.phone) {
      App.stageW = vw; App.stageH = vh;
      stage.style.setProperty('--stage-w', vw + 'px');
      stage.style.setProperty('--stage-h', vh + 'px');
      stage.style.setProperty('--safe-t', ins.t + 'px');
      stage.style.setProperty('--safe-b', ins.b + 'px');
      stage.style.transform = '';
      document.documentElement.dataset.phone = '';
      portrait = true;
      if (App.portrait && document.documentElement.dataset.orient) return;
      App.portrait = true;
      document.documentElement.dataset.orient = 'portrait';
      return;
    }
    if (portrait) { w = SHORT; h = Math.max(LONG, Math.round(SHORT * ah / aw)); }
    else { h = SHORT; w = Math.max(LONG, Math.round(SHORT * aw / ah)); }
    // Tablets are squarer than 16:10 (an iPad is about 4:3): grow the short side to fill the screen
    // rather than letterboxing (a wider portrait stage, a taller landscape one).
    if (App.tablet && portrait && ah / aw < LONG / SHORT) { h = LONG; w = Math.round(LONG * aw / ah); }
    if (App.tablet && !portrait && aw / ah < LONG / SHORT) { w = LONG; h = Math.round(LONG * ah / aw); }
    App.stageW = w; App.stageH = h;
    stage.style.setProperty('--stage-w', w + 'px');
    stage.style.setProperty('--stage-h', h + 'px');
    var s = Math.min(aw / w, ah / h), dx = (ins.l - ins.r) / 2, dy = ins.t / 2;
    stage.style.setProperty('--safe-b', (ins.b / s).toFixed(1) + 'px');
    stage.style.transform = (dx || dy ? 'translate(' + dx + 'px,' + dy + 'px) ' : '') + (Math.abs(s - 1) < 0.01 ? '' : 'scale(' + s + ')');
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
    if (App.current) App.go(App.current);
  }

  // ------------------------------------------------------------ clock tick
  // Date-based; scheduled as a setTimeout chain aligned to the next whole second, so timer drift
  // never accumulates. lastMin is the absolute minute (not getMinutes()), so a stall of exactly an
  // hour still re-renders. A gap of over 90 s (frozen main thread, paused timers, NTP correction)
  // re-renders everything for the current time instead of waiting or reloading.
  var CLOCK_SET = Date.UTC(2026, 0, 1);
  var lastMin = -1, lastTick = Date.now(), tickTimer = null, railClock = null;
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
      railClock = railClock || $('#railClock');
      railClock.innerHTML = '<b>' + App.fmt.time(n, false) + '</b><span>' + App.fmt.ampm(n) + '</span>';
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
    // iOS reports the safe-area insets late on a cold start, without a resize event.
    if (App.handheld) {
      [300, 1000, 2500].forEach(function (ms) { setTimeout(fit, ms); });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) fit(); });
    }
    // The iPhone keyboard shrinks only the visual viewport: lift form sheets above it (--kb, phone.css).
    var vv = window.visualViewport;
    if (App.phone && vv) {
      var kb = function () {
        var h = Math.max(0, Math.round(App.stageH - vv.height - vv.offsetTop));
        $('#stage').style.setProperty('--kb', (h > 80 ? h : 0) + 'px');
      };
      vv.addEventListener('resize', kb);
      vv.addEventListener('scroll', kb);
    }
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
    document.addEventListener('input', App.resetIdle, true);
    document.addEventListener('keydown', App.resetIdle, true);
    window.addEventListener('hashchange', function () { App.go(location.hash.slice(1)); });
    App.go(location.hash.slice(1) || 'home');
    try { sessionStorage.removeItem('selfheal'); } catch (e) { /* storage disabled */ }
    captureAssets();
    App.started = true;
    tickLoop();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickLoop(); });
    setInterval(pollUpdate, POLL_MS);
    if (App.handheld) document.addEventListener('visibilitychange', resumeUpdate);
    if (SIM) document.body.insertAdjacentHTML('beforeend', '<div class="sim-status' + (SIM === 'ipad' ? ' is-ipad' : '') + '"><span>9:41</span><i></i><span>5G ▮</span></div><div class="sim-home"></div>');
    App.emit('ready');
    // Tablets have no gear: settings are behind the rail clock, as on the frame. Say so once.
    if (App.tablet) {
      var TIP = 'tablet-settings-tip', seen = '1';
      try { seen = localStorage.getItem(TIP); localStorage.setItem(TIP, '1'); } catch (e) { /* storage disabled */ }
      if (!seen) setTimeout(function () { App.toast('Press and hold the <b>clock</b> for settings', { ms: 6000, icon: 'gear' }); }, 1200);
    }
  };
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})();
