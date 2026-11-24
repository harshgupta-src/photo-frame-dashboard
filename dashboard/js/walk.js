// Dog walk timer (CONFIG.dog): state for the walk tile on Today, synced with the frame-data Worker's
// walk log (worker/src/walkapi.js, WALKS.md).
//   App.walk.active   the walk in progress {id, startedAt, endedAt: null, walkers}, or null
//   App.walk.recent   completed walks from the last 14 days, newest first
//   App.walk.plans    today's and tomorrow's walk plans (the HA agent's, see WALKS.md); App.walk.next()
//                     is the next planned walk, whose walkers are the default (tap an avatar to change)
//   App.walk.suggest(rec)  the end-of-walk sheet's defaults: who walked (the planned walk's walkers unless
//                     someone picked on the tile) and pee/poop (the plan's expect, else her history)
// Changes are saved to localStorage first and queued in an outbox, so a reload, a reboot or no
// Wi-Fi loses nothing; the outbox is sent in order (PUT is a full upsert, DELETE removes) and the
// Worker's copy is adopted whenever the outbox is empty. Times are real time (Date.now(), never the
// demo-shifted App.now()), and a walk can't start while the clock still reads 1970 after a reboot.
// Emits 'walk' on every change. Syncing pauses while the page is hidden (poll.js).
import { every } from './poll.js';
import { suggestWalk } from '../worker/src/walkexpect.js';

(function () {
  'use strict';
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var PLAN_SENSOR = 'sensor.maya_walk_plan';
  var STATE = 'walk-state-v1', OUTBOX = 'walk-outbox-v1', CHOSEN = 'walk-walkers-v1', MIN_TIME = Date.UTC(2026, 0, 1);
  var people = window.CONFIG.people;
  var W = App.walk = { on: !!(API && KEY), active: null, recent: [], plans: [], planDays: [], pending: 0, error: null };
  var PLAN_AHEAD = 90 * 60e3; // a walk started this close to a planned one is that one
  // Home Assistant replans 2 minutes after a walk is logged (ha/walk-plan.yaml), then the agent takes a
  // minute or two: poll every minute for this long after a walk change so the new plan shows up.
  var REPLAN_WATCH = 8 * 60e3;
  var syncing = false, again = false, gen = 0, watchUntil = 0;

  function read(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }
  function save() { write(STATE, { active: W.active, recent: W.recent, plans: W.plans, planDays: W.planDays }); }
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
  function planItem(id) {
    var hit = null;
    W.plans.forEach(function (p) { (p.walks || []).forEach(function (x) { if (x.id === id) hit = x; }); });
    return hit;
  }
  // The walkers picked on the tile for planned walk x. A replan gives a moved walk a new id (its
  // date + start time), so a pick for a walk the plan no longer has carries over to the next one
  // when it's within 90 minutes of where the picked one was.
  function chosen(x) {
    var c = read(CHOSEN, null);
    if (!c || !c.walkers || !c.walkers.length) return null;
    if (c.key === (x ? x.id : '')) return c.walkers;
    if (x && c.key && c.start && !planItem(c.key) && Math.abs(Date.parse(x.start) - c.start) <= PLAN_AHEAD) return c.walkers;
    return null;
  }
  // Who's walking: picked on the tile for this planned walk, else the plan's, else the first person.
  W.defaultWalkers = function () {
    var x = W.next(), c = chosen(x);
    if (c) return c;
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
    write(CHOSEN, { key: x ? x.id : '', start: x ? Date.parse(x.start) : 0, walkers: cur });
    App.emit('walk');
  };
  W.clockOk = function () { return Date.now() >= MIN_TIME; };

  // Defaults for the end-of-walk sheet: {walkers, pee, poop, hint} (worker/src/walkexpect.js). Walkers:
  // picked on the tile, else the planned walk's, else whoever started it, else the tile's default.
  // Pee/poop: the plan's expect (the HA agent's, else the Worker's reading of her history), else her
  // last 14 days at this time of day, else her usual routine. Nothing is saved until someone taps Save.
  function minuteOfDay(ms) { var d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }
  W.suggest = function (rec) {
    var g = suggestWalk(rec, W.plans, W.recent, minuteOfDay, function (id) { return !!person(id); });
    var walkers = g.walkerIds.map(function (id) { return { id: id, name: person(id).name }; });
    var hint = g.plan ? 'Based on the ' + App.fmt.time(new Date(Date.parse(g.plan.start))) + ' plan'
      : g.from === 'history' ? 'Based on her walks around this time' : 'Based on her usual routine';
    return { walkers: walkers.length ? walkers : W.defaultWalkers(), pee: g.pee, poop: g.poop, hint: hint };
  };

  // Worker JSON → frame record
  function fromServer(j) {
    return {
      id: j.id, startedAt: Date.parse(j.startedAt), endedAt: j.endedAt ? Date.parse(j.endedAt) : null,
      pee: j.pee, poop: j.poop, notes: j.notes || '', calendar: j.calendar, planId: j.planId || undefined, source: j.source,
      walkers: (j.walkerIds || []).map(function (id, i) { var p = person(id); return { id: id, name: p ? p.name : j.walkers[i] }; })
    };
  }

  // ---------------------------------------------------------------- outbox
  // check: finishing the active walk. Another device (a phone) may have stopped it while the sheet was
  // open, so the Worker's copy is read first and an already-ended walk isn't overwritten (see flush).
  // restore: an Undo of the frame's own delete, so the Worker lifts that delete's tombstone (see flush).
  function enqueue(op, rec, check, restore) {
    gen++;
    watchUntil = Date.now() + REPLAN_WATCH;
    var box = read(OUTBOX, []).filter(function (o) { return o.id !== rec.id; });
    box.push({ op: op, id: rec.id, rec: op === 'put' ? rec : undefined, check: check ? true : undefined, restore: op === 'put' && restore ? true : undefined });
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
        dog: window.CONFIG.dog, tz: tz, source: 'frame', clientNow: Date.now(), restore: o.restore || undefined
      });
    }
    return fetch(API + '/walks/' + encodeURIComponent(o.id), init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j }; });
    });
  }
  // Sends queued changes in order. Network errors and 5xx stop and retry later; other errors drop
  // the change (it can never succeed). 409 = a walk started elsewhere (a phone) is already active:
  // that one wins. 410 = the walk was deleted elsewhere (a phone): the frame drops its copy too.
  function flush() {
    if (!W.on) return Promise.resolve();
    if (syncing) { again = true; return Promise.resolve(); }
    var box = read(OUTBOX, []);
    if (!box.length) return Promise.resolve();
    syncing = true;
    var o = box[0];
    return (o.check ? endedElsewhere(o) : Promise.resolve(null)).then(function (srv) {
      if (!srv) return send(o);
      adoptEnded(o, srv);
      return { status: 200, body: {}, skipped: true };
    }).then(function (r) {
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      var rest = read(OUTBOX, []);
      if (rest[0] && rest[0].id === o.id && JSON.stringify(rest[0]) === JSON.stringify(o)) rest.shift();
      write(OUTBOX, rest);
      W.error = null;
      if (r.status === 410) {
        dropDeleted(o.id);
        App.toast(App.esc(window.CONFIG.dog) + '’s walk was deleted on another device', { icon: 'clock' });
      } else if (r.status === 409 && r.body.active) {
        W.active = fromServer(r.body.active);
        App.toast(App.esc(window.CONFIG.dog) + '’s walk was already started on another device', { icon: 'clock' });
      } else if (r.status >= 400) {
        W.error = r.body.error || 'HTTP ' + r.status;
        App.toast('Walk not saved · ' + App.esc(W.error), { tone: 'error', icon: 'bolt' });
      } else if (!r.skipped && o.op === 'put' && r.body.id) {
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

  function dropDeleted(id) {
    var gone = (W.active && W.active.id === id ? W.active : null) || W.recent.filter(function (w) { return w.id === id; })[0];
    if (W.active && W.active.id === id) W.active = null;
    W.recent = W.recent.filter(function (w) { return w.id !== id; });
    if (gone) planStatus(gone.planId, 'planned');
  }

  // The Worker's ended copy of walk o.id, or null when it's still active there (or unknown: never
  // synced). Errors reject, so the finish stays queued and is retried.
  function endedElsewhere(o) {
    return fetch(API + '/walk', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.active && j.active.id === o.id) return null;
        var hit = (j.recent || []).filter(function (w) { return w.id === o.id && w.endedAt; })[0];
        return hit ? fromServer(hit) : null;
      });
  }
  function adoptEnded(o, srv) {
    var mine = o.rec;
    srv.calendar = srv.calendar || (W.recent.filter(function (w) { return w.id === srv.id; })[0] || {}).calendar;
    if (W.active && W.active.id === srv.id) W.active = null;
    W.recent = W.recent.filter(function (w) { return w.id !== srv.id; }).concat([srv])
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
    // Same as ours (our own earlier PUT whose answer was lost): nothing to say.
    if (mine && (mine.pee !== srv.pee || mine.poop !== srv.poop || Math.abs(mine.endedAt - srv.endedAt) > 60e3)) {
      App.toast(App.esc(window.CONFIG.dog) + '’s walk was already logged on another device · kept that one', { icon: 'clock' });
    }
  }
  W.endedElsewhere = function (id) {
    if (W.active && W.active.id === id) return null;
    return W.recent.filter(function (w) { return w.id === id && w.endedAt; })[0] || null;
  };

  // Outbox first, then adopt the Worker's state (a walk started or stopped from a phone shows up).
  W.refresh = function () {
    if (!W.on) return Promise.resolve();
    return flush().then(function () {
      if (read(OUTBOX, []).length) return;
      var g = gen, asked = Date.now();
      return fetch(API + '/walk', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          // Changed while we were asking (still queued, or already sent: this answer predates it).
          if (gen !== g || read(OUTBOX, []).length) return;
          var before = JSON.stringify([W.active, W.recent, W.plans, W.planDays]);
          var a = j.active ? fromServer(j.active) : null;
          // Keep the frame's "I'm back" (sheet open) on top of the server's still-active walk.
          if (a && W.active && W.active.id === a.id && W.active.endedAt) a = W.active;
          else if (a && W.active && W.active.id === a.id && W.active.picked) a.picked = true;
          W.active = a;
          W.recent = (j.recent || []).map(fromServer);
          W.plans = j.plans || [];
          W.planDays = [ymd(asked), ymd(asked + 864e5)];
          W.error = null;
          if (JSON.stringify([W.active, W.recent, W.plans, W.planDays]) !== before) changed();
        });
    }).catch(function (e) { console.warn('Walk sync failed', e); });
  };

  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // The tile's view of a planned walk follows the frame's own changes until the Worker's answer.
  function planStatus(planId, status) {
    var x = planId && planItem(planId);
    if (!x) return;
    if (status === 'planned' && Date.parse(x.end) <= Date.now()) status = 'missed';
    x.status = status;
  }

  // ---------------------------------------------------------------- actions
  W.start = function () {
    if (W.active) return W.active;
    if (!W.clockOk()) { App.toast('The frame’s clock isn’t set yet. Try again in a minute.', { tone: 'error', icon: 'clock' }); return null; }
    var x = W.next(), now = Date.now();
    W.active = { id: newId(), startedAt: now, endedAt: null, walkers: W.defaultWalkers() };
    if (chosen(x)) W.active.picked = true; // chosen on the tile: keep them
    if (x && Date.parse(x.start) - now <= PLAN_AHEAD) {
      W.active.planId = x.id;
      x.status = 'active';
    }
    write(CHOSEN, null);
    enqueue('put', W.active);
    changed();
    return W.active;
  };
  // Shorter than this isn't a walk (a Start then I'm back tapped by mistake): it's discarded, not logged.
  W.MIN_MS = 60e3;
  // "I'm back": freeze the end time while the sheet is open (survives a reload, see below).
  W.back = function () {
    if (!W.active) return null;
    if (!W.active.endedAt) { W.active.endedAt = Date.now(); save(); }
    return W.active;
  };
  W.resume = function () { if (W.active) { W.active.endedAt = null; changed(); } };
  // A completed walk: the one just finished, or an edit of an old one.
  // opts.finishing: the end-of-walk sheet for the active walk. Returns false (nothing saved) when another
  // device already ended that walk while the sheet was open; its pee/poop/end time are kept.
  W.save = function (rec, opts) {
    var finishing = !!(opts && opts.finishing);
    if (finishing && W.endedElsewhere(rec.id)) {
      if (App.toast) App.toast(App.esc(window.CONFIG.dog) + '’s walk was already logged on another device · kept that one', { icon: 'clock' });
      changed();
      return false;
    }
    if (W.active && W.active.id === rec.id) W.active = null;
    planStatus(rec.planId, 'done');
    W.recent = W.recent.filter(function (w) { return w.id !== rec.id; }).concat([rec])
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
    rec.calendar = 'pending';
    enqueue('put', rec, finishing, !!(opts && opts.restore));
    changed();
    return true;
  };
  W.remove = function (rec) {
    if (W.active && W.active.id === rec.id) W.active = null;
    planStatus(rec.planId, 'planned');
    W.recent = W.recent.filter(function (w) { return w.id !== rec.id; });
    enqueue('del', rec);
    changed();
  };
  W.restore = function (rec) {
    if (rec.endedAt) { W.save(rec, { restore: true }); return; }
    if (W.active) return;
    W.active = rec;
    planStatus(rec.planId, 'active');
    enqueue('put', rec, false, true);
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
  W.planDays = s.planDays || [];
  W.pending = read(OUTBOX, []).length;
  // Reloaded with the end-of-walk sheet open: they were back, so log it with what's known.
  if (W.active && W.active.endedAt) {
    var r = W.active, g = { pee: true, poop: false };
    try { g = W.suggest(r); } catch (e) { /* App.fmt not ready: plain defaults */ }
    if (r.pee == null) r.pee = g.pee;
    if (r.poop == null) r.poop = g.poop;
    W.save(r, { finishing: true });
  }

  if (!W.on) { console.warn('Walk log is local only: VITE_FRAME_API / VITE_FRAME_KEY not set'); return; }
  // Every minute while a walk is out or changes are queued, else every 5 minutes.
  var n = 0;
  App.on('ready', function () {
    W.refresh();
    every(60000, function () { n++; if (W.active || W.pending || Date.now() < watchUntil || n % 5 === 0) W.refresh(); }, { resume: W.refresh });
    window.addEventListener('online', function () { W.refresh(); });
    // HA's cached plan (ha/walk-plan.yaml) changes when the planner writes a new one: fetch it now
    // rather than at the next 5-minute poll. (A sensor: polled, every 15 s off the kiosk's stream.)
    var planSeen = null;
    App.on('ha', function (ids) {
      if (ids && ids.length && ids.indexOf(PLAN_SENSOR) < 0) return;
      var st = App.ha && App.ha.states[PLAN_SENSOR], k = st ? st.last_updated + '|' + JSON.stringify(st.attributes.walks || []) : null;
      if (k === planSeen) return;
      var first = planSeen === null;
      planSeen = k;
      if (!first && k) W.refresh();
    });
  });
})();
