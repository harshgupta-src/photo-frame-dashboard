// Dog walk timer (CONFIG.dog): state for the walk tile on Today, synced with the frame-data Worker's
// walk log (worker/src/walkapi.js, WALKS.md).
//   App.walk.active   the walk in progress {id, startedAt, endedAt: null, walkers}, or null
//   App.walk.recent   completed walks from the last 14 days, newest first
//   App.walk.plans    today's and tomorrow's walk plans (the HA agent's, see WALKS.md); App.walk.next()
//                     is the next planned walk, whose walkers are the default (tap an avatar to change)
// Changes are saved to localStorage first and queued in an outbox, so a reload, a reboot or no
// Wi-Fi loses nothing; the outbox is sent in order (PUT is a full upsert, DELETE removes) and the
// Worker's copy is adopted whenever the outbox is empty. Times are real time (Date.now(), never the
// demo-shifted App.now()), and a walk can't start while the clock still reads 1970 after a reboot.
// Emits 'walk' on every change.
(function () {
  'use strict';
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var STATE = 'walk-state-v1', OUTBOX = 'walk-outbox-v1', CHOSEN = 'walk-walkers-v1', MIN_TIME = Date.UTC(2026, 0, 1);
  var people = window.CONFIG.people;
  var W = App.walk = { on: !!(API && KEY), active: null, recent: [], plans: [], pending: 0, error: null };
  var PLAN_AHEAD = 90 * 60e3; // a walk started this close to a planned one is that one
  var syncing = false, again = false;

  function read(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }
  function save() { write(STATE, { active: W.active, recent: W.recent, plans: W.plans }); }
  function changed() { save(); W.pending = read(OUTBOX, []).length; App.emit('walk'); }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function person(id) { return people.filter(function (p) { return p.id === id; })[0]; }
  // The next planned walk that hasn't happened: {id, start, end, durationMin, walkers, walkerIds, ...}.
  W.next = function () {
    var now = Date.now(), best = null;
    W.plans.forEach(function (p) {
      (p.walks || []).forEach(function (x) {
        if (x.status === 'planned' && Date.parse(x.end) > now && (!best || Date.parse(x.start) < Date.parse(best.start))) best = x;
      });
    });
    return best;
  };
  function planned(x) {
    return (x ? x.walkerIds : []).map(function (id, i) { var p = person(id); return { id: id, name: p ? p.name : x.walkers[i] }; })
      .filter(function (w) { return person(w.id); });
  }
  // Who's walking: picked on the tile for this planned walk, else the plan's, else the first person.
  W.defaultWalkers = function () {
    var x = W.next(), c = read(CHOSEN, null);
    if (c && c.key === (x ? x.id : '') && c.walkers.length) return c.walkers;
    var p = planned(x);
    if (p.length) return p;
    return people.length ? [{ id: people[0].id, name: people[0].name }] : [];
  };
  W.toggleWalker = function (id) {
    var p = person(id), cur = W.defaultWalkers(), x = W.next();
    if (!p) return;
    var has = cur.some(function (w) { return w.id === id; });
    if (has && cur.length < 2) return;
    cur = has ? cur.filter(function (w) { return w.id !== id; }) : cur.concat([{ id: p.id, name: p.name }]);
    cur.sort(function (a, b) { return people.indexOf(person(a.id)) - people.indexOf(person(b.id)); });
    write(CHOSEN, { key: x ? x.id : '', walkers: cur });
    App.emit('walk');
  };
  W.clockOk = function () { return Date.now() >= MIN_TIME; };

  // Worker JSON → frame record
  function fromServer(j) {
    return {
      id: j.id, startedAt: Date.parse(j.startedAt), endedAt: j.endedAt ? Date.parse(j.endedAt) : null,
      pee: j.pee, poop: j.poop, notes: j.notes || '', calendar: j.calendar, planId: j.planId || undefined,
      walkers: (j.walkerIds || []).map(function (id, i) { var p = person(id); return { id: id, name: p ? p.name : j.walkers[i] }; })
    };
  }

  // ---------------------------------------------------------------- outbox
  function enqueue(op, rec) {
    var box = read(OUTBOX, []).filter(function (o) { return o.id !== rec.id; });
    box.push({ op: op, id: rec.id, rec: op === 'put' ? rec : undefined });
    write(OUTBOX, box);
    flush();
  }
  function send(o) {
    var r = o.rec, tz;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = undefined; }
    var init = { method: o.op === 'put' ? 'PUT' : 'DELETE', headers: { 'X-Frame-Key': KEY, 'Content-Type': 'application/json' }, cache: 'no-store' };
    if (o.op === 'put') {
      init.body = JSON.stringify({
        startedAt: r.startedAt, endedAt: r.endedAt, pee: r.pee, poop: r.poop, walkers: r.walkers, notes: r.notes || '', planId: r.planId,
        dog: window.CONFIG.dog, tz: tz, source: 'frame', clientNow: Date.now()
      });
    }
    return fetch(API + '/walks/' + encodeURIComponent(o.id), init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j }; });
    });
  }
  // Sends queued changes in order. Network errors and 5xx stop and retry later; other errors drop
  // the change (it can never succeed). 409 = a walk started elsewhere (a phone) is already active:
  // that one wins.
  function flush() {
    if (!W.on) return Promise.resolve();
    if (syncing) { again = true; return Promise.resolve(); }
    var box = read(OUTBOX, []);
    if (!box.length) return Promise.resolve();
    syncing = true;
    var o = box[0];
    return send(o).then(function (r) {
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      var rest = read(OUTBOX, []);
      if (rest[0] && rest[0].id === o.id && JSON.stringify(rest[0]) === JSON.stringify(o)) rest.shift();
      write(OUTBOX, rest);
      W.error = null;
      if (r.status === 409 && r.body.active) {
        W.active = fromServer(r.body.active);
        App.toast(App.esc(window.CONFIG.dog) + '’s walk was already started on another device', { icon: 'clock' });
      } else if (r.status >= 400) {
        W.error = r.body.error || 'HTTP ' + r.status;
        App.toast('Walk not saved · ' + App.esc(W.error), { tone: 'error', icon: 'bolt' });
      } else if (o.op === 'put' && r.body.id) {
        W.recent.forEach(function (w) { if (w.id === r.body.id) w.calendar = r.body.calendar; });
      }
      syncing = false;
      changed();
      return flush();
    }).catch(function (e) {
      syncing = false;
      W.error = e.message;
      W.pending = read(OUTBOX, []).length;
      App.emit('walk');
    }).then(function () {
      if (again) { again = false; return flush(); }
    });
  }

  // Outbox first, then adopt the Worker's state (a walk started or stopped from a phone shows up).
  W.refresh = function () {
    if (!W.on) return Promise.resolve();
    return flush().then(function () {
      if (read(OUTBOX, []).length) return;
      return fetch(API + '/walk', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (read(OUTBOX, []).length) return; // changed while we were asking
          var before = JSON.stringify([W.active, W.recent, W.plans]);
          var a = j.active ? fromServer(j.active) : null;
          // Keep the frame's "I'm back" (sheet open) on top of the server's still-active walk.
          if (a && W.active && W.active.id === a.id && W.active.endedAt) a = W.active;
          W.active = a;
          W.recent = (j.recent || []).map(fromServer);
          W.plans = j.plans || [];
          W.error = null;
          if (JSON.stringify([W.active, W.recent, W.plans]) !== before) changed();
        });
    }).catch(function (e) { console.warn('Walk sync failed', e); });
  };

  // ---------------------------------------------------------------- actions
  W.start = function () {
    if (W.active) return W.active;
    if (!W.clockOk()) { App.toast('The frame’s clock isn’t set yet. Try again in a minute.', { tone: 'error', icon: 'clock' }); return null; }
    var x = W.next(), now = Date.now();
    W.active = { id: newId(), startedAt: now, endedAt: null, walkers: W.defaultWalkers() };
    if (x && Date.parse(x.start) - now <= PLAN_AHEAD) {
      W.active.planId = x.id;
      x.status = 'active';
    }
    write(CHOSEN, null);
    enqueue('put', W.active);
    changed();
    return W.active;
  };
  // "I'm back": freeze the end time while the sheet is open (survives a reload, see below).
  W.back = function () {
    if (!W.active) return null;
    if (!W.active.endedAt) { W.active.endedAt = Date.now(); save(); }
    return W.active;
  };
  W.resume = function () { if (W.active) { W.active.endedAt = null; changed(); } };
  // A completed walk: the one just finished, or an edit of an old one.
  W.save = function (rec) {
    if (W.active && W.active.id === rec.id) W.active = null;
    W.recent = W.recent.filter(function (w) { return w.id !== rec.id; }).concat([rec])
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
    rec.calendar = 'pending';
    enqueue('put', rec);
    changed();
  };
  W.remove = function (rec) {
    if (W.active && W.active.id === rec.id) W.active = null;
    W.recent = W.recent.filter(function (w) { return w.id !== rec.id; });
    enqueue('del', rec);
    changed();
  };
  W.restore = function (rec) {
    if (rec.endedAt) { W.save(rec); return; }
    if (W.active) return;
    W.active = rec;
    enqueue('put', rec);
    changed();
  };
  // Typical length (median of recent walks), for a walk nobody stopped.
  W.typical = function () {
    var d = W.recent.slice(0, 15).map(function (w) { return w.endedAt - w.startedAt; }).sort(function (a, b) { return a - b; });
    return d.length ? d[d.length >> 1] : 30 * 60e3;
  };

  var s = read(STATE, {});
  W.active = s.active || null;
  W.recent = s.recent || [];
  W.plans = s.plans || [];
  W.pending = read(OUTBOX, []).length;
  // Reloaded with the end-of-walk sheet open: they were back, so log it with what's known.
  if (W.active && W.active.endedAt) {
    var r = W.active;
    if (r.pee == null) r.pee = true;
    if (r.poop == null) r.poop = false;
    W.save(r);
  }

  if (!W.on) { console.warn('Walk log is local only: VITE_FRAME_API / VITE_FRAME_KEY not set'); return; }
  // Every minute while a walk is out or changes are queued, else every 5 minutes.
  var n = 0;
  App.on('ready', function () {
    W.refresh();
    setInterval(function () { n++; if (W.active || W.pending || n % 5 === 0) W.refresh(); }, 60000);
    window.addEventListener('online', function () { W.refresh(); });
  });
})();
