// Home / Today: the glanceable overview. Never scrolls.
import { createHold } from '../todo.js';

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

  // ---- walk timer (js/walk.js): tap the tile to start a walk, tap again when back to log it.
  var STALE = 150 * 60e3; // still "out" after 2.5 h: somebody forgot to stop it
  function dur(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    return h < 24 ? h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') + ' ago' : Math.floor(h / 24) + 'd ago';
  }
  function potty(w) { return (w.pee ? '💧' : '') + (w.poop ? '💩' : '') || 'no potty'; }
  function walkers(w) { return (w.walkers || []).map(function (p) { return p.name; }).join(' & '); }
  // Maya's real limit is how long she can hold her pee, so the tile counts from her last pee
  // (walks and Life Log entries), not from when the last walk ended.
  function lastPee() {
    return App.dog.potty(Date.now() - 3 * 864e5).filter(function (p) { return p.kind === 'pee'; })[0] || null;
  }
  function peeState(p) {
    var gap = App.dog.gap('pee'), since = Date.now() - p.at, h = new Date().getHours();
    if (!gap || h < 7 || h >= 22) return '';
    return since > gap * 1.5 ? ' is-alert' : since > gap ? ' is-warn' : '';
  }
  function sync() { return App.walk.pending ? '<i class="h-walk-sync" title="Not synced yet"></i>' : ''; }

  function walk() {
    var W = App.walk, dog = App.esc(window.CONFIG.dog), a = W.active;
    if (a && !a.endedAt) {
      var stale = Date.now() - a.startedAt > STALE;
      return '<div class="h-walk-head"><div class="label">' + App.icon('paw', 18, 'h-walk-paw') + dog + '’s out · ' + App.fmt.time(new Date(a.startedAt)) + sync() + '</div>' +
        '<button class="h-walk-x" data-walk="cancel" aria-label="Cancel walk">' + App.icon('x', 22) + '</button></div>' +
        '<div class="h-walk-timer num">' + dur(Date.now() - a.startedAt) + '</div>' +
        (stale ? '<div class="h-walk-stale">Still out? Tap to fix</div>' : '') +
        '<div class="h-walk-back">' + App.icon('check', 22) + 'I’m back</div>';
    }
    var w = App.weatherNow(), m = walkPlan(w), last = W.recent[0], pee = lastPee();
    return '<div class="h-walk-head"><div class="label">' + App.icon('paw', 18, 'h-walk-paw') + dog + '’s walk' + sync() + '</div>' +
      '<span class="h-walk-go">' + App.icon('play', 16) + 'Start</span></div>' +
      '<div class="h-walk-title">' + m.title + '</div>' +
      (W.next() ? planRow(W.next()) : '<div class="h-walk-sub">' + m.sub + '</div>') +
      (pee
        ? '<div class="h-walk-last' + peeState(pee) + '" data-walk="history">💧 Peed ' + ago(pee.at) + '</div>'
        : last
        ? '<div class="h-walk-last" data-walk="history">Walked ' + ago(last.endedAt) + ' · no pee logged</div>'
        : '<div class="h-walk-now">' + App.icon(w.cond, 20) + '<b class="num">' + w.temp + '°</b><span>' + w.label + '</span></div>');
  }
  // The next planned walk (HA agent) and who walks it: tap an avatar to add or remove someone.
  function planRow(x) {
    var who = App.walk.defaultWalkers(), s = Date.parse(x.start);
    var when = s - Date.now() < 15 * 60e3 ? 'Due now' : 'Next ' + App.fmt.time(new Date(s));
    return '<div class="h-walk-plan"><span class="h-walk-when">' + when + ' · ' + App.fmt.mins(x.durationMin) + '</span>' +
      '<span class="h-walk-who">' + window.CONFIG.people.map(function (p) {
        var on = who.some(function (w) { return w.id === p.id; });
        return '<button class="h-walk-p' + (on ? ' is-on' : '') + '" data-walk="who:' + App.esc(p.id) + '" aria-pressed="' + on + '" aria-label="' +
          App.esc(p.name) + '">' + App.avatar(p, 30) + '</button>';
      }).join('') + '</span></div>';
  }
  function paintWalk() {
    var mel = V.el && V.el.querySelector('.h-walk');
    if (!mel) return;
    var a = App.walk.active, out = a && !a.endedAt;
    mel.className = 'h-walk ' + (out ? 'h-walk--out' : 'h-walk--' + walkPlan(App.weatherNow()).level);
    mel.dataset.walk = out ? 'back' : 'start';
    mel.innerHTML = walk();
  }

  // End-of-walk (or edit) sheet. The common case is one tap, Save: finishing a walk starts with what it
  // probably was (App.walk.suggest: the planned walk's walkers and expected pee/poop, else her history),
  // with a small "Based on …" line; everything stays editable and nothing is saved without a tap.
  function walkSheet(rec, opts) {
    opts = opts || {};
    var g = opts.finishing ? App.walk.suggest(rec) : null;
    var r = {
      id: rec.id, startedAt: rec.startedAt, endedAt: rec.endedAt, notes: rec.notes || '', planId: rec.planId,
      pee: rec.pee != null ? rec.pee : g ? g.pee : true, poop: rec.poop != null ? rec.poop : g ? g.poop : false,
      walkers: g ? g.walkers.slice() : rec.walkers && rec.walkers.length ? rec.walkers.slice() : App.walk.defaultWalkers()
    };
    var guessed = opts.finishing && r.endedAt - r.startedAt > STALE;
    if (guessed) r.endedAt = r.startedAt + App.walk.typical();
    var saved = false, dismissed = false, dog = App.esc(window.CONFIG.dog);
    var people = window.CONFIG.people;
    function nudgeRow(k, label) {
      return '<div class="ws-time"><span class="ws-k">' + label + '</span><b class="num" data-ws-t="' + k + '"></b>' +
        '<button class="icon-btn" data-ws="' + k + '-">' + App.icon('minus', 22) + '</button>' +
        '<button class="icon-btn" data-ws="' + k + '+">' + App.icon('plus', 22) + '</button></div>';
    }
    var html = '<div class="sheet-pad walk-sheet">' +
      '<div class="label">' + dog + '’s walk' + (opts.finishing ? '' : ' · ' + App.esc(dayName(r.startedAt))) + '</div>' +
      '<h2 class="sheet-h serif"><span class="num" data-ws-t="min"></span></h2>' +
      (guessed ? '<p class="sheet-p">Nobody stopped the timer, so the end time is a guess. Adjust it if you know.</p>' : '') +
      nudgeRow('s', 'Left') + nudgeRow('e', 'Back') +
      (g ? '<p class="ws-hint">' + App.esc(g.hint) + '</p>' : '') +
      '<div class="ws-togs">' +
      '<button class="ws-tog" data-ws="pee"><span class="ws-emoji">💧</span>Pee<i class="ws-check">' + App.icon('check', 22) + '</i></button>' +
      '<button class="ws-tog" data-ws="poop"><span class="ws-emoji">💩</span>Poop<i class="ws-check">' + App.icon('check', 22) + '</i></button></div>' +
      '<div class="ws-who"><span class="ws-k">With</span><div class="chips">' + people.map(function (p) {
        return '<button class="chip ws-person" data-ws-p="' + App.esc(p.id) + '" style="' + App.pstyle(p) + '">' + App.avatar(p, 34) + App.esc(p.name) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="sheet-actions">' +
      (opts.finishing ? '' : '<button class="btn btn--ghost ws-del" data-ws="delete">Delete</button>') +
      '<button class="btn btn--solid ws-save" data-ws="save">' + App.icon('check', 22) + 'Save</button></div></div>';
    App.sheet(html, {
      cls: 'sheet--walk',
      onMount: function (el, close) {
        function paint() {
          el.querySelector('[data-ws-t="min"]').textContent = App.fmt.mins((r.endedAt - r.startedAt) / 60000);
          el.querySelector('[data-ws-t="s"]').textContent = App.fmt.time(new Date(r.startedAt));
          el.querySelector('[data-ws-t="e"]').textContent = App.fmt.time(new Date(r.endedAt));
          el.querySelector('[data-ws="pee"]').classList.toggle('is-on', !!r.pee);
          el.querySelector('[data-ws="poop"]').classList.toggle('is-on', !!r.poop);
          App.$$('[data-ws-p]', el).forEach(function (b) {
            b.classList.toggle('is-on', r.walkers.some(function (w) { return w.id === b.dataset.wsP; }));
          });
        }
        paint();
        // X or a tap outside: "not back yet" for a walk being finished. Capture runs before close().
        el.parentNode.addEventListener('click', function (e) {
          if (e.target.closest('[data-close]') || e.target.classList.contains('sheet-scrim')) dismissed = true;
        }, true);
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-ws], [data-ws-p]');
          if (!b) return;
          var k = b.dataset.ws, step = 5 * 60e3, now = Date.now();
          if (k === 's-') r.startedAt -= step;
          else if (k === 's+') r.startedAt = Math.min(r.startedAt + step, r.endedAt - 60e3);
          else if (k === 'e-') r.endedAt = Math.max(r.endedAt - step, r.startedAt + 60e3);
          else if (k === 'e+') r.endedAt = Math.min(r.endedAt + step, now);
          else if (k === 'pee' || k === 'poop') r[k] = !r[k];
          else if (b.dataset.wsP) {
            var id = b.dataset.wsP, has = r.walkers.some(function (w) { return w.id === id; });
            var p = people.filter(function (x) { return x.id === id; })[0];
            if (has && r.walkers.length > 1) r.walkers = r.walkers.filter(function (w) { return w.id !== id; });
            else if (!has) r.walkers = r.walkers.concat([{ id: p.id, name: p.name }]);
          } else if (k === 'save') { saved = true; close(); return; }
          else if (k === 'delete') { close(); removeWalk(rec); return; }
          if (r.endedAt - r.startedAt > 6 * 3600e3) r.startedAt = r.endedAt - 6 * 3600e3;
          paint();
        });
      },
      onClose: function () {
        if (opts.finishing && dismissed && !saved) { App.walk.resume(); return; }
        // Saved, or closed by the idle timer while finishing: log it as it stands.
        if (opts.finishing && r.endedAt - r.startedAt < App.walk.MIN_MS) { App.walk.resume(); discardShort(App.walk.active); return; }
        if (saved || opts.finishing) {
          App.walk.save(r);
          if (opts.finishing) App.toast('Walk logged · ' + App.fmt.mins((r.endedAt - r.startedAt) / 60000) + ' · ' + potty(r), { icon: 'check' });
        }
      }
    });
  }
  // A walk stopped within a minute of starting was a mis-tap: drop it (Undo puts the timer back).
  function discardShort(a) {
    if (!a) return;
    var W = App.walk;
    W.remove(a);
    a.endedAt = null;
    App.toast('Under a minute, so it wasn’t logged', { icon: 'x', undo: function () { W.restore(a); } });
  }
  function removeWalk(rec) {
    App.walk.remove(rec);
    App.toast('Walk deleted', { icon: 'x', undo: function () { App.walk.restore(rec); } });
  }
  function dayName(ms) {
    var d = new Date(ms), t = new Date(), y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return App.fmt.dayShort(d) + ' ' + App.fmt.monthShort(d) + ' ' + d.getDate();
  }
  function historySheet() {
    var list = App.walk.recent, dog = App.esc(window.CONFIG.dog), today = new Date().toDateString();
    var tw = list.filter(function (w) { return new Date(w.startedAt).toDateString() === today; });
    var mins = tw.reduce(function (s, w) { return s + (w.endedAt - w.startedAt) / 60000; }, 0);
    var since = Date.now() - 3 * 864e5;
    var lastPee = App.dog.potty(since).filter(function (p) { return p.kind === 'pee'; })[0];
    var lastPoop = App.dog.potty(since).filter(function (p) { return p.kind === 'poop'; })[0];
    var day = null, rows = list.map(function (w) {
      var d = dayName(w.startedAt), head = d !== day ? '<li class="wl-day">' + d + '</li>' : '';
      day = d;
      return head + '<li><button class="wl-row" data-wid="' + App.esc(w.id) + '">' +
        '<b class="num">' + App.fmt.time(new Date(w.startedAt), false) + '–' + App.fmt.time(new Date(w.endedAt)) + '</b>' +
        '<span>' + App.fmt.mins((w.endedAt - w.startedAt) / 60000) + '</span><span>' + potty(w) + '</span>' +
        '<small>' + App.esc(walkers(w)) + '</small></button></li>';
    }).join('');
    App.sheet('<div class="sheet-pad"><div class="label">' + dog + '’s walks · last 14 days</div>' +
      '<h2 class="sheet-h serif">Today: ' + tw.length + (tw.length === 1 ? ' walk' : ' walks') + (tw.length ? ', ' + App.fmt.mins(mins) : '') + '</h2>' +
      '<p class="sheet-p">' + (lastPee ? 'Last pee ' + ago(lastPee.at) : 'No pee logged') + ' · ' +
      (lastPoop ? 'last poop ' + ago(lastPoop.at) : 'no poop logged') + '. Tap a walk to fix it.</p>' +
      (rows ? '<ul class="walk-list">' + rows + '</ul>' : '<p class="sheet-p">No walks yet.</p>') + '</div>', {
      onMount: function (el) {
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-wid]');
          if (!b) return;
          var w = App.walk.recent.filter(function (x) { return x.id === b.dataset.wid; })[0];
          if (w) walkSheet(w);
        });
      }
    });
  }
  function walkTap(kind) {
    var W = App.walk;
    if (kind === 'history') { historySheet(); return; }
    if (kind.indexOf('who:') === 0) { W.toggleWalker(kind.slice(4)); return; }
    if (kind === 'cancel') {
      var a = W.active;
      if (!a) return;
      W.remove(a);
      App.toast('Walk cancelled', { icon: 'x', undo: function () { W.restore(a); } });
      return;
    }
    if (kind === 'back') {
      if (W.active && !W.active.endedAt && Date.now() - W.active.startedAt < W.MIN_MS) { discardShort(W.active); return; }
      var rec = W.back();
      if (rec) walkSheet(rec, { finishing: true });
      return;
    }
    if (kind === 'start' && W.start()) {
      App.toast(App.esc(window.CONFIG.dog) + '’s walk started' + (W.active.walkers.length ? ' with ' + App.esc(walkers(W.active)) : '') + ' · tap the tile when you’re back', {
        icon: 'clock', undo: function () { if (W.active) W.remove(W.active); }
      });
    }
  }
  App.walkPlan = walkPlan;
  App.walkSheet = walkSheet; // the dog tab (views/dog.js) edits walks and starts/stops them too
  App.walkTap = walkTap;

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
    var sizes = App.phone ? [34, 31, 28, 26, 24, 22] : [72, 64, 56, 50, 46, 42], lineH;
    function lines() { return Math.round(t.scrollHeight / lineH); }
    // The title shares a fixed-height card (portrait especially), and emoji make lines taller than
    // the font size, so also check the clamped text really fits the box it was given.
    // Emoji overhang the line box a little, so allow a quarter line before calling it clipped.
    function fits() { return t.scrollHeight <= t.clientHeight + lineH / 4; }
    function size(px) { t.style.fontSize = px + 'px'; lineH = px * 0.98; }
    t.style.maxWidth = '';
    for (var i = 0; i < sizes.length; i++) {
      size(sizes[i]);
      var n = lines();
      if (n <= 1 && fits()) return;
      if (i >= 3 && n <= 2 && fits()) break;
    }
    for (var px = sizes[sizes.length - 1] - 3; !fits() && px >= 24; px -= 3) size(px);
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

  // A lane shows up to three events; where the tile is shorter (portrait), drop events until the
  // rest fit and count them in "+N more" rather than letting the button get clipped.
  function fitLanes(box) {
    if (!box || App.phone) return;
    Array.prototype.forEach.call(box.querySelectorAll('.h-lane'), function (lane) {
      var evs = lane.querySelectorAll('.h-ev');
      for (var i = evs.length - 1; i > 0 && lane.scrollHeight > lane.clientHeight + 1; i--) {
        var more = lane.querySelector('.h-more');
        if (!more) { more = document.createElement('button'); more.className = 'h-more'; more.dataset.go = 'calendar'; more.dataset.n = '0'; lane.appendChild(more); }
        var n = (parseInt(more.dataset.n || (more.textContent.match(/\d+/) || [0])[0], 10) || 0) + 1;
        more.dataset.n = n; more.textContent = '+' + n + ' more';
        lane.removeChild(evs[i]);
      }
    });
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
  // Every item is rendered; fitPinned then trims to what fits the tile. An assigned item's dot is
  // that person's initial, in their colour.
  function who(it) { return it.who && it.who !== 'family' ? App.person(it.who) : null; }
  function pinned() {
    var items = App.reminders.pinned;
    return '<div class="label">' + App.esc(window.CONFIG.pinnedList) + (items.length ? ' · ' + items.length : '') + '</div>' +
      (items.length ? '<ul class="h-pinned">' + items.map(function (it) {
        var p = who(it);
        return '<li>' + (p ? '<i class="is-who" style="' + App.pstyle(p) + '">' + App.esc(p.name[0]) + '</i>' : '<i></i>') + App.esc(it.title) + '</li>';
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
    // The phone's Today scrolls, so the tile grows with its list; keep it to a glance.
    if (App.phone) { while (ul.children.length > 8) ul.removeChild(ul.lastChild); label(); return; }
    while (ul.children.length > 1 && tile.scrollHeight > tile.clientHeight + 1) { ul.removeChild(ul.lastChild); label(); }
  }
  // The whole list, editable (App.todo, live.js): add at the top (optionally assigned to someone),
  // tick the box, tap an item to rename, add notes, assign or delete it (App.todoEditSheet,
  // shopping.js). Ticked items wait under "Done" until the phone drops them. Updated in place while
  // open, except for 1.5 s after a tick or untick (or until a tap outside the list), so rows don't
  // move under the finger.
  var PS = { el: null, done: false, query: '', added: null };
  PS.hold = createHold(function () { paintPinnedSheet(); }, 1500);
  document.addEventListener('pointerdown', function (e) {
    if (!PS.hold.held()) return;
    var w = PS.el && PS.el.querySelector('.pl-body-wrap');
    if (!w || !w.contains(e.target)) PS.hold.release();
  }, true);
  function pinnedRow(it) {
    var p = who(it), id = App.esc(it.id), busy = it.pending || !it.uid;
    return '<li class="pl-row' + (it.done ? ' is-done' : '') + (it.pending ? ' is-pending' : '') + '" data-id="' + id + '">' +
      '<button class="pl-box" data-pl-tick="' + id + '"' + (busy ? ' disabled' : '') + ' aria-label="' + (it.done ? 'Not done' : 'Done') + '"><span class="pl-chk">' + App.icon('check', 22) + '</span></button>' +
      '<button class="pl-body" data-pl-edit="' + id + '"' + (busy ? ' disabled' : '') + '><b>' + App.esc(it.title) + '</b>' +
      (it.notes ? '<small>' + App.esc(it.notes) + '</small>' : '') +
      (p ? '<small class="pinned-who" style="' + App.pstyle(p) + '">' + App.avatar(p, 20) + App.esc(p.name) + '</small>'
        : it.assignee ? '<small class="pinned-who">' + App.esc(it.assignee) + '</small>' : '') + '</button></li>';
  }
  function pinnedSync() {
    var t = App.todo, st = t ? t.status() : 'readonly';
    if (st === 'ok') return t.pending() ? 'Syncing…' : '';
    if (st === 'loading') return 'Connecting…';
    if (st === 'offline') return 'Can’t reach Home Assistant · read-only';
    return App.ha && App.ha.web && !App.ha.web.signedIn ? 'Sign in to Home Assistant to edit' : 'Read-only';
  }
  function pinnedListHTML() {
    var items = App.reminders.pinned, done = App.reminders.pinnedDone || [];
    return (items.length ? '<ul class="pinned-list">' + items.map(pinnedRow).join('') + '</ul>' : '<p class="sheet-p pl-empty">Nothing on the list.</p>') +
      (done.length ? '<button class="pl-done-h" data-pl-done>' + App.icon('check', 20) + ' Done <b class="num">(' + done.length + ')</b><span class="label">' + (PS.done ? 'Hide' : 'Show') + '</span></button>' +
        (PS.done ? '<ul class="pinned-list pinned-list--done">' + done.map(pinnedRow).join('') + '</ul>' : '') : '');
  }
  function paintPinnedSheet() {
    if (!PS.el || !PS.el.isConnected) { PS.el = null; return; }
    var can = App.todo && App.todo.can('pinned');
    var body = PS.el.querySelector('.pl-body-wrap'), h;
    if (!PS.hold.held() && body._h !== (h = pinnedListHTML())) { body._h = h; body.innerHTML = h; }
    // Just added: new items go to the bottom, so bring that row into view once it's drawn.
    if (PS.added) {
      var rows = body.querySelectorAll('.pl-row:not(.is-done) .pl-body b');
      for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i].textContent.trim().toLowerCase() === PS.added) { rows[i].closest('.pl-row').scrollIntoView({ block: 'nearest' }); PS.added = null; break; }
      }
    }
    var s = PS.el.querySelector('.pl-sync');
    s.textContent = pinnedSync();
    PS.el.querySelector('.pl').classList.toggle('is-ro', !can);
    var input = PS.el.querySelector('.pl-input');
    input.disabled = !can;
    input.placeholder = can ? 'Add to ' + window.CONFIG.pinnedList + '…' : 'Adding needs Home Assistant';
  }
  function pinnedSheet() {
    App.sheet('<div class="sheet-pad pl"><div class="label">Apple Reminders <span class="pl-sync"></span></div><h2 class="sheet-h serif">' + App.esc(window.CONFIG.pinnedList) + '</h2>' +
      '<form class="pl-add" action="#"><input class="pl-input" maxlength="120" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" aria-label="New item">' +
      '<button class="pl-add-btn" type="submit" aria-label="Add">' + App.icon('plus', 28) + '</button></form>' +
      (App.assigneeSeg ? '<div class="pl-who"><span class="label">For</span>' + App.assigneeSeg('') + '</div>' : '') +
      '<div class="pl-body-wrap"></div></div>', {
      cls: App.phone ? '' : 'sheet--top',
      onClose: function () { PS.el = null; },
      onMount: function (el) {
        PS.el = el;
        PS.hold.release();
        if (App.assigneePick) App.assigneePick(el.querySelector('.pl-who') || el);
        var input = el.querySelector('.pl-input');
        input.value = PS.query;
        input.addEventListener('input', function () { PS.query = input.value; });
        el.querySelector('.pl-add').addEventListener('submit', function (e) {
          e.preventDefault();
          var title = input.value.trim();
          if (!title || !App.todo.can('pinned')) return;
          input.value = PS.query = '';
          PS.added = title.toLowerCase();
          var who = App.assigneeOf && App.assigneeOf(el.querySelector('.pl-who'));
          // Back to "None" for the next one: an assignment is a choice each time.
          var none = el.querySelector('.pl-who [data-who=""]');
          if (none) none.click();
          App.todo.add('pinned', title, '', who).then(function (r) {
            if (r && r.dup) App.toast('<b>' + App.esc(r.dup.title) + '</b> is already on the list', { icon: 'check', ms: 2500 });
            // Failed (live.js said why): give back what was typed.
            else if (!r && !PS.query) { PS.query = title; if (PS.el) PS.el.querySelector('.pl-input').value = title; }
          });
        });
        el.addEventListener('click', function (e) {
          var t;
          if ((t = e.target.closest('[data-pl-done]'))) { PS.done = !PS.done; return paintPinnedSheet(); }
          if ((t = e.target.closest('[data-pl-tick]'))) {
            var id = t.dataset.plTick, it = App.todo.find('pinned', id);
            if (!it || !App.todo.can('pinned')) return;
            // Ticked in place: the row moves to "Done" once the hold ends.
            PS.hold.touch();
            App.todo.toggle('pinned', id, !it.done);
            var row = t.closest('.pl-row');
            if (row) row.classList.toggle('is-done', !it.done);
            if (!it.done) App.toast('<b>' + App.esc(it.title) + '</b> done', { icon: 'check', undo: function () { App.todo.toggle('pinned', id, false); } });
            return;
          }
          if ((t = e.target.closest('[data-pl-edit]'))) {
            if (!App.todo.can('pinned') || !App.todoEditSheet) return;
            // Back to the list afterwards, unless the frame went idle (home, ambient) meanwhile.
            App.todoEditSheet('pinned', t.dataset.plEdit, { onClose: function () { setTimeout(function () { if (App.mode === 'day' && App.current === 'home') pinnedSheet(); }, 0); } });
          }
        });
        paintPinnedSheet();
      }
    });
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
    paintWalk();
    el.querySelector('.h-hero-slot').innerHTML = hero();
    fitHero(el);
    el.querySelector('.h-lanes').innerHTML = lanes();
    fitLanes(el.querySelector('.h-lanes'));
    var side = el.querySelector('.h-chores');
    if (App.reminders) { side.className = 'h-chores h-pinned-tile card'; side.dataset.go = 'pinned'; side._h = null; paintTodos(); }
    else { side.innerHTML = chores(); el.querySelector('.h-shop').innerHTML = shopping(); }
    el.querySelector('.h-status').innerHTML = status();
  }
  // The to-do lists changed: just the pinned and shopping tiles, and only if their text did.
  function paintTodos() {
    var side = V.el.querySelector('.h-pinned-tile'), shop = V.el.querySelector('.h-shop'), h;
    if (side && (h = pinned()) !== side._h) { side._h = h; side.innerHTML = h; fitPinned(side); }
    if (shop && (h = shopping()) !== shop._h) { shop._h = h; shop.innerHTML = h; }
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
          '<div class="h-walk" role="button"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-lanes" style="grid-template-columns:repeat(' + D.people.length + ',1fr)"></div></div>' +
          '<div class="h-side">' +
          '  <button class="h-photo" data-go="photos"><div class="h-photo-stage"></div><div class="h-photo-cap"></div></button>' +
          '  <button class="h-chores card"></button>' +
          '  <div class="h-duo"><button class="h-shop card" data-go="shopping"></button>' +
          (App.ha.ready ? '<div class="h-status card"></div>' : '<button class="h-status card" data-go="control"></button>') + '</div>' +
          '</div></div>';
        el.addEventListener('click', function (e) {
          var wk = e.target.closest('[data-walk]');
          if (wk) { walkTap(wk.dataset.walk); return; }
          var h = e.target.closest('[data-ha]');
          if (h) { App.ha.toggle(h.dataset.ha); return; }
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          var g = e.target.closest('[data-go]');
          if (g) { if (g.dataset.go === 'pinned') pinnedSheet(); else App.go(g.dataset.go); }
        });
        // The tile is about 300×400: the small derivative (360×480) is plenty.
        V.slides = new App.Slideshow(el.querySelector('.h-photo-stage'), { layout: 'cover', captions: false, interval: 12000, small: true, onChange: photoCaption });
        V.timer = null;
      }
      V.stale = false;
      paint();
      V.slides.start();
    },
    // Back on screen (another tab, ambient or night was over it): catch up on what was skipped.
    resume: function () { if (V.stale) { V.stale = false; paint(); } V.slides.start(); },
    hide: function () { if (V.slides) V.slides.stop(); },
    release: function () { if (V.slides) V.slides.clear(); }
  });
  function shown() { return V.el && V.el.firstChild && App.onScreen('home'); }
  // While Today is hidden or covered (ambient, night) nothing is painted; it catches up on return.
  function later() { if (V.el && V.el.firstChild) V.stale = true; return false; }
  // Every minute: just the clock and next-up countdown. Weather on the hour.
  App.on('minute', function (n) {
    if (!shown()) return later();
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    fitHero(V.el);
    paintWalk();
    if (n.getMinutes() === 0) { paint(); }
  });
  // The walk timer ticks on its own: only its text changes.
  App.on('second', function () {
    if (!App.walk.active || App.walk.active.endedAt || !shown()) return;
    var t = V.timer && V.timer.isConnected ? V.timer : (V.timer = V.el.querySelector('.h-walk-timer'));
    if (t) t.textContent = dur(Date.now() - App.walk.active.startedAt);
  });
  App.on('walk', function () { if (shown()) paintWalk(); else later(); });
  App.on('data', function (what) {
    if (what === 'reminders') {
      paintPinnedSheet();
      if (!shown()) return later();
      return App.reminders ? paintTodos() : paint();
    }
    if (shown()) paint(); else later();
  });
  App.on('todo', paintPinnedSheet);
  App.on('ha', function () {
    if (!shown()) return later();
    var el = V.el.querySelector('.h-status'), h = el && status();
    if (el && h !== el._html) { el._html = h; el.innerHTML = h; }
  });
  // The web fonts arrive after the first paint (font-display: swap): fit the hero title again.
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', function () { if (shown()) fitHero(V.el); });
  }
})();
