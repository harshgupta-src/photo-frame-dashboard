// The dog tab: how the dog's day is going and the week's rhythm, from App.dog (plan vs what happened).
//   top     age + weight, time since the last pee and poop (against the usual gap), next meal and
//           walk (with who's busy then), and the walk button (same as the Today tile)
//   today   one timeline: walks (planned ones dashed), pee/poop, meals (fed, due, late, upcoming)
//   meals   today's meals: cups fed of planned, who fed, how late or early
//   rhythm  the last 7 days as rows on the same clock, plus walking time per person
//   food    the kibble mix (food transition) today and tomorrow, cups fed per day vs the plan
//   growth  weigh-ins, and what's next on the dog's calendar (training, vet, grooming)
// Tap a walk to edit it.
(function () {
  'use strict';
  var V = { el: null }, MIN = 60e3, H = 3600e3, DAY0 = 6, DAY1 = 23;
  var name = window.CONFIG.dog;
  var POTTY = { pee: { icon: 'drop', label: 'Pee' }, poop: { icon: 'poop', label: 'Poop' } };
  var MEAL_ICON = { 'Breakfast': 'sunrise', 'Walk snack': 'paw', 'Lunch': 'utensils', 'Dinner': 'utensils', 'Night snack': 'moon', 'Extra': 'heart' };

  var rail = document.querySelector('.rail-item[data-go="dog"] span');
  if (rail) rail.textContent = name;

  var esc = App.esc;
  function now() { return +App.now(); }
  function ago(ms) {
    var m = Math.max(0, Math.round(ms / MIN));
    if (m < 60) return m + '<small>m</small>';
    var h = Math.floor(m / 60), r = m % 60;
    return h + '<small>h</small>' + (h < 10 && r ? ' ' + r + '<small>m</small>' : '');
  }
  function dur(ms) { var m = Math.round(ms / MIN); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); }
  var FR = { 25: '¼', 33: '⅓', 50: '½', 67: '⅔', 75: '¾' };
  function cups(c, unit) {
    if (c == null) return '';
    var w = Math.floor(c + 1e-6), f = FR[Math.round((c - w) * 100)];
    var s = f ? (w ? w : '') + f : String(Math.round(c * 100) / 100);
    return unit === false ? s : s + ' cup' + (c > 1 ? 's' : '');
  }
  function pname(id) { return App.person(id).name; }
  function x(t, day0) { return Math.max(0, Math.min(100, (t - day0 - DAY0 * H) / ((DAY1 - DAY0) * H) * 100)); }
  function walkMins(w) { return ((w.endedAt || now()) - w.startedAt) / MIN; }
  function walkColor(w) { return w.walkers && w.walkers.length === 1 ? App.pstyle(w.walkers[0].id) : App.pstyle('family'); }

  // ---------------------------------------------------------------- header
  function chip(kind) {
    var last = App.dog.potty(now() - 3 * 864e5).filter(function (p) { return p.kind === kind; })[0];
    var gap = App.dog.gap(kind), since = last ? now() - last.at : null, cls = '';
    var night = new Date(now()).getHours() < 7 || new Date(now()).getHours() >= 22;
    if (since != null && gap && !night) cls = since > gap * 1.5 ? ' is-alert' : since > gap ? ' is-warn' : ' is-ok';
    return '<div class="dg-chip dg-chip--' + kind + cls + '">' +
      '<span class="dg-chip-ic">' + App.icon(POTTY[kind].icon, 20) + '</span>' +
      '<div><div class="label">Last ' + POTTY[kind].label.toLowerCase() + '</div>' +
      '<b class="num">' + (since == null ? '—' : ago(since)) + (since == null ? '' : '<small> ago</small>') + '</b>' +
      '<span class="dg-chip-sub">' + (gap ? 'usually every ' + dur(Math.round(gap / 15 / MIN) * 15 * MIN) : last ? App.fmt.time(new Date(last.at)) : 'nothing logged') + '</span></div></div>';
  }
  function nextMeal() {
    var t = now(), list = App.dog.day(new Date(t)).meals.concat(App.dog.day(App.addDays(new Date(t), 1)).meals);
    return list.filter(function (m) { return m.status === 'due' || m.status === 'late' || m.status === 'upcoming'; })[0];
  }
  function busyNote(ids, at) {
    var busy = (ids || []).map(function (id) { var e = App.dog.busy(id, at, 20); return e ? pname(id) : null; }).filter(Boolean);
    return busy.length && busy.length === (ids || []).length ? '<em>' + esc(busy.join(' & ')) + ' busy then</em>' : '';
  }
  function owners(m) {
    var all = window.CONFIG.people.length && m.owners.length >= window.CONFIG.people.length;
    return all ? 'Anyone' : m.owners.map(pname).join(' & ');
  }
  function mealChip() {
    var m = nextMeal();
    if (!m) return '';
    var due = m.status !== 'upcoming';
    return '<div class="dg-chip dg-chip--meal' + (m.status === 'late' ? ' is-alert' : due ? ' is-warn' : '') + '">' +
      '<span class="dg-chip-ic">' + App.icon(MEAL_ICON[m.meal] || 'utensils', 20) + '</span>' +
      '<div><div class="label">' + (m.status === 'late' ? 'Not fed yet' : due ? 'Due now' : 'Next meal') + '</div>' +
      '<b>' + esc(m.meal) + ' <span class="num">' + App.fmt.time(m.at) + '</span></b>' +
      '<span class="dg-chip-sub">' + [cups(m.cups), m.owners.length ? owners(m) : ''].filter(Boolean).join(' · ') + ' ' + busyNote(m.owners, m.at) + '</span></div></div>';
  }
  function walkChip() {
    var n = App.walk.next();
    if (!n) return '';
    var at = new Date(n.start), late = +at < now();
    return '<div class="dg-chip dg-chip--walk' + (late ? ' is-warn' : '') + '">' +
      '<span class="dg-chip-ic">' + App.icon('clock', 20) + '</span>' +
      '<div><div class="label">' + (late ? 'Walk due' : 'Next walk') + '</div>' +
      '<b class="num">' + App.fmt.time(at) + ' <small>· ' + n.durationMin + 'm</small></b>' +
      '<span class="dg-chip-sub">' + esc((n.walkers || []).join(' & ')) + ' ' + busyNote(n.walkerIds, at) + '</span></div></div>';
  }
  function walkButton() {
    var a = App.walk.active;
    if (a && !a.endedAt) {
      return '<button class="dg-walk is-on" data-walk="back"><i class="pulse"></i><span><b>I’m back</b><small class="num">' + dur(now() - a.startedAt) + ' out</small></span></button>';
    }
    return '<button class="dg-walk" data-walk="start">' + App.icon('paw', 26) + '<span><b>Start walk</b><small>' + esc(name) + ' is going out</small></span></button>';
  }
  function top() {
    var age = App.dog.age(), w = App.dog.weights(), last = w[w.length - 1], meta = [];
    if (age) meta.push(age.weeks < 52 ? age.weeks + ' weeks old' : age.months + ' months old');
    if (last) meta.push(last.kg + ' kg');
    return '<header class="dg-top">' +
      '<div class="dg-id"><span class="dg-badge">' + App.icon('paw', 34) + '</span><div>' +
      '<div class="label">' + (meta.join(' · ') || 'Care dashboard') + (App.dog.demo ? ' · <b>demo data</b>' : '') + '</div>' +
      '<h1 class="serif">' + esc(name) + '</h1></div></div>' +
      '<div class="dg-chips">' + chip('pee') + chip('poop') + mealChip() + walkChip() + '</div>' +
      walkButton() + '</header>';
  }

  // ---------------------------------------------------------------- today's timeline
  function hours(cls) {
    var s = '';
    for (var h = DAY0; h <= DAY1; h += 3) {
      var d = new Date(2000, 0, 1, h);
      s += '<span class="' + cls + '" style="left:' + ((h - DAY0) / (DAY1 - DAY0) * 100) + '%">' + App.fmt.hour(d).replace(':00', '') + '</span>';
    }
    return s;
  }
  function timeline() {
    var today = App.dayStart(new Date(now())), d0 = +today, t = App.dog.day(today), lanes = { walk: '', potty: '', meal: '' };
    t.plannedWalks.forEach(function (p) {
      var a = x(Date.parse(p.start), d0), b = x(Date.parse(p.end), d0);
      lanes.walk += '<i class="dg-plan' + (p.status === 'missed' ? ' is-missed' : '') + '" style="left:' + a + '%;width:' + Math.max(b - a, 0.8) + '%" title="Planned"></i>';
    });
    t.walks.forEach(function (w) {
      var a = x(w.startedAt, d0), b = x(w.endedAt || now(), d0), m = walkMins(w);
      lanes.walk += '<button class="dg-bar' + (w.endedAt ? '' : ' is-live') + '" data-walk-id="' + esc(w.id) + '" style="' + walkColor(w) + ';left:' + a + '%;width:' + Math.max(b - a, 0.9) + '%">' +
        (b - a > 3.2 ? '<span class="num">' + Math.round(m) + 'm</span>' : '') + '</button>';
    });
    t.potty.forEach(function (p) {
      lanes.potty += '<i class="dg-dot dg-dot--' + p.kind + '" style="left:' + x(p.at, d0) + '%">' + App.icon(POTTY[p.kind].icon, 14) + '</i>';
    });
    t.meals.forEach(function (m) {
      var at = m.status === 'fed' ? +m.fedAt : +m.at;
      if (m.status === 'fed' && m.deltaMin && Math.abs(m.deltaMin) >= 10) {
        var a = x(Math.min(+m.at, at), d0), b = x(Math.max(+m.at, at), d0);
        lanes.meal += '<i class="dg-drift' + (m.deltaMin > 0 ? ' is-late' : '') + '" style="left:' + a + '%;width:' + (b - a) + '%"></i>';
      }
      lanes.meal += '<i class="dg-meal is-' + m.status + '" style="left:' + x(at, d0) + '%">' +
        App.icon(m.status === 'fed' ? 'check' : MEAL_ICON[m.meal] || 'utensils', 15) + '<b>' + esc(m.meal === 'Walk snack' ? 'Snack' : m.meal.replace(' snack', '')) + '</b></i>';
    });
    var n = now(), nowLine = n > d0 + DAY0 * H && n < d0 + DAY1 * H ? '<i class="dg-now" style="left:' + x(n, d0) + '%"><b>' + App.fmt.time(new Date(n), false) + '</b></i>' : '';
    var walked = t.walks.reduce(function (s, w) { return s + walkMins(w); }, 0);
    var counts = { pee: 0, poop: 0 };
    t.potty.forEach(function (p) { counts[p.kind]++; });
    return '<section class="dg-card dg-today">' +
      '<header class="dg-head"><div class="label">Today</div><div class="dg-sum">' +
      '<span><b class="num">' + t.walks.length + '</b> walks · <b class="num">' + dur(walked * MIN) + '</b></span>' +
      '<span class="dg-k dg-k--pee"><i></i><b class="num">' + counts.pee + '</b> pee</span>' +
      '<span class="dg-k dg-k--poop"><i></i><b class="num">' + counts.poop + '</b> poop</span>' +
      (t.planNote ? '<span class="dg-note">' + esc(t.planNote) + '</span>' : '') + '</div></header>' +
      '<div class="dg-tl">' +
      '<div class="dg-lanes"><span>Walks</span><span>Potty</span><span>Meals</span></div>' +
      '<div class="dg-track">' + hours('dg-hr') +
      '<div class="dg-lane dg-lane--walk">' + lanes.walk + '</div>' +
      '<div class="dg-lane dg-lane--potty">' + lanes.potty + '</div>' +
      '<div class="dg-lane dg-lane--meal">' + lanes.meal + '</div>' + nowLine + '</div></div></section>';
  }

  // ---------------------------------------------------------------- meals today
  function donut(fed, plan) {
    var r = 46, c = 2 * Math.PI * r, p = plan ? Math.min(1, fed / plan) : 0;
    return '<svg class="dg-donut" viewBox="0 0 112 112" width="112" height="112"><circle cx="56" cy="56" r="' + r + '" class="dg-donut-bg"/>' +
      '<circle cx="56" cy="56" r="' + r + '" class="dg-donut-fg" stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 56 56)"/>' +
      '<text x="56" y="56" class="dg-donut-v">' + (cups(fed, false) || '0') + '</text><text x="56" y="78" class="dg-donut-l">of ' + cups(plan, false) + ' cups</text></svg>';
  }
  function mealRow(m) {
    var right;
    if (m.status === 'fed') {
      var d = m.deltaMin, when = d == null || Math.abs(d) < 5 ? 'on time' : Math.abs(d) + ' min ' + (d > 0 ? 'late' : 'early');
      right = (m.by ? App.avatar(m.by, 30) : '') + '<span class="dg-when' + (d > 30 ? ' is-late' : '') + '">' + App.fmt.time(m.fedAt) + '<small>' + when + '</small></span>';
    } else if (m.status === 'due') right = '<span class="pill pill--soon">Due</span>';
    else if (m.status === 'late') right = '<span class="pill pill--alert">' + dur(now() - m.at) + ' late</span>';
    else right = '<span class="dg-when dg-when--plan">' + (m.owners.length ? owners(m) : '') + '</span>';
    return '<li class="dg-mrow is-' + m.status + '"><span class="dg-mic">' + App.icon(m.status === 'fed' ? 'check' : MEAL_ICON[m.meal] || 'utensils', 18) + '</span>' +
      '<span class="dg-mname"><b>' + esc(m.meal) + '</b><small class="num">' + App.fmt.time(m.at) + (m.cups != null ? ' · ' + cups(m.cups) : '') + (m.ate === false || (typeof m.ate === 'string' && !/^(all|yes|true)$/i.test(m.ate)) ? ' · ate ' + esc(m.ate === false ? 'some' : m.ate) : '') + '</small></span>' +
      '<span class="dg-mright">' + right + '</span></li>';
  }
  function mealsCard() {
    var list = App.dog.day(new Date(now())).meals, fed = 0, plan = 0, done = 0;
    list.forEach(function (m) { plan += m.cups || 0; if (m.status === 'fed') { fed += m.cups || 0; done++; } });
    return '<section class="dg-card dg-meals"><header class="dg-head"><div class="label">Meals today</div>' +
      '<span class="dg-sum"><b class="num">' + done + '</b>&nbsp;of ' + list.length + ' fed</span></header>' +
      (list.length ? '<div class="dg-meals-body">' + donut(fed, plan) + '<ul class="dg-mlist">' + list.map(mealRow).join('') + '</ul></div>'
        : '<p class="dg-empty">No meals on the calendar today.</p>') + '</section>';
  }

  // ---------------------------------------------------------------- 7-day rhythm
  function week() {
    var today = App.dayStart(new Date(now())), rows = '', tot = { walks: 0, mins: 0, pee: 0, poop: 0, fed: 0, onTime: 0, m: 0 }, by = {}, km = 0;
    for (var i = 6; i >= 0; i--) {
      var day = App.addDays(today, -i), d0 = +day, t = App.dog.day(day), lane = '', c = { pee: 0, poop: 0 };
      t.walks.forEach(function (w) {
        var a = x(w.startedAt, d0), b = x(w.endedAt || now(), d0), m = walkMins(w);
        lane += '<i class="dg-wbar" style="' + walkColor(w) + ';left:' + a + '%;width:' + Math.max(b - a, 0.7) + '%"></i>';
        tot.walks++; tot.mins += m;
        (w.walkers || []).forEach(function (p) { by[p.id] = (by[p.id] || 0) + m; });
        km += (App.dog.distance(w.id) || 0) / 1000;
      });
      t.potty.forEach(function (p) { c[p.kind]++; tot[p.kind]++; lane += '<i class="dg-pdot dg-pdot--' + p.kind + '" style="left:' + x(p.at, d0) + '%"></i>'; });
      t.meals.forEach(function (m) {
        if (m.status === 'fed') { tot.fed++; if (m.deltaMin == null || Math.abs(m.deltaMin) <= 30) tot.onTime++; }
        if (m.status === 'fed' || m.status === 'late') tot.m++;
        lane += '<i class="dg-mtick is-' + m.status + '" style="left:' + x(m.status === 'fed' ? +m.fedAt : +m.at, d0) + '%"></i>';
      });
      rows += '<div class="dg-wrow' + (i === 0 ? ' is-today' : '') + '"><span class="dg-wday">' + (i === 0 ? 'Today' : App.fmt.dayShort(day)) + '</span>' +
        '<div class="dg-wlane">' + lane + '</div><span class="dg-wcount num"><em class="dg-k--walk">' + t.walks.length + '</em><em class="dg-k--pee">' + c.pee + '</em><em class="dg-k--poop">' + c.poop + '</em></span></div>';
    }
    var share = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }), all = share.reduce(function (s, k) { return s + by[k]; }, 0);
    var stats = [
      [(tot.walks / 7).toFixed(1), 'walks a day'],
      [dur(tot.mins / 7 * MIN), 'walking a day'],
      [(tot.poop / 7).toFixed(1), 'poops a day'],
      [tot.m ? Math.round(tot.onTime / tot.m * 100) + '%' : '—', 'meals on time']
    ];
    if (km) stats[1] = [km.toFixed(1) + ' km', dur(tot.mins / 7 * MIN) + ' a day'];
    return '<section class="dg-card dg-week"><header class="dg-head"><div class="label">Rhythm · 7 days</div>' +
      '<span class="dg-legend"><span class="dg-k dg-k--walk"><i></i>walk</span><span class="dg-k dg-k--pee"><i></i>pee</span><span class="dg-k dg-k--poop"><i></i>poop</span><span class="dg-k dg-k--meal"><i></i>meal</span></span></header>' +
      '<div class="dg-wgrid"><div class="dg-wrow dg-wrow--axis"><span></span><div class="dg-wlane">' + hours('dg-whr') + '</div><span></span></div>' + rows + '</div>' +
      '<div class="dg-stats">' + stats.map(function (s) { return '<div><b class="num">' + s[0] + '</b><small>' + s[1] + '</small></div>'; }).join('') + '</div>' +
      (all ? '<div class="dg-share"><div class="dg-share-bar">' + share.map(function (k) {
        return '<i style="' + App.pstyle(k) + ';width:' + (by[k] / all * 100) + '%"></i>';
      }).join('') + '</div><div class="dg-share-legend">' + share.map(function (k) {
        return '<span style="' + App.pstyle(k) + '"><i></i>' + esc(pname(k)) + ' <b class="num">' + Math.round(by[k] / all * 100) + '%</b></span>';
      }).join('') + '<span class="dg-share-t">of walking time</span></div></div>' : '') +
      '</section>';
  }

  // ---------------------------------------------------------------- food, growth, next up
  function mixBar(p, label) {
    if (!p) return '';
    return '<div class="dg-mix"><div class="dg-mix-top"><span>' + label + '</span><b class="num">' + cups(p.total) + '</b></div>' +
      '<div class="dg-mix-bar">' + p.foods.map(function (f, i) { return '<i class="f' + i + '" style="width:' + f.pct + '%"></i>'; }).join('') + '</div>' +
      '<div class="dg-mix-legend">' + p.foods.map(function (f, i) { return '<span class="f' + i + '"><i></i>' + esc(f.name) + ' <b class="num">' + f.pct + '%</b></span>'; }).join('') + '</div></div>';
  }
  function food() {
    var today = App.dayStart(new Date(now())), t = App.dog.day(today).prep, tm = App.dog.day(App.addDays(today, 1)).prep, bars = '', max = 0, days = [];
    for (var i = 6; i >= 0; i--) {
      var day = App.addDays(today, -i), ms = App.dog.day(day).meals, f = 0, p = 0;
      ms.forEach(function (m) { p += m.cups || 0; if (m.status === 'fed') f += m.cups || 0; });
      days.push({ day: day, fed: f, plan: p, today: i === 0 });
      max = Math.max(max, f, p);
    }
    days.forEach(function (d) {
      bars += '<div class="dg-fcol' + (d.today ? ' is-today' : '') + '"><div class="dg-fbar">' +
        (d.plan ? '<i class="dg-fplan" style="height:' + (d.plan / (max || 1) * 100) + '%"></i>' : '') +
        '<i class="dg-ffed" style="height:' + (d.fed / (max || 1) * 100) + '%"></i></div>' +
        '<small>' + (d.today ? 'Today' : App.fmt.dayShort(d.day).slice(0, 2)) + '</small></div>';
    });
    var change = t && tm && JSON.stringify(t.foods.map(function (f) { return f.pct; })) !== JSON.stringify(tm.foods.map(function (f) { return f.pct; }));
    return '<section class="dg-card dg-food"><header class="dg-head"><div class="label">Food</div>' +
      '<span class="dg-sum">cups fed vs plan</span></header>' +
      '<div class="dg-fchart">' + bars + '</div>' +
      (t ? mixBar(t, 'Today’s mix') : '') + (change ? mixBar(tm, 'Tomorrow') : '') +
      (!t && !tm ? '<p class="dg-empty">Add a “' + esc(name) + ' prep” event with the mix in its notes to see the food transition.</p>' : '') +
      '</section>';
  }
  function spark(w) {
    var W = 110, Hh = 44, a = w[0].at, b = w[w.length - 1].at, lo = Math.min.apply(null, w.map(function (p) { return p.kg; })), hi = Math.max.apply(null, w.map(function (p) { return p.kg; }));
    var pts = w.map(function (p) { return ((b > a ? (p.at - a) / (b - a) : 1) * (W - 8) + 4).toFixed(1) + ',' + (Hh - 5 - (hi > lo ? (p.kg - lo) / (hi - lo) : 0.5) * (Hh - 10)).toFixed(1); });
    var last = pts[pts.length - 1].split(',');
    return '<svg class="dg-spark" width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '"><polyline points="' + pts.join(' ') + '"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="4"/></svg>';
  }
  function upDay(d) {
    var days = Math.round((App.dayStart(d) - App.dayStart(new Date(now()))) / 864e5);
    return days < 2 ? App.fmt.rel(d) : days < 7 ? App.fmt.dayShort(d) : App.fmt.monthShort(d) + ' ' + d.getDate();
  }
  function growth() {
    var w = App.dog.weights(), last = w[w.length - 1], html = '';
    if (last) {
      var prev = w.filter(function (p) { return p.at <= last.at - 5 * 864e5; }).pop(), rate = prev ? (last.kg - prev.kg) / ((last.at - prev.at) / (7 * 864e5)) : null;
      html = '<div class="dg-growth"><div><b class="num">' + last.kg + '<small> kg</small></b>' +
        '<small>' + (rate != null ? (rate >= 0 ? '+' : '') + rate.toFixed(1) + ' kg/week · ' : '') + App.fmt.monthShort(new Date(last.at)) + ' ' + new Date(last.at).getDate() + (last.where ? ' · ' + esc(last.where) : '') + '</small></div>' +
        (w.length > 1 ? spark(w) : '') + '</div>';
    } else html = '<p class="dg-empty">No weigh-ins logged yet.</p>';
    var up = App.dog.upcoming(2);
    return '<section class="dg-card dg-growthcard"><header class="dg-head"><div class="label">Growth</div></header>' + html +
      (up.length ? '<div class="label dg-sub">Coming up</div><ul class="dg-up">' + up.map(function (e) {
        var t = e.title.replace(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:’s|\'s)?\\s*', 'i'), '') || e.title;
        return '<li><span class="dg-up-d num">' + upDay(e.start) + ' ' + App.fmt.time(e.start) + '</span><span class="dg-up-t">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</span></li>';
      }).join('') + '</ul>' : '') + '</section>';
  }

  function render() {
    if (!V.el) return;
    V.el.innerHTML = '<div class="dg">' + top() + timeline() + mealsCard() + week() + '<div class="dg-side">' + food() + growth() + '</div></div>';
  }

  function click(e) {
    var b = e.target.closest('[data-walk]');
    if (b) { App.walkTap(b.dataset.walk); return; }
    b = e.target.closest('[data-walk-id]');
    if (!b) return;
    var id = b.dataset.walkId, w = App.dog.walks().filter(function (r) { return r.id === id; })[0];
    if (!w) return;
    if (/^demo-/.test(id)) { App.toast('Demo walk · connect the Worker to log real ones', { icon: 'paw' }); return; }
    if (!w.endedAt) App.walkTap('back'); else App.walkSheet(w);
  }

  App.register('dog', {
    minutely: true,
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', click); }
      render();
    }
  });
  function update() {
    if (App.current === 'dog') render();
    else if (App.views.dog) App.views.dog._dirty = true;
  }
  App.on('dog', update);
  App.on('walk', update);
  App.on('data', update);
  App.on('minute', function () { if (App.current === 'dog') render(); });
})();
