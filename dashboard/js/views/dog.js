// The dog tab, built to be read from across the room (from App.dog: plan vs what happened).
//   top     name, age and weight, and the walk button (same as the Today tile)
//   now     four big tiles: time since the last pee and poop (against the usual gap), next meal, next walk
//   today   today's meals as a checklist (fed by whom, or due/late), the kibble mix, and today's walks
//   route   the last walk's GPS path on a map, with distance, time and who walked
//   week    one bar chart: minutes walked per day, with each day's pee and poop counts
//   weight  the latest weigh-in, the weekly gain, and every weigh-in on one line (estimates hollow)
// Tap a walk (or the map) to edit it.
(function () {
  'use strict';
  var V = { el: null, map: null, mapKey: '' }, MIN = 60e3;
  var name = window.CONFIG.dog;
  var MEAL_ICON = { 'Breakfast': 'sunrise', 'Walk snack': 'paw', 'Lunch': 'utensils', 'Dinner': 'utensils', 'Night snack': 'moon', 'Extra': 'heart' };

  var rail = document.querySelector('.rail-item[data-go="dog"] span');
  if (rail) rail.textContent = name;

  var esc = App.esc;
  function now() { return +App.now(); }
  function dur(ms) { var m = Math.max(0, Math.round(ms / MIN)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); }
  var FR = { 25: '¼', 33: '⅓', 50: '½', 67: '⅔', 75: '¾' };
  function cups(c) {
    if (c == null) return '';
    var w = Math.floor(c + 1e-6), f = FR[Math.round((c - w) * 100)];
    return (f ? (w ? w : '') + f : String(Math.round(c * 100) / 100)) + ' cup' + (c > 1 ? 's' : '');
  }
  function pname(id) { return App.person(id).name; }
  function walkMins(w) { return ((w.endedAt || now()) - w.startedAt) / MIN; }
  function potty(w) { return (w.pee ? '💧' : '') + (w.poop ? '💩' : ''); }
  function who(list) { return (list || []).map(function (p) { return p.name || pname(p.id); }).join(' & '); }
  function dayLabel(ms) {
    var d = new Date(ms), t = App.dayStart(new Date(now())), days = Math.round((App.dayStart(d) - t) / 864e5);
    return days === 0 ? 'Today' : days === -1 ? 'Yesterday' : App.fmt.dayShort(d);
  }

  // ---------------------------------------------------------------- header
  function walkButton() {
    var a = App.walk.active;
    if (a && !a.endedAt) return '<button class="dg-walk is-on" data-walk="back"><i class="pulse"></i><b>I’m back</b></button>';
    return '<button class="dg-walk" data-walk="start">' + App.icon('paw', 26) + '<b>Start walk</b></button>';
  }
  function top() {
    var age = App.dog.age(), meta = [];
    if (age) meta.push(age.weeks < 52 ? age.weeks + ' weeks old' : age.months + ' months old');
    var up = App.dog.upcoming(1)[0];
    if (up) meta.push('Next: ' + esc(up.title.replace(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:’s|\'s)?\\s*', 'i'), '') || up.title) + ' ' + dayLabel(+up.start) + ' ' + App.fmt.hour(up.start));
    return '<header class="dg-top"><div class="dg-id"><h1 class="serif">' + esc(name) + '</h1>' +
      '<div class="dg-meta">' + (meta.join(' · ') || 'Care dashboard') + (App.dog.demo ? ' · <b>demo data</b>' : '') + '</div></div>' +
      walkButton() + '</header>';
  }

  // ---------------------------------------------------------------- the four "now" tiles
  function tile(kind, icon, k, v, sub, state) {
    return '<div class="dg-tile dg-tile--' + kind + (state ? ' is-' + state : '') + '">' +
      '<div class="dg-tile-k"><span class="dg-ic">' + App.icon(icon, 18) + '</span>' + k + '</div>' +
      '<b class="dg-tile-v">' + v + '</b><small class="dg-tile-s">' + (sub || '&nbsp;') + '</small></div>';
  }
  function pottyTile(kind) {
    var last = App.dog.potty(now() - 3 * 864e5).filter(function (p) { return p.kind === kind; })[0];
    var gap = App.dog.gap(kind), since = last ? now() - last.at : null, h = new Date(now()).getHours(), state = '';
    if (since != null && gap && h >= 7 && h < 22) state = since > gap * 1.5 ? 'alert' : since > gap ? 'warn' : '';
    var label = kind === 'pee' ? 'Last pee' : 'Last poop';
    return tile(kind, kind === 'pee' ? 'drop' : 'poop', label,
      since == null ? '—' : '<span class="num">' + dur(since) + '</span> ago',
      last ? App.fmt.time(new Date(last.at)) + (gap ? ' · usually every ' + dur(Math.round(gap / 15 / MIN) * 15 * MIN) : '') : 'Nothing logged', state);
  }
  function owners(m) {
    var all = window.CONFIG.people.length && m.owners.length >= window.CONFIG.people.length;
    return all ? 'Anyone' : m.owners.map(pname).join(' & ');
  }
  function busy(ids, at) {
    var b = (ids || []).filter(function (id) { return App.dog.busy(id, at, 20); });
    return b.length && b.length === (ids || []).length ? ' · <em>' + esc(b.map(pname).join(' & ')) + ' busy</em>' : '';
  }
  function mealTile() {
    var t = now(), list = App.dog.day(new Date(t)).meals.concat(App.dog.day(App.addDays(new Date(t), 1)).meals);
    var m = list.filter(function (x) { return x.status === 'due' || x.status === 'late' || x.status === 'upcoming'; })[0];
    if (!m) return tile('meal', 'utensils', 'Next meal', '—', 'Nothing planned');
    var k = m.status === 'late' ? 'Not fed yet' : m.status === 'due' ? 'Meal due' : 'Next meal';
    return tile('meal', MEAL_ICON[m.meal] || 'utensils', k, esc(m.meal) + ' <span class="num dg-tile-t">' + App.fmt.time(m.at) + '</span>',
      [cups(m.cups), m.owners.length ? esc(owners(m)) : ''].filter(Boolean).join(' · ') + busy(m.owners, m.at),
      m.status === 'late' ? 'alert' : m.status === 'due' ? 'warn' : '');
  }
  function walkTile() {
    var a = App.walk.active;
    if (a && !a.endedAt) return tile('walk', 'paw', 'Out walking', '<span class="num">' + dur(now() - a.startedAt) + '</span>', 'Since ' + App.fmt.time(new Date(a.startedAt)) + ' · ' + esc(who(a.walkers)), 'live');
    var n = App.walk.next();
    if (!n) return tile('walk', 'paw', 'Next walk', '—', 'None planned');
    var at = new Date(n.start), late = +at < now();
    return tile('walk', 'paw', late ? 'Walk due' : 'Next walk', '<span class="num">' + App.fmt.time(at) + '</span>',
      esc((n.walkers || []).join(' & ')) + ' · ' + n.durationMin + ' min' + busy(n.walkerIds, at), late ? 'warn' : '');
  }

  // ---------------------------------------------------------------- today: meals + walks
  function mealRow(m) {
    var right;
    if (m.status === 'fed') {
      var d = m.deltaMin, when = d == null || Math.abs(d) < 10 ? 'on time' : Math.abs(d) + ' min ' + (d > 0 ? 'late' : 'early');
      right = '<span class="dg-m-r"><b class="num">' + App.fmt.time(m.fedAt) + '</b><small>' + (m.by ? esc(pname(m.by)) + ' · ' : '') + when + '</small></span>';
    } else if (m.status === 'due') right = '<span class="pill pill--soon">Due</span>';
    else if (m.status === 'late') right = '<span class="pill pill--alert">' + dur(now() - m.at) + ' late</span>';
    else if (m.status === 'unlogged') right = '<span class="dg-m-r"><small>Not logged</small></span>';
    else right = '<span class="dg-m-r"><small>' + (m.owners.length ? esc(owners(m)) : '') + '</small></span>';
    return '<li class="dg-m is-' + m.status + '"><span class="dg-m-ic">' + App.icon(m.status === 'fed' ? 'check' : MEAL_ICON[m.meal] || 'utensils', 18) + '</span>' +
      '<span class="dg-m-n"><b>' + esc(m.meal) + '</b><small class="num">' + App.fmt.time(m.at) + (m.cups != null ? ' · ' + cups(m.cups) : '') + '</small></span>' + right + '</li>';
  }
  function today() {
    var t = App.dog.day(new Date(now())), fed = t.meals.filter(function (m) { return m.status === 'fed'; }).length;
    var walks = t.walks.slice().sort(function (a, b) { return b.startedAt - a.startedAt; });
    var mix = t.prep && t.prep.foods && t.prep.foods.length > 1 ? '<p class="dg-mix">Mix: ' + t.prep.foods.map(function (f) { return esc(f.name) + ' <b class="num">' + f.pct + '%</b>'; }).join(' · ') + '</p>' : '';
    return '<section class="dg-card dg-today">' +
      '<header class="dg-head"><span class="label">Meals today</span><span class="dg-sum"><b class="num">' + fed + '</b> of ' + t.meals.length + ' fed</span></header>' +
      (t.meals.length ? '<ul class="dg-meals">' + t.meals.map(mealRow).join('') + '</ul>' : '<p class="dg-empty">No meals on the calendar today.</p>') + mix +
      '<header class="dg-head dg-head--walks"><span class="label">Walks today</span><span class="dg-sum"><b class="num">' + walks.length + '</b> · ' + dur(walks.reduce(function (s, w) { return s + walkMins(w); }, 0) * MIN) + '</span></header>' +
      (walks.length ? '<ul class="dg-walks">' + walks.map(function (w) {
        var c = w.walkers && w.walkers.length === 1 ? App.pstyle(w.walkers[0].id) : App.pstyle('family');
        return '<li><button class="dg-wk' + (w.endedAt ? '' : ' is-live') + '" data-walk-id="' + esc(w.id) + '" style="' + c + '"><i></i>' +
          '<span class="num">' + App.fmt.time(new Date(w.startedAt)) + '</span><b class="num">' + dur(walkMins(w) * MIN) + '</b><span class="dg-wk-p">' + potty(w) + '</span></button></li>';
      }).join('') + '</ul>' : '<p class="dg-empty">No walks yet today.</p>') + '</section>';
  }

  // ---------------------------------------------------------------- last walk route
  // Web Mercator pixels at zoom z.
  function merc(p, z) {
    var s = 256 * Math.pow(2, z), sin = Math.sin(p[0] * Math.PI / 180);
    return [(p[1] + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function mapHTML(r, w, h) {
    var z, xy, x0, x1, y0, y1;
    for (z = 17; z > 10; z--) {
      xy = r.path.map(function (p) { return merc(p, z); });
      x0 = Math.min.apply(null, xy.map(function (p) { return p[0]; })); x1 = Math.max.apply(null, xy.map(function (p) { return p[0]; }));
      y0 = Math.min.apply(null, xy.map(function (p) { return p[1]; })); y1 = Math.max.apply(null, xy.map(function (p) { return p[1]; }));
      if (x1 - x0 <= w * 0.8 && y1 - y0 <= h * 0.8) break;
    }
    var ox = Math.round((x0 + x1) / 2 - w / 2), oy = Math.round((y0 + y1) / 2 - h / 2), tiles = '';
    for (var tx = Math.floor(ox / 256); tx * 256 < ox + w; tx++) {
      for (var ty = Math.floor(oy / 256); ty * 256 < oy + h; ty++) {
        var src = App.dog.tileUrl(z, tx, ty);
        if (src) tiles += '<img alt="" src="' + esc(src) + '" style="left:' + (tx * 256 - ox) + 'px;top:' + (ty * 256 - oy) + 'px" onerror="this.remove()">';
      }
    }
    var pts = xy.map(function (p) { return (p[0] - ox).toFixed(1) + ',' + (p[1] - oy).toFixed(1); }), a = pts[0].split(','), b = pts[pts.length - 1].split(',');
    return tiles + '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polyline class="dg-path-c" points="' + pts.join(' ') + '"/><polyline class="dg-path" points="' + pts.join(' ') + '"/>' +
      '<circle class="dg-pin-s" cx="' + a[0] + '" cy="' + a[1] + '" r="8"/><circle class="dg-pin-e" cx="' + b[0] + '" cy="' + b[1] + '" r="9"/></svg>' +
      (tiles ? '<small class="dg-attr">© OpenStreetMap</small>' : '');
  }
  function route() {
    var r = App.dog.lastRoute(), w = r && App.dog.walks().filter(function (x) { return x.id === r.walkId; })[0];
    if (!r) return '<section class="dg-card dg-route"><header class="dg-head"><span class="label">Last walk route</span></header><p class="dg-empty">Routes show up here after a walk with a phone’s location on.</p></section>';
    var s = Date.parse(r.start), e = Date.parse(r.end), stats = [];
    if (r.m != null) stats.push('<span><b class="num">' + (r.m >= 1000 ? (r.m / 1000).toFixed(1) + '</b> km' : r.m + '</b> m') + '</span>');
    if (e > s) { var mm = Math.round((e - s) / MIN); stats.push('<span><b class="num">' + mm + '</b> min</span>'); }
    if (w && potty(w)) stats.push('<span class="dg-rp">' + potty(w) + '</span>');
    return '<section class="dg-card dg-route"' + (w ? ' data-walk-id="' + esc(w.id) + '"' : '') + '>' +
      '<header class="dg-head"><span class="label">Last walk route</span><span class="dg-sum">' + dayLabel(s) + ' · ' + App.fmt.time(new Date(s)) + '</span></header>' +
      '<div class="dg-rstats">' + stats.join('') + (w && w.walkers && w.walkers.length ? '<span class="dg-rwho">' + w.walkers.map(function (p) { return App.avatar(p.id, 34); }).join('') + '</span>' : '') + '</div>' +
      '<div class="dg-map" data-map></div></section>';
  }
  // The map is kept between the minutely re-renders (no tile flicker) and rebuilt when the walk, size or theme changes.
  function placeMap() {
    var slot = V.el.querySelector('[data-map]'), r = App.dog.lastRoute();
    if (!slot || !r) return;
    var w = slot.clientWidth, h = slot.clientHeight, key = r.walkId + ':' + r.path.length + ':' + w + 'x' + h + ':' + App.theme;
    if (!w || !h) return;
    if (!V.map || V.mapKey !== key) {
      V.map = document.createElement('div');
      V.map.className = 'dg-map-in';
      V.map.innerHTML = mapHTML(r, w, h);
      V.mapKey = key;
    }
    slot.appendChild(V.map);
  }

  // ---------------------------------------------------------------- the week: minutes walked per day
  function week() {
    var t0 = App.dayStart(new Date(now())), days = [], max = 0, tot = { walks: 0, mins: 0, n: 0 };
    for (var i = 6; i >= 0; i--) {
      var day = App.addDays(t0, -i), d = App.dog.day(day), mins = d.walks.reduce(function (s, w) { return s + walkMins(w); }, 0), c = { pee: 0, poop: 0 };
      d.potty.forEach(function (p) { c[p.kind]++; });
      days.push({ day: day, mins: mins, walks: d.walks.length, pee: c.pee, poop: c.poop, today: i === 0 });
      max = Math.max(max, mins);
      if (d.walks.length && i) { tot.walks += d.walks.length; tot.mins += mins; tot.n++; }
    }
    var avg = tot.n ? '<span class="dg-sum">Avg <b class="num">' + (tot.walks / tot.n).toFixed(1) + '</b> walks · <b class="num">' + dur(tot.mins / tot.n * MIN) + '</b> a day</span>' : '';
    return '<section class="dg-card dg-week"><header class="dg-head"><span class="label">Walking · 7 days</span>' + avg + '</header><div class="dg-bars">' +
      days.map(function (d) {
        return '<div class="dg-col' + (d.today ? ' is-today' : '') + '"><span class="dg-col-v num">' + (d.mins ? dur(d.mins * MIN) : '') + '</span>' +
          '<div class="dg-col-bar"><i style="height:' + (max ? Math.max(d.mins / max * 100, d.mins ? 4 : 0) : 0) + '%"></i></div>' +
          '<b class="dg-col-d">' + (d.today ? 'Today' : App.fmt.dayShort(d.day)) + '</b>' +
          '<span class="dg-col-p num">' + (d.walks || d.pee || d.poop ? '💧' + d.pee + ' 💩' + d.poop : '—') + '</span></div>';
      }).join('') + '</div></section>';
  }

  // ---------------------------------------------------------------- weight
  function md(ms) { var d = new Date(ms); return App.fmt.monthShort(d) + ' ' + d.getDate(); }
  function weight() {
    var w = App.dog.weights(), last = w[w.length - 1];
    if (!last) return '<section class="dg-card dg-weight"><header class="dg-head"><span class="label">Weight</span></header><p class="dg-empty">No weigh-ins yet. Log a ' + esc(name.toLowerCase()) + '_weight event in Lifelog.</p></section>';
    // Gain per week from the latest weigh-in back to one at least 5 days earlier (a real one if there is).
    var back = w.filter(function (p) { return p.at <= last.at - 5 * 864e5; }), prev = back.filter(function (p) { return !p.estimate; }).pop() || back.pop();
    var rate = prev ? (last.kg - prev.kg) / ((last.at - prev.at) / (7 * 864e5)) : null;
    return '<section class="dg-card dg-weight"><header class="dg-head"><span class="label">Weight</span><span class="dg-sum">' + md(last.at) + (last.where ? ' · ' + esc(last.where) : '') + '</span></header>' +
      '<div class="dg-wt"><b class="num">' + last.kg + '</b> kg' + (last.estimate ? ' <small>about</small>' : '') +
      (rate != null ? '<span class="dg-wt-r' + (rate < 0 ? ' is-down' : '') + '">' + (rate >= 0 ? '+' : '−') + Math.abs(rate).toFixed(1) + ' kg a week</span>' : '') + '</div>' +
      '<div class="dg-wchart" data-wchart></div></section>';
  }
  function weightChart(w, W, H) {
    var pad = { l: 34, r: 12, t: 12, b: 24 }, a = w[0].at, b = w[w.length - 1].at;
    var lo = Math.min.apply(null, w.map(function (p) { return p.low != null ? p.low : p.kg; })), hi = Math.max.apply(null, w.map(function (p) { return p.high != null ? p.high : p.kg; }));
    var step = hi - lo > 8 ? 4 : hi - lo > 3 ? 2 : 1;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; if (hi === lo) hi = lo + step;
    function X(t) { return pad.l + (b > a ? (t - a) / (b - a) : 0.5) * (W - pad.l - pad.r); }
    function Y(kg) { return pad.t + (1 - (kg - lo) / (hi - lo)) * (H - pad.t - pad.b); }
    var g = '';
    for (var v = lo; v <= hi + 1e-6; v += step) g += '<line class="dg-wc-g" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="dg-wc-y" x="' + (pad.l - 8) + '" y="' + (Y(v) + 5) + '">' + v + '</text>';
    var line = w.map(function (p) { return X(p.at).toFixed(1) + ',' + Y(p.kg).toFixed(1); }).join(' ');
    var dots = w.map(function (p, i) {
      var x = X(p.at).toFixed(1), y = Y(p.kg).toFixed(1);
      return (p.low != null ? '<line class="dg-wc-rng" x1="' + x + '" x2="' + x + '" y1="' + Y(p.low) + '" y2="' + Y(p.high) + '"/>' : '') +
        '<circle class="dg-wc-d' + (p.estimate ? ' is-est' : '') + (i === w.length - 1 ? ' is-last' : '') + '" cx="' + x + '" cy="' + y + '" r="' + (i === w.length - 1 ? 7 : 5) + '"/>';
    }).join('');
    var xl = '<text class="dg-wc-x" x="' + X(a) + '" y="' + (H - 4) + '" text-anchor="start">' + md(a) + '</text>' +
      (b > a ? '<text class="dg-wc-x" x="' + X(b) + '" y="' + (H - 4) + '" text-anchor="end">' + md(b) + '</text>' : '');
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + g + '<polyline class="dg-wc-l" points="' + line + '"/>' + dots + xl + '</svg>';
  }
  function placeWeight() {
    var slot = V.el.querySelector('[data-wchart]'), w = App.dog.weights();
    if (slot && w.length > 1 && slot.clientWidth && slot.clientHeight) slot.innerHTML = weightChart(w, slot.clientWidth, slot.clientHeight);
  }

  function render() {
    if (!V.el) return;
    V.el.innerHTML = '<div class="dg">' + top() +
      '<div class="dg-now">' + pottyTile('pee') + pottyTile('poop') + mealTile() + walkTile() + '</div>' +
      today() + route() + week() + weight() + '</div>';
    placeMap();
    placeWeight();
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
