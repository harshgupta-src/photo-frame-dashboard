// Feeding the dog from the frame: the dog tab's meal checklist (views/dog.js) logs a meal through the
// frame-data Worker's POST /meals/log (worker/src/meals.js), which writes the same Lifelog record as
// Home Assistant's NFC tap (id maya_meal-YYYY-MM-DD-<meal>) and moves the planned event to Life Log.
// Like walk.js: saved to localStorage first and queued in an outbox, so a reload, a reboot or no
// Wi-Fi loses nothing; the outbox is sent in order, network errors and 5xx are retried, other errors
// drop the log (it can never succeed). A meal logged here shows as fed straight away (App.dog merges
// App.meals.local()), with the not-synced dot while it's queued, until GET /dog has it from Lifelog.
//   App.meals.log(meal, personId)  meal: a row of App.dog.day(…).meals; false when it's already fed
//   App.meals.local()              {<meal key>: {id, key, meal, by, fedAt, plannedAt, cups, pending}}
//   App.meals.pending              how many are queued
// Times are real time (Date.now()), as for walks. Emits 'meal' on every change.
import { every } from './poll.js';

(function () {
  'use strict';
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var LOCAL = 'meal-local-v1', OUTBOX = 'meal-outbox-v1', KEEP = 2 * 864e5, MIN_TIME = Date.UTC(2026, 0, 1);
  var M = App.meals = { on: !!(API && KEY), pending: 0, error: null };
  var syncing = false, again = false;

  function read(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }
  function changed() { M.pending = read(OUTBOX, []).length; App.emit('meal'); }

  M.idFor = function (key) { return 'maya_meal-' + key; };
  M.local = function () { return read(LOCAL, {}); };

  M.log = function (m, personId) {
    if (!m || !m.key || m.status === 'fed' || !personId) return false;
    if (Date.now() < MIN_TIME) { App.toast('The frame’s clock isn’t set yet. Try again in a minute.', { tone: 'error', icon: 'clock' }); return false; }
    var loc = read(LOCAL, {});
    if (loc[m.key]) return false;
    loc[m.key] = {
      id: M.idFor(m.key), key: m.key, meal: m.meal, by: personId, fedAt: Date.now(),
      plannedAt: m.at ? +m.at : null, cups: m.cups == null ? null : m.cups, pending: M.on
    };
    write(LOCAL, loc);
    if (M.on) {
      var box = read(OUTBOX, []).filter(function (o) { return o.key !== m.key; });
      box.push({ key: m.key });
      write(OUTBOX, box);
    }
    changed();
    flush();
    return true;
  };

  function send(rec) {
    return fetch(API + '/meals/log', {
      method: 'POST', headers: { 'X-Frame-Key': KEY, 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ id: rec.id, person: rec.by, at: new Date(rec.fedAt).toISOString(), source: 'frame' })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j }; });
    });
  }
  function shift(o) {
    var rest = read(OUTBOX, []);
    if (rest[0] && rest[0].key === o.key) rest.shift();
    write(OUTBOX, rest);
  }
  function flush() {
    if (!M.on) return Promise.resolve();
    if (syncing) { again = true; return Promise.resolve(); }
    var box = read(OUTBOX, []);
    if (!box.length) return Promise.resolve();
    var o = box[0], rec = read(LOCAL, {})[o.key];
    if (!rec) { shift(o); changed(); return flush(); }
    syncing = true;
    return send(rec).then(function (r) {
      if (r.status >= 500 || r.status === 429) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
      shift(o);
      var loc = read(LOCAL, {});
      if (r.status >= 400) {
        // Never going to land (bad id, refused): don't show it as fed.
        delete loc[o.key];
        M.error = (r.body && r.body.error) || 'HTTP ' + r.status;
        App.toast(App.esc(rec.meal) + ' not saved · ' + App.esc(M.error), { tone: 'error', icon: 'bolt' });
      } else {
        M.error = null;
        if (loc[o.key]) loc[o.key].pending = false;
        if (App.dog && App.dog.refresh) App.dog.refresh();
      }
      write(LOCAL, loc);
      syncing = false;
      changed();
      return flush();
    }).catch(function (e) {
      syncing = false;
      M.error = e.message;
      changed();
    }).then(function () {
      if (again) { again = false; return flush(); }
    });
  }
  M.flush = flush;

  // Sent logs stay until GET /dog has them from Lifelog (or two days pass); queued ones stay until sent.
  function prune() {
    var loc = read(LOCAL, {}), fed = {}, n = 0, now = Date.now();
    ((App.dog && App.dog.data && App.dog.data.meals) || []).forEach(function (x) { fed[x.id] = 1; });
    Object.keys(loc).forEach(function (k) {
      var l = loc[k];
      if (!l.pending && (fed[l.id] || now - l.fedAt > KEEP)) { delete loc[k]; n++; }
    });
    if (n) { write(LOCAL, loc); changed(); }
  }

  M.pending = read(OUTBOX, []).length;
  App.on('dog', prune);
  App.on('ready', function () {
    prune();
    if (!M.on) return;
    flush();
    every(60000, function () { if (M.pending) flush(); }, { resume: flush });
    window.addEventListener('online', function () { flush(); });
  });
})();
