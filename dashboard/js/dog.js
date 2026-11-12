// The dog's care data for the dog tab (views/dog.js). Two sides, kept apart:
//   plan    what's meant to happen: meal events ("Maya lunch 1 cup", "Maya · Lunch" + "cups: 1") and
//           the "Maya prep" kibble mix in everyone's calendars (the frame's /events), the HA agent's
//           walk plan (App.walk.plans), and other "Maya …" events (training, vet, grooming)
//   actual  what happened: Lifelog (the Worker's GET /dog: meals fed by NFC tap, pee/poop, weigh-ins,
//           walk distances), the walks (App.walk), and the Life Log calendar (also from GET /dog),
//           where done meals, walks and potty breaks end up. A planned meal moved to Life Log is
//           still that meal: it's matched by day + meal, so it shows as fed, not as missing.
// Calendar owners give the meal's people: a meal on Harsh's calendar is Harsh's, A&H Life is both.
//   App.dog.day(date)        {meals, walks, plannedWalks, potty, prep} for that day
//   App.dog.potty(sinceMs)   [{kind: 'pee'|'poop', at}] newest first
//   App.dog.upcoming(n)      the next n other "Maya …" events (training, vet, …)
//   App.dog.lastRoute()      the newest walk's GPS path, for the route map
// Emits 'dog' when the Worker's data changes.
(function () {
  'use strict';
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var CACHE = 'dog-data-v1', DAYS = 30, MIN = 60e3;
  var dogName = window.CONFIG.dog, dogRe = new RegExp('^\\s*' + dogName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\u2019s|\'s)?\\b', 'i');
  var people = window.CONFIG.people;
  var G = App.dog = { on: !!(API && KEY), demo: !(API && KEY), data: null, error: null, updated: null };

  function read() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }
  function ymd(d) { d = new Date(d); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function sameDay(a, b) { return ymd(a) === ymd(b); }

  // "1", "3/4", "1 1/4", "1.5" → number
  function amount(s) {
    var m = /^\s*(?:(\d+)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*$/.exec(s || '');
    if (!m) return null;
    var v = m[3] ? +m[2] / +m[3] : +m[2];
    return Math.round(((m[1] ? +m[1] : 0) + v) * 100) / 100;
  }
  G.amount = amount;
  var QTY = '((?:\\d+\\s+)?\\d+(?:\\.\\d+)?(?:\\s*\\/\\s*\\d+)?)';

  // Meal kind from a title (same rules as Home Assistant's sensor.maya_meal_plan): a plain "snack"
  // before 3 PM is the walk snack, later the night snack.
  var MEALS = ['Breakfast', 'Walk snack', 'Lunch', 'Dinner', 'Night snack'];
  function mealKind(title, at) {
    var t = String(title || '').toLowerCase();
    var k = /walk snack/.test(t) ? 'Walk snack' : /night snack|bedtime snack/.test(t) ? 'Night snack' : /breakfast/.test(t) ? 'Breakfast' :
      /lunch/.test(t) ? 'Lunch' : /dinner|supper/.test(t) ? 'Dinner' : /snack|treat/.test(t) ? (new Date(at).getHours() < 15 ? 'Walk snack' : 'Night snack') : null;
    return k;
  }
  function slug(meal) { return meal.toLowerCase().replace(/\s+/g, '-'); }
  // A meal's key: its day (the night snack after midnight still belongs to the evening before) + kind.
  function mealDay(at, kind) { var d = new Date(at); if (kind === 'Night snack' && d.getHours() < 5) d = new Date(+d - 6 * 3600e3); return ymd(d); }
  function key(at, kind) { return mealDay(at, kind) + '-' + slug(kind); }
  function cupsOf(title, notes) {
    var d = /cups?\s*:\s*([0-9./ ]+)/i.exec(notes || ''), t = new RegExp(QTY + '\\s*cups?\\b', 'i').exec(title || '');
    return d ? amount(d[1]) : t ? amount(t[1]) : null;
  }
  function isDog(e) { return dogRe.test(e.title || ''); }
  function isPrep(e) { return isDog(e) && /\bprep\b/i.test(e.title); }
  function isWalkTitle(t) { return /\bwalk\b/i.test(t) && !/walk snack/i.test(t); }
  function mealFrom(e) {
    if (!isDog(e) || isPrep(e) || e.allDay || isWalkTitle(e.title)) return null;
    var kind = mealKind(e.title, e.start);
    if (!kind) return null;
    return { key: key(e.start, kind), meal: kind, at: new Date(e.start), cups: cupsOf(e.title, e.notes), cal: e.cal, people: e.people || [], title: e.title };
  }

  // ---------------------------------------------------------------- the plan (everyone's calendars)
  function calEvents() { return (window.DATA.events || []).filter(function (e) { return !e.allDay || isDog(e); }); }
  function plannedMeals(day) {
    var want = ymd(day), seen = {};
    return calEvents().map(mealFrom).filter(function (m) {
      if (!m || m.key.slice(0, 10) !== want || seen[m.key]) return false;
      return (seen[m.key] = true);
    });
  }
  // "Maya prep" notes: "3 cups Purina Pro Plan + 1/2 cup Royal Canin GI" → foods with shares.
  function prep(day) {
    var e = calEvents().filter(function (x) { return isPrep(x) && sameDay(x.start, day); })[0];
    if (!e || !e.notes) return null;
    var re = new RegExp(QTY + '\\s*cups?\\s+([A-Z][A-Za-z\u2019\']*(?:\\s+[A-Z][A-Za-z\u2019\']*)*)', 'g'), m, foods = [], total = 0;
    while ((m = re.exec(e.notes))) {
      var c = amount(m[1]), name = m[2].trim();
      if (c == null) continue;
      var same = foods.filter(function (f) { return f.name === name; })[0];
      if (same) same.cups += c; else foods.push({ name: name, cups: c });
      total += c;
    }
    var tot = new RegExp(QTY + '\\s*cups?\\s+total', 'i').exec(e.notes);
    foods.forEach(function (f) { f.pct = total ? Math.round(f.cups / total * 100) : 0; });
    return foods.length ? { foods: foods, total: tot ? amount(tot[1]) : total, notes: e.notes } : null;
  }

  // ---------------------------------------------------------------- what happened
  function data() { return G.demo ? demo() : (G.data || {}); }
  function logEvents() { return (data().log || []).filter(function (e) { return !e.allDay; }); }
  function fedMeals() {
    var out = {};
    (data().meals || []).forEach(function (m) {
      var kind = MEALS.indexOf(m.meal) > -1 ? m.meal : mealKind(m.meal, m.plannedAt || m.at) || 'Extra';
      var at = new Date(m.at), planned = m.plannedAt ? new Date(m.plannedAt) : null;
      var k = kind === 'Extra' ? 'extra-' + m.id : key(planned || at, kind);
      out[k] = { key: k, meal: kind, fedAt: at, plannedAt: planned, by: m.person ? String(m.person).toLowerCase() : null, cups: m.cups, deltaMin: m.deltaMin, ate: m.ate, source: 'lifelog' };
    });
    // A done meal moved to the Life Log calendar (and not in Lifelog): fed at the event's time.
    logEvents().forEach(function (e) {
      var m = mealFrom(e);
      if (!m || out[m.key]) return;
      out[m.key] = { key: m.key, meal: m.meal, fedAt: m.at, plannedAt: null, by: byFrom(e), cups: m.cups, deltaMin: null, source: 'calendar' };
    });
    return out;
  }
  function byFrom(e) {
    var t = (e.title || '') + ' ' + (e.notes || ''), hit = people.filter(function (p) { return new RegExp('\\b' + p.name + '\\b', 'i').test(t); })[0];
    return hit ? hit.id : null;
  }

  // Meals of a day: the plan matched with what was fed, plus extras.
  //   status fed | due (from 30 min before to 60 min after) | late (later, not fed) | upcoming | unlogged
  //   unlogged: a past day where nothing was logged at all (before logging started, or it was down)
  function meals(day) {
    var fed = fedMeals(), now = +App.now(), want = ymd(day), out = [], used = {};
    var logged = Object.keys(fed).some(function (k) { return mealDay(fed[k].plannedAt || fed[k].fedAt, fed[k].meal) === want; });
    var past = App.dayStart(day) < App.dayStart(new Date(now));
    plannedMeals(day).forEach(function (p) {
      var f = fed[p.key];
      used[p.key] = 1;
      var r = merge(p, f, now);
      if (!f && past && !logged) r.status = 'unlogged';
      out.push(r);
    });
    Object.keys(fed).forEach(function (k) {
      var f = fed[k];
      if (used[k] || mealDay(f.plannedAt || f.fedAt, f.meal) !== want) return;
      out.push(merge({ key: k, meal: f.meal, at: f.plannedAt || f.fedAt, cups: f.cups, people: f.by ? [f.by] : [], cal: null }, f, now));
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }
  function merge(p, f, now) {
    var r = { key: p.key, meal: p.meal, at: new Date(p.at), cups: p.cups, cal: p.cal, owners: p.people || [], title: p.title };
    if (f) {
      r.status = 'fed'; r.fedAt = f.fedAt; r.by = f.by; r.ate = f.ate;
      if (f.cups != null) r.cups = f.cups;
      r.deltaMin = f.deltaMin != null ? f.deltaMin : f.plannedAt ? Math.round((f.fedAt - f.plannedAt) / MIN) : null;
    } else {
      var d = (now - r.at) / MIN;
      r.status = d > 60 ? 'late' : d >= -30 ? 'due' : 'upcoming';
    }
    return r;
  }

  // Walks: the frame's own list (fresh, includes changes not synced yet), else the demo's.
  function walks() {
    var W = App.walk, list = G.demo && !W.recent.length ? demo().walks : W.recent.slice();
    if (W.active && !W.active.endedAt) list = [W.active].concat(list);
    return list;
  }
  G.walks = walks;
  G.distance = function (id) {
    var r = (data().routes || []).filter(function (x) { return x.walkId === id; })[0];
    return r ? r.m : null;
  };

  // The newest walk's GPS path {walkId, start, end, m, path: [[lat, lon]]} for the route map.
  G.lastRoute = function () { return data().lastRoute || null; };
  // A map tile through the Worker (OpenStreetMap, cached), or null without a Worker.
  G.tileUrl = function (z, x, y) { return G.on ? API + '/tile?z=' + z + '&x=' + x + '&y=' + y + '&key=' + encodeURIComponent(KEY) : null; };

  // Pee/poop times: Lifelog's events, the walks' ticks (pee 1 min after the start, poop 2 min after
  // that, like the Worker) and Life Log calendar entries, merged within 3 minutes of each other.
  G.potty = function (sinceMs) {
    var list = [];
    (data().potty || []).forEach(function (x) { list.push({ kind: x.kind, at: Date.parse(x.at), walkId: x.walkId }); });
    walks().forEach(function (w) {
      if (!w.endedAt) return;
      if (w.pee) list.push({ kind: 'pee', at: Math.min(w.startedAt + MIN, w.endedAt), walkId: w.id });
      if (w.poop) list.push({ kind: 'poop', at: Math.min(w.startedAt + 3 * MIN, w.endedAt), walkId: w.id });
    });
    logEvents().forEach(function (e) {
      if (isWalkTitle(e.title)) return; // a walk's own pee/poop are separate events
      var k = /\bpoo(p)?\b|💩/i.test(e.title) ? 'poop' : /\bpee\b|💧/i.test(e.title) ? 'pee' : null;
      var w = /dog-walk-(.+)-(?:pee|poop)(?:@|$)/.exec(e.id || '');
      if (k) list.push({ kind: k, at: Date.parse(e.start), walkId: w ? w[1] : null });
    });
    list = list.filter(function (x) { return x.at >= (sinceMs || 0) && x.at <= +App.now() + MIN; }).sort(function (a, b) { return b.at - a.at; });
    var out = [];
    list.forEach(function (x) {
      var dup = out.some(function (y) { return y.kind === x.kind && ((x.walkId && y.walkId === x.walkId) || Math.abs(y.at - x.at) < 3 * MIN); });
      if (!dup) out.push(x);
    });
    return out;
  };
  // Typical daytime gap between two of a kind (median, over the last 14 days; overnight gaps left out).
  G.gap = function (kind) {
    var t = G.potty(+App.now() - 14 * 864e5).filter(function (x) { return x.kind === kind; }).map(function (x) { return x.at; }).sort();
    var gaps = [];
    for (var i = 1; i < t.length; i++) if (sameDay(t[i], t[i - 1])) gaps.push(t[i] - t[i - 1]);
    gaps.sort(function (a, b) { return a - b; });
    return gaps.length >= 2 ? gaps[gaps.length >> 1] : null;
  };

  G.day = function (day) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    var plan = (App.walk.plans || []).filter(function (p) { return p.date === ymd(day); })[0];
    return {
      meals: meals(day),
      walks: walks().filter(function (w) { return w.startedAt < e && (w.endedAt || +App.now()) > s; }),
      plannedWalks: plan ? (plan.walks || []).filter(function (x) { return x.status === 'planned' || x.status === 'missed'; }) : [],
      planNote: plan && plan.notes,
      potty: G.potty(+s).filter(function (x) { return x.at < e; }),
      prep: prep(day)
    };
  };

  // Other things on the dog's calendar: training, vet, grooming, … (not meals, prep or walks).
  G.upcoming = function (n) {
    var now = +App.now(), seen = {};
    return (window.DATA.events || []).slice().sort(function (a, b) { return a.start - b.start; }).filter(function (e) {
      if (!isDog(e) || isPrep(e) || mealFrom(e) || isWalkTitle(e.title) || +e.end <= now) return false;
      var k = e.title.toLowerCase().replace(/\W+/g, ' ').trim();
      return seen[k] ? false : (seen[k] = true);
    }).slice(0, n || 3);
  };

  // Who's busy: timed events on a person's calendars that overlap [at, at + mins), not the dog's own.
  G.busy = function (pid, at, mins) {
    var s = +at, e = s + (mins || 15) * MIN;
    return (window.DATA.events || []).filter(function (x) {
      return !x.allDay && !isDog(x) && (x.people || []).indexOf(pid) > -1 && x.people.length < people.length && +x.start < e && +x.end > s;
    })[0] || null;
  };

  G.weights = function () {
    return (data().weights || []).map(function (w) { return { at: Date.parse(w.at), kg: w.kg, where: w.where } })
      .sort(function (a, b) { return a.at - b.at; });
  };
  G.age = function () {
    var b = window.CONFIG.dogBirthday && Date.parse(window.CONFIG.dogBirthday + 'T00:00:00');
    if (!b) return null;
    var days = Math.floor((+App.now() - b) / 864e5);
    return { weeks: Math.floor(days / 7), months: Math.floor(days / 30.44), days: days };
  };
  G.fedOnDay = function (day) { return meals(day).filter(function (m) { return m.status === 'fed'; }); };
  G.plannedOnDay = plannedMeals;
  G.MEALS = MEALS;

  // ---------------------------------------------------------------- sync
  G.refresh = function () {
    if (!G.on) return Promise.resolve();
    return fetch(API + '/dog?days=' + DAYS, { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var before = JSON.stringify(G.data);
        G.data = j; G.error = null; G.updated = Date.now();
        write({ at: G.updated, data: j });
        if (JSON.stringify(j) !== before) App.emit('dog');
      }).catch(function (e) { G.error = e.message; console.warn('Dog data sync failed', e); });
  };
  var c = read();
  if (c) { G.data = c.data; G.updated = c.at; }

  // ---------------------------------------------------------------- demo (no Worker configured)
  var demoData = null;
  function demo() {
    if (demoData && sameDay(demoData.made, +App.now())) return demoData;
    var now = +App.now(), t0 = App.dayStart(new Date()), H = 3600e3, walksD = [], mealsD = [], pottyD = [];
    var slots = [[6.8, 12, 1, 1], [10, 35, 1, 0], [13.2, 20, 1, 0], [17.5, 40, 1, 1], [21.6, 10, 1, 0]];
    var plan = [['Breakfast', 6.75, 1], ['Walk snack', 10, 0.5], ['Lunch', 12.5, 1], ['Dinner', 18.5, 0.75], ['Night snack', 21, 0.25]];
    for (var d = 13; d >= 0; d--) {
      var day = +App.addDays(t0, -d);
      slots.forEach(function (s, i) {
        var st = day + s[0] * H + ((d * 7 + i * 13) % 25 - 12) * MIN;
        if (st + s[1] * MIN > now) return;
        var who = people.length ? [people[(d + i) % people.length]] : [];
        walksD.push({ id: 'demo-' + d + '-' + i, startedAt: st, endedAt: st + (s[1] + (d % 4) * 4) * MIN, pee: !!s[2], poop: !!s[3] && (d + i) % 5 !== 0, walkers: who.map(function (p) { return { id: p.id, name: p.name }; }) });
      });
      plan.forEach(function (m, i) {
        var at = day + m[1] * H, fed = at + ((d * 5 + i * 11) % 21 - 6) * MIN;
        if (fed > now || (d === 0 && i === 2)) return;
        mealsD.push({ id: 'demo-meal-' + d + '-' + i, at: new Date(fed).toISOString(), meal: m[0], person: people.length ? people[(d + i) % people.length].id : null, cups: m[2], plannedAt: new Date(at).toISOString() });
      });
    }
    var w0 = +App.addDays(t0, -42), lw = walksD.slice().sort(function (a, b) { return b.startedAt - a.startedAt; })[0], path = [];
    for (var k = 0; k <= 40; k++) {
      var a = k / 40 * 2 * Math.PI;
      path.push([+(window.CONFIG.lat + 0.0022 * Math.sin(a) + 0.0006 * Math.sin(3 * a)).toFixed(6), +(window.CONFIG.lon + 0.0035 * (1 - Math.cos(a))).toFixed(6)]);
    }
    var demoRoute = lw ? { walkId: lw.id, start: new Date(lw.startedAt).toISOString(), end: new Date(lw.endedAt).toISOString(), m: 1240, path: path } : null;
    demoData = {
      made: now, walks: walksD.sort(function (a, b) { return b.startedAt - a.startedAt; }), meals: mealsD, potty: pottyD, log: [], routes: [], lastRoute: demoRoute,
      weights: [[0, 13.1], [14, 14.6], [28, 15.9], [35, 16.8], [42, 17.2]].map(function (w) { return { at: new Date(w0 + w[0] * 864e5).toISOString(), kg: w[1] }; })
    };
    return demoData;
  }
  if (G.demo) {
    // The demo's meal plan, so the tab has something to show without calendars.
    App.on('ready', function () {
      if ((window.DATA.events || []).some(function (e) { return mealFrom(e); })) return;
      var t0 = App.dayStart(new Date()), H = 3600e3;
      [['breakfast 1 cup', 6.75], ['snack 1/2 cup', 10], ['lunch 1 cup', 12.5], ['dinner 3/4 cup', 18.5], ['snack 1/4 cup', 21], ['prep', 6.5]].forEach(function (m, i) {
        for (var d = -7; d <= 1; d++) {
          var s = new Date(+App.addDays(t0, d) + m[1] * H);
          window.DATA.events.push({ id: 'demo-dog-' + d + '-' + i, title: dogName + ' ' + m[0], people: people.map(function (p) { return p.id; }), allDay: false, start: s, end: new Date(+s + 15 * MIN),
            notes: m[0] === 'prep' ? '3 1/2 cups total: ' + (d < 1 ? '3 cups Purina Pro Plan + 1/2 cup Royal Canin GI' : '3 1/2 cups Purina Pro Plan') + '.' : undefined });
        }
      });
    });
    return;
  }
  App.on('ready', function () {
    G.refresh();
    setInterval(G.refresh, 5 * 60000);
    window.addEventListener('online', G.refresh);
  });
  // A walk logged here changes the potty and walk data right away; fetch Lifelog's side shortly after.
  App.on('walk', function () { setTimeout(G.refresh, 15000); });
})();
