// The shared to-do lists (Grocery list, the pinned Reminders list) as edited on the frame and phones.
// Pure: live.js gives it the lists as Home Assistant reports them (setBase) and a send() that makes
// a change in HA (script.frame_todo, ha/reminders-sync.yaml); views read items() and call add,
// toggle, edit, remove, clearDone.
//
// A change shows at once (an optimistic op laid over HA's items) and stays until a reload that
// started after HA confirmed it shows the same thing, or 10 s pass. So a reload already in flight
// can't make a just-ticked item flicker back, and HA's state wins once it has caught up. A failed
// call drops the op (the item snaps back) and reports it; so does a confirmed one HA didn't take
// (the script answers 200 even when it refuses, e.g. a rename onto an existing title).
// Deletes and "clear completed" wait holdMs (5 s) so they can be undone before anything is sent.
// Calls go out one at a time, in order, so a tick and its undo reach HA in that order.

// "notes\nAssigned: Name" ⇄ { notes, assignee }
export function splitDesc(d) {
  var lines = String(d || '').split('\n'), m = /^Assigned:\s*(.+)$/.exec(lines[lines.length - 1] || '');
  if (m) lines.pop();
  return { notes: lines.join('\n').trim(), assignee: m ? m[1].trim() : '' };
}
export function joinDesc(notes, assignee) {
  return [String(notes || '').trim(), assignee ? 'Assigned: ' + assignee : ''].filter(Boolean).join('\n');
}

var same = function (a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); };

export function createTodos(opts) {
  var now = opts.now || Date.now, holdMs = opts.holdMs == null ? 5000 : opts.holdMs, settleMs = opts.settleMs || 10000;
  var base = {}, ops = [], alias = {}, n = 0, chain = Promise.resolve();
  var store = { online: true };

  function changed() { if (opts.onChange) opts.onChange(); }
  function byId(list, id) { return items(list).filter(function (it) { return it.id === id; })[0]; }
  function drop(op) { ops = ops.filter(function (o) { return o !== op; }); }

  // HA's items with the ops not yet settled laid over them.
  function items(list) {
    var al = alias[list] || {};
    var out = (base[list] || []).map(function (it) {
      return { id: al[it.uid] || 'u' + it.uid, uid: it.uid, title: it.title, notes: it.notes || '', assignee: it.assignee || '', done: !!it.done, pending: false };
    });
    ops.forEach(function (op) {
      if (op.list !== list) return;
      var live = op.state !== 'ok';
      if (op.kind === 'add') {
        var hit = out.filter(function (it) { return same(it.title, op.title); });
        if (!hit.length) out.push({ id: op.tmp, uid: null, title: op.title, notes: op.notes || '', assignee: '', done: false, pending: true });
        hit.forEach(function (it) { if (it.done) { it.done = false; it.pending = live; } });
      } else if (op.kind === 'set') {
        out.forEach(function (it) {
          if (it.uid !== op.uid) return;
          for (var k in op.patch) it[k] = op.patch[k];
          if (live) it.pending = true;
        });
      } else if (op.kind === 'remove') {
        out = out.filter(function (it) { return it.uid !== op.uid; });
      } else if (op.kind === 'clear') {
        out = out.filter(function (it) { return !(it.done && op.uids.indexOf(it.uid) > -1); });
      }
    });
    return out;
  }

  // Does HA's list show what this op asked for?
  function settled(op, list) {
    if (op.kind === 'add') return list.some(function (it) { return !it.done && same(it.title, op.title); });
    if (op.kind === 'remove') return !list.some(function (it) { return it.uid === op.uid; });
    if (op.kind === 'clear') return !list.some(function (it) { return it.done && op.uids.indexOf(it.uid) > -1; });
    var it = list.filter(function (x) { return x.uid === op.uid; })[0];
    if (!it) return null; // gone (deleted elsewhere): nothing to say
    for (var k in op.patch) if (String(op.patch[k] == null ? '' : op.patch[k]) !== String(it[k] == null ? '' : it[k])) return false;
    return true;
  }

  // Confirmed but no fresh reload has shown it yet: HA's word wins after settleMs.
  function expire(op) {
    setTimeout(function () { if (ops.indexOf(op) > -1) { drop(op); changed(); } }, settleMs);
  }

  function send(op) {
    op.state = 'queued';
    changed();
    chain = chain.then(function () {
      if (ops.indexOf(op) < 0) return;
      op.state = 'sent';
      return Promise.resolve().then(function () { return opts.send(op); }).then(function () {
        op.state = 'ok';
        op.at = now();
        expire(op);
        changed();
        if (op.done) op.done(true);
        if (opts.onSent) opts.onSent(op);
      }, function (e) {
        drop(op);
        changed();
        if (op.done) op.done(false);
        if (opts.onError) opts.onError(op, e);
      });
    });
    return op;
  }
  function op(fields) { fields.n = ++n; ops.push(fields); return fields; }

  // From a reload that started at startedAt: lists as HA has them, [{uid, title, notes, assignee, done}].
  store.setBase = function (list, its, startedAt) {
    base[list] = its;
    var al = {}, old = alias[list] || {};
    its.forEach(function (it) { if (old[it.uid]) al[it.uid] = old[it.uid]; });
    alias[list] = al;
    ops.slice().forEach(function (o) {
      if (o.list !== list) return;
      if (o.kind === 'add') {
        var hit = its.filter(function (it) { return !it.done && same(it.title, o.title); })[0];
        if (hit && !al[hit.uid]) al[hit.uid] = o.tmp; // keeps the row's id (and DOM node)
      }
      if (o.state !== 'ok' || startedAt < o.at) return;
      var s = settled(o, its);
      drop(o);
      if (s === false && opts.onMismatch) opts.onMismatch(o);
    });
    changed();
  };
  store.items = items;
  store.find = byId;
  store.loaded = function (list) { return !!base[list]; };
  store.pending = function () { return ops.filter(function (o) { return o.state === 'queued' || o.state === 'sent'; }).length; };

  // Each returns a Promise: true once HA confirmed, false if it failed, and { dup: item } for an add
  // that's already on the list.
  function wait(o) {
    return new Promise(function (ok) { o.done = ok; });
  }

  store.add = function (list, title, notes) {
    title = String(title || '').trim().slice(0, 120);
    if (!title || !store.online) return Promise.resolve(false);
    var dup = items(list).filter(function (it) { return !it.done && same(it.title, title); })[0];
    if (dup) return Promise.resolve({ dup: dup });
    var o = op({ list: list, kind: 'add', tmp: 't' + (n + 1), title: title, notes: String(notes || '').trim() });
    var p = wait(o);
    send(o);
    return p;
  };
  store.toggle = function (list, id, done) {
    var it = byId(list, id);
    if (!it || !it.uid || !store.online) return Promise.resolve(false);
    var o = op({ list: list, kind: 'set', uid: it.uid, title: it.title, patch: { done: !!done } });
    var p = wait(o);
    send(o);
    return p;
  };
  // fields: { title, notes } (an assignee, if any, is kept).
  store.edit = function (list, id, fields) {
    var it = byId(list, id);
    if (!it || !it.uid || !store.online) return Promise.resolve(false);
    var patch = {};
    var t = String(fields.title == null ? it.title : fields.title).trim().slice(0, 120);
    if (t && t !== it.title) patch.title = t;
    var nn = String(fields.notes == null ? it.notes : fields.notes).trim();
    if (nn !== it.notes) patch.notes = nn;
    if (!Object.keys(patch).length) return Promise.resolve(true);
    if (patch.title && items(list).some(function (x) { return x.id !== id && same(x.title, patch.title); })) return Promise.resolve({ dup: true });
    var o = op({ list: list, kind: 'set', uid: it.uid, title: it.title, patch: patch, assignee: it.assignee, notes: nn });
    var p = wait(o);
    send(o);
    return p;
  };
  // Hidden now, sent after holdMs unless undone. Returns undo(), or null.
  function held(o) {
    var timer = setTimeout(function () { send(o); }, holdMs);
    changed();
    return function () {
      if (o.state) return false; // already on its way
      clearTimeout(timer);
      drop(o);
      changed();
      return true;
    };
  }
  store.remove = function (list, id) {
    var it = byId(list, id);
    if (!it || !it.uid || !store.online) return null;
    return held(op({ list: list, kind: 'remove', uid: it.uid, title: it.title }));
  };
  store.clearDone = function (list) {
    var uids = items(list).filter(function (it) { return it.done && it.uid; }).map(function (it) { return it.uid; });
    if (!uids.length || !store.online) return null;
    return held(op({ list: list, kind: 'clear', uids: uids }));
  };
  return store;
}

// What script.frame_todo gets for an op (entity: the list's to-do entity).
export function scriptData(op, entity) {
  var d = { entity_id: entity };
  if (op.kind === 'add') { d.op = 'add'; d.title = op.title; if (op.notes) d.description = op.notes; }
  else if (op.kind === 'remove') { d.op = 'delete'; d.uid = op.uid; }
  else if (op.kind === 'clear') { d.op = 'clear_completed'; }
  else if ('done' in op.patch) { d.op = op.patch.done ? 'complete' : 'reopen'; d.uid = op.uid; }
  else {
    d.op = 'edit'; d.uid = op.uid;
    if (op.patch.title) d.rename = op.patch.title;
    if ('notes' in op.patch) d.description = joinDesc(op.patch.notes, op.assignee);
  }
  return d;
}

// Quick-add history for the grocery list: { "lower title": { t, n (times bought), last (ms) } }.
export function bumpHistory(hist, title, t, bought) {
  var k = String(title || '').trim().toLowerCase();
  if (!k) return hist;
  var h = hist[k] || { t: String(title).trim(), n: 0, last: 0 };
  h.t = String(title).trim();
  if (bought) h.n++;
  h.last = t;
  hist[k] = h;
  var keys = Object.keys(hist);
  if (keys.length > 200) {
    keys.sort(function (a, b) { return hist[a].last - hist[b].last; }).slice(0, keys.length - 200).forEach(function (x) { delete hist[x]; });
  }
  return hist;
}
// Most bought first, then most recent; ties keep a stable order.
export function topHistory(hist, max) {
  return Object.keys(hist).map(function (k) { return hist[k]; })
    .sort(function (a, b) { return b.n - a.n || b.last - a.last || (a.t < b.t ? -1 : 1); })
    .slice(0, max).map(function (h) { return h.t; });
}

// Demo mode (no Worker configured): makes an op in a plain array, standing in for HA.
var lid = 0;
export function applyLocal(items, op) {
  var i;
  if (op.kind === 'add') {
    var hit = items.filter(function (it) { return same(it.title, op.title); })[0];
    if (hit) hit.done = false;
    else items.push({ uid: 'l' + (++lid), title: op.title, notes: op.notes || '', assignee: '', done: false });
  } else if (op.kind === 'set') {
    for (i = 0; i < items.length; i++) if (items[i].uid === op.uid) for (var k in op.patch) items[i][k] = op.patch[k];
  } else if (op.kind === 'remove') {
    for (i = items.length - 1; i >= 0; i--) if (items[i].uid === op.uid) items.splice(i, 1);
  } else if (op.kind === 'clear') {
    for (i = items.length - 1; i >= 0; i--) if (items[i].done && op.uids.indexOf(items[i].uid) > -1) items.splice(i, 1);
  }
}
