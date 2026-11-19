// Home Assistant entity bookkeeping for ha.js, free of DOM APIs so node --test can run it
// (test/hastate.test.js). States are kept as { entity_id: state object }; every function reports the
// entity ids that actually changed, so ha.js only emits 'ha' (and views only repaint) when needed.

// The domains the dashboard reads (views/home.js: light buttons and the thermostat's inside
// temperature; live.js: the grocery / pinned to-do lists). The kiosk streams just these
// (HomeHQ.haWatch); everything else comes from the /api/states poll.
export var WATCH_DOMAINS = ['light', 'climate', 'todo'];

export function domainOf(id) {
  var s = String(id), i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : '';
}

// Same entity state? HA bumps last_updated whenever the state or an attribute changes; the state is
// compared too because the Home card flips it optimistically before HA confirms.
export function sameState(a, b) {
  if (a === b) return true;
  if (!a || !b || a.state !== b.state) return false;
  if (a.last_updated && b.last_updated) return a.last_updated === b.last_updated;
  return JSON.stringify(a.attributes) === JSON.stringify(b.attributes) && a.last_changed === b.last_changed;
}

function stamp(e) { var t = e && Date.parse(e.last_updated); return isFinite(t) ? t : 0; }

// A full GET /api/states answer. keepNewer (while the live stream runs): an entity the stream has
// already moved past the poll's snapshot keeps the stream's copy.
// → { states, changed: [ids] }
export function fromPoll(prev, list, keepNewer) {
  prev = prev || {};
  var next = {}, changed = [];
  (list || []).forEach(function (e) {
    if (!e || !e.entity_id) return;
    var id = e.entity_id, old = prev[id];
    if (keepNewer && old && stamp(old) > stamp(e)) { next[id] = old; return; }
    if (!e.attributes) e.attributes = {};
    next[id] = e;
    if (!sameState(old, e)) changed.push(id);
  });
  Object.keys(prev).forEach(function (id) { if (!(id in next)) changed.push(id); });
  return { states: next, changed: changed };
}

// The kiosk's window.haPush(msg) may hand over the object itself or its JSON text.
export function parsePush(msg) {
  if (typeof msg === 'string') {
    try { msg = JSON.parse(msg); } catch (e) { return null; }
  }
  return msg && typeof msg === 'object' ? msg : null;
}

// Applies a pushed message to states in place → [changed ids].
//   { full: true, live: true, states }  replaces the watched domains' entities (other domains, from
//                                       the poll, stay); domains defaults to WATCH_DOMAINS
//   { live: true, states, removed }     merges changed entities, drops removed ids
//   { live: false }                     nothing to apply (the stream dropped)
// An entity sent without attributes keeps the ones it had.
export function applyPush(states, msg, domains) {
  var changed = [], seen = {};
  if (!msg) return changed;
  (Array.isArray(msg.states) ? msg.states : []).forEach(function (e) {
    if (!e || !e.entity_id) return;
    var id = e.entity_id, old = states[id];
    seen[id] = 1;
    if (!e.attributes) e.attributes = (old && old.attributes) || {};
    if (!sameState(old, e)) changed.push(id);
    states[id] = e;
  });
  if (msg.full) {
    var watched = {};
    (domains || WATCH_DOMAINS).forEach(function (d) { watched[d] = 1; });
    Object.keys(states).forEach(function (id) {
      if (!seen[id] && watched[domainOf(id)]) { delete states[id]; changed.push(id); }
    });
  }
  (Array.isArray(msg.removed) ? msg.removed : []).forEach(function (id) {
    if (!seen[id] && id in states) { delete states[id]; changed.push(id); }
  });
  return changed;
}
