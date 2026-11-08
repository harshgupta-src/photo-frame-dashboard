// Home / Today: the glanceable overview. Never scrolls.
(function () {
  'use strict';
  var D = window.DATA, V = {};

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  function weather() {
    var w = App.weatherNow();
    var hours = App.hourly(7);
    var tmin = Math.min.apply(null, hours.map(function (h) { return h.t; }));
    var tmax = Math.max.apply(null, hours.map(function (h) { return h.t; }));
    return '<div class="h-wx-top">' +
      '<span class="h-wx-icon">' + App.icon(w.cond, 60) + '</span>' +
      '<span class="h-wx-temp num">' + w.temp + '°</span>' +
      '<span class="h-wx-meta"><b>' + w.label + '</b><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span>' +
      '</div>' +
      '<div class="h-wx-say"><b>' + w.summary + '.</b> ' + w.advice + '.</div>' +
      '<div class="h-wx-hours">' + hours.map(function (h) {
        var lift = tmax === tmin ? 0 : Math.round((h.t - tmin) / (tmax - tmin) * 8);
        return '<div class="h-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><span class="h-hr-l">' + h.label + '</span>' +
          '<span class="h-hr-i" style="transform:translateY(' + -lift + 'px)">' + App.icon(h.c, 22) + '</span><b>' + h.t + '°</b></div>';
      }).join('') + '</div>';
  }

  // The dog's walk (CONFIG.dog): above 2° no jacket unless it's raining; 2° to -7° jacket; below -7° jacket and a
  // short walk; below -12° a potty break and straight back inside.
  function walkPlan(w) {
    var t = w.temp, wet = w.cond === 'rain' || w.cond === 'snow';
    if (t < -12) return { level: 3, title: 'Potty break only', sub: 'Jacket on, then straight back inside' };
    if (t < -7) return { level: 2, title: 'Jacket + short walk', sub: 'Keep it quick, it’s bitter out' };
    if (t <= 2) return { level: 1, title: 'Jacket', sub: 'Too cold to go without' };
    if (wet) return { level: 1, title: 'Jacket', sub: (w.cond === 'snow' ? 'It’s snowing' : 'It’s raining') + ', bring it' };
    return { level: 0, title: 'No jacket', sub: 'Normal walk' };
  }

  function walk() {
    var w = App.weatherNow(), m = walkPlan(w);
    return '<div class="label">' + App.esc(window.CONFIG.dog) + '’s walk</div>' +
      '<div class="h-walk-title">' + m.title + '</div>' +
      '<div class="h-walk-sub">' + m.sub + '</div>' +
      '<div class="h-walk-now">' + App.icon(w.cond, 20) + '<b class="num">' + w.temp + '°</b><span>' + w.label + '</span></div>';
  }
  App.walkPlan = walkPlan;

  function hero() {
    var e = App.nextEvent(), now = App.now();
    if (!e) {
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title serif">Nothing else scheduled.<br><i>Enjoy the quiet.</i></div>' +
        (tomorrow ? '<div class="h-hero-meta">Tomorrow starts with <b>' + App.esc(tomorrow.title) + '</b> at ' + App.fmt.time(tomorrow.start) + '</div>' : '') +
        '</div>';
    }
    var p = App.evColor(e);
    var mins = (e.start - now) / 60000;
    var leave = (App.leaveBy(e) - now) / 60000;
    var who = e.people.map(function (id) { return App.person(id).name; });
    var whoText = App.isFamily(e) ? 'Everyone' : who.join(' + ');
    var big = mins < 100
      ? '<div class="h-hero-count num">' + Math.round(mins) + '<small>min</small></div>'
      : '<div class="h-hero-count num">' + App.fmt.time(e.start, false) + '<small>' + App.fmt.ampm(e.start) + '</small></div>';
    var leavePill = '';
    if (e.travel) {
      leavePill = leave <= 0
        ? '<span class="pill pill--alert"><i class="pulse"></i>Leave now</span>'
        : '<span class="pill' + (leave <= 15 ? ' pill--soon' : '') + '">' + App.icon('car', 20) + 'Leave in ' + App.fmt.mins(leave) + '</span>';
    }
    return '<button class="h-hero' + (p === D.family ? ' is-family' : '') + '" style="' + App.pstyle(p) + '" data-ev="' + e.id + '">' +
      '<div class="h-hero-main">' +
      '  <div class="label label--on">Next up · ' + App.esc(whoText) + '</div>' +
      '  <div class="h-hero-title serif">' + App.esc(e.title) + '</div>' +
      '  <div class="h-hero-meta">' + App.fmt.range(e.start, e.end) + (e.loc ? ' · ' + App.esc(e.loc) : '') + '</div>' +
      '  <div class="h-hero-foot">' + (e.people.length > 1 ? App.dots(e.people, 22) : '') + leavePill + '</div>' +
      '</div>' + big + '</button>';
  }

  // Largest size where the title fits on one line; otherwise two lines at up to 50px, then 42px
  // clamped. Needs layout, so it runs after the hero is in the DOM.
  function fitHero(el) {
    var t = el && el.querySelector('.h-hero:not(.h-hero--empty) .h-hero-title');
    if (!t || !t.clientWidth) return;
    var sizes = [72, 64, 56, 50, 46, 42], lineH;
    function lines() { return Math.round(t.scrollHeight / lineH); }
    t.style.maxWidth = '';
    for (var i = 0; i < sizes.length; i++) {
      t.style.fontSize = sizes[i] + 'px';
      lineH = sizes[i] * 0.98;
      var n = lines();
      if (n <= 1) return;
      if (sizes[i] <= 50 && n <= 2) break;
    }
    // Two lines: narrow the box until just before a third line appears, so the lines come out
    // even instead of leaving one word alone (text-wrap: balance needs Chromium 114).
    if (lines() !== 2) return;
    var hi = t.clientWidth, lo = hi / 2;
    for (var k = 0; k < 7; k++) {
      var mid = (lo + hi) / 2;
      t.style.maxWidth = mid + 'px';
      if (lines() <= 2) hi = mid; else lo = mid;
    }
    t.style.maxWidth = Math.ceil(hi) + 'px';
  }

  function lanes() {
    var now = App.now();
    return D.people.map(function (p) {
      var list = App.timedOn(now, p.id).filter(function (e) { return e.end > now; });
      var shown = list.slice(0, 3), more = list.length - shown.length;
      return '<div class="h-lane" style="' + App.pstyle(p) + '">' +
        '<div class="h-lane-head">' + App.avatar(p, 30) + '<b>' + p.name + '</b></div>' +
        (list.length ? shown.map(function (e) {
          var cur = e.start <= now;
          return '<button class="h-ev' + (cur ? ' is-now' : '') + '" data-ev="' + e.id + '">' +
            '<span class="h-ev-t">' + (cur ? 'Now' : App.fmt.time(e.start, false)) + '</span>' +
            '<span class="h-ev-n">' + App.esc(e.title) + '</span></button>';
        }).join('') : '<div class="h-free serif"><i>Free</i> the rest of the day</div>') +
        (more > 0 ? '<button class="h-more" data-go="calendar">+' + more + ' more</button>' : '') +
        '</div>';
    }).join('');
  }

  function ring(done, total, size) {
    var r = size / 2 - 5, c = 2 * Math.PI * r, f = total ? done / total : 0;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-bg"/>' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" class="ring-fg" stroke-dasharray="' + (c * f) + ' ' + c + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')"/></svg>';
  }
  App.ring = ring;

  function chores() {
    var r = App.currentRoutine();
    var who = D.people.map(function (p) { return p.id; }).concat(['any']);
    return '<div class="label">Chores · ' + r.name + '</div><div class="h-rings">' + who.map(function (id) {
      var list = D.chores.filter(function (c) { return c.r === r.id && c.who === id; });
      if (!list.length) return '';
      var done = list.filter(function (c) { return c.done; }).length;
      var p = App.person(id);
      return '<div class="h-ring' + (done === list.length ? ' is-done' : '') + '" style="' + App.pstyle(p) + '">' + ring(done, list.length, 64) +
        '<b class="num">' + (done === list.length ? '✓' : done + '/' + list.length) + '</b><span>' + (id === 'any' ? 'Anyone' : p.name) + '</span></div>';
    }).join('') + '</div>';
  }

  // The pinned Reminders list (CONFIG.pinnedList) takes the chores tile once live data is configured (App.reminders set).
  // Every item is rendered; fitPinned then trims to what fits the tile.
  function pinned() {
    var items = App.reminders.pinned;
    return '<div class="label">' + App.esc(window.CONFIG.pinnedList) + (items.length ? ' · ' + items.length : '') + '</div>' +
      (items.length ? '<ul class="h-pinned">' + items.map(function (it) {
        return '<li><i></i>' + App.esc(it.title) + '</li>';
      }).join('') + '</ul><small class="h-more"></small>'
        : '<p class="h-pinned-empty">' + (App.reminders.updated ? 'All clear.' : 'Waiting for the iPhone Shortcut.') + '</p>');
  }
  function fitPinned(tile) {
    var ul = tile.querySelector('.h-pinned'), more = tile.querySelector('.h-more');
    if (!ul || !more) return;
    var total = ul.children.length;
    function label() {
      var n = total - ul.children.length;
      more.textContent = n ? '+' + n + ' more' : '';
      more.style.display = n ? '' : 'none';
    }
    label();
    while (ul.children.length > 1 && tile.scrollHeight > tile.clientHeight + 1) { ul.removeChild(ul.lastChild); label(); }
  }
  function pinnedSheet() {
    var items = App.reminders.pinned;
    App.sheet('<div class="sheet-pad"><div class="label">Apple Reminders</div><h2 class="sheet-h serif">' + App.esc(window.CONFIG.pinnedList) + '</h2>' +
      (items.length ? '<ul class="pinned-list">' + items.map(function (it) {
        return '<li><b>' + App.esc(it.title) + '</b>' + (it.notes ? '<small>' + App.esc(it.notes) + '</small>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="sheet-p">Nothing on the list.</p>') + '</div>');
  }

  function shopping() {
    var open = D.groceries.filter(function (g) { return !g.done; });
    var recent = open.slice(-3).reverse();
    return '<div class="label">Shopping</div>' +
      '<div class="h-stat"><span class="num">' + open.length + '</span><small>items to get</small></div>' +
      '<ul class="h-recent">' + recent.map(function (g) {
        return '<li><i></i>' + App.esc(g.name) + '</li>';
      }).join('') + '</ul>';
  }

  function status() {
    if (App.ha.ready) return haStatus();
    var lights = D.devices.filter(function (d) { return d.type === 'light' && d.on; }).length;
    var unlocked = D.devices.filter(function (d) { return d.type === 'lock' && !d.locked; });
    var garage = D.devices.filter(function (d) { return d.type === 'garage'; })[0];
    var secure = !unlocked.length && garage.state === 'closed';
    var secText = secure ? 'All locked' : (garage.state !== 'closed' ? 'Garage open' : unlocked[0].name + ' unlocked');
    return '<div class="label">Home</div>' +
      '<div class="h-st-row">' + App.icon('bulb', 24) + '<b class="num">' + lights + '</b><span>lights on</span></div>' +
      '<div class="h-st-row' + (secure ? '' : ' is-warn') + '">' + App.icon(secure ? 'lock' : 'unlock', 24) + '<span>' + secText + '</span></div>' +
      '<div class="h-st-row">' + App.icon('thermo', 24) + '<b class="num">' + D.climate.current + '°</b><span>inside</span></div>';
  }

  // Live from Home Assistant (js/ha.js): a tap turns that button's lights off if any are on, else on.
  function haStatus() {
    var loaded = !!App.ha.updated, inside = App.ha.inside();
    return '<div class="label">Home</div>' + App.ha.lights().map(function (b) {
      var state = !loaded ? '…' : !b.total ? 'None' : !b.on ? 'Off' : b.on === b.total ? 'On' : b.on + ' of ' + b.total + ' on';
      return '<button class="h-st-row h-st-btn' + (b.on ? ' is-on' : '') + '" data-ha="' + b.id + '"' + (b.total ? '' : ' disabled') + '>' +
        App.icon('bulb', 24) + '<span>' + App.esc(b.name) + '</span><b>' + state + '</b></button>';
    }).join('') +
      (inside == null ? '' : '<div class="h-st-row">' + App.icon('thermo', 24) + '<b class="num">' + inside + '°</b><span>inside</span></div>');
  }

  function paint() {
    var el = V.el;
    el.querySelector('.h-clock').innerHTML = clock();
    el.querySelector('.h-weather').innerHTML = weather();
    var mel = el.querySelector('.h-walk');
    mel.className = 'h-walk h-walk--' + walkPlan(App.weatherNow()).level;
    mel.innerHTML = walk();
    el.querySelector('.h-hero-slot').innerHTML = hero();
    fitHero(el);
    el.querySelector('.h-lanes').innerHTML = lanes();
    var side = el.querySelector('.h-chores');
    if (App.reminders) { side.className = 'h-chores h-pinned-tile card'; side.dataset.go = 'pinned'; side.innerHTML = pinned(); fitPinned(side); }
    else side.innerHTML = chores();
    el.querySelector('.h-shop').innerHTML = shopping();
    el.querySelector('.h-status').innerHTML = status();
  }

  function photoCaption(s) {
    var m = App.photoMeta(s.photos[0]);
    V.el.querySelector('.h-photo-cap').innerHTML = '<b>' + (m.onThisDay ? 'On this day · ' : '') + m.kicker + '</b><span>' + App.esc(m.place) + '</span>';
  }

  App.register('home', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML = '<div class="home">' +
          '<div class="h-clock" data-go="calendar"></div>' +
          '<div class="h-weather"></div>' +
          '<div class="h-walk"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-lanes" style="grid-template-columns:repeat(' + D.people.length + ',1fr)"></div></div>' +
          '<div class="h-side">' +
          '  <button class="h-photo" data-go="photos"><div class="h-photo-stage"></div><div class="h-photo-cap"></div></button>' +
          '  <button class="h-chores card" data-go="tasks"></button>' +
          '  <div class="h-duo"><button class="h-shop card" data-go="shopping"></button>' +
          (App.ha.ready ? '<div class="h-status card"></div>' : '<button class="h-status card" data-go="control"></button>') + '</div>' +
          '</div></div>';
        el.addEventListener('click', function (e) {
          var h = e.target.closest('[data-ha]');
          if (h) { App.ha.toggle(h.dataset.ha); return; }
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          var g = e.target.closest('[data-go]');
          if (g) { if (g.dataset.go === 'pinned') pinnedSheet(); else App.go(g.dataset.go); }
        });
        V.slides = new App.Slideshow(el.querySelector('.h-photo-stage'), { layout: 'cover', captions: false, interval: 12000, onChange: photoCaption });
      }
      paint();
      V.slides.start();
    },
    resume: function () { V.slides.start(); },
    hide: function () { if (V.slides) V.slides.stop(); }
  });
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Weather on the hour.
  App.on('minute', function (n) {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    fitHero(V.el);
    if (n.getMinutes() === 0) { paint(); }
  });
  App.on('data', function () { if (App.current === 'home') paint(); });
  App.on('ha', function () { if (V.el && V.el.firstChild) V.el.querySelector('.h-status').innerHTML = status(); });
})();
