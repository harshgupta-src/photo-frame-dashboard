// Live data from the frame-data Worker, refreshed every 5 min and cached in localStorage so a reboot
// without Wi-Fi still shows something:
//   /events     iCloud calendars via CalDAV → D.events
//   /reminders  Apple Reminders lists pushed by an iPhone Shortcut → D.groceries ("Grocery list")
//               and App.reminders.pinned (CONFIG.pinnedList, shown on the Today screen)
//   /photos     iCloud Shared Album → D.photos (images load through the Worker's /photo proxy)
// Build-time config in dashboard/.env.local (gitignored): VITE_FRAME_API, VITE_FRAME_KEY.
//
// With Home Assistant set up on the frame (App.ha.ready, see ha.js), calendars and Reminders come
// from HA over the LAN instead, and the Worker is the fallback when HA can't be reached:
//   VITE_HA_CALENDARS  "calendar.entity:person+person,..." (CalDAV calendars; person ids as in VITE_PEOPLE)
//   VITE_HA_GROCERY    to-do entity for the grocery list, e.g. todo.grocery_list
//   VITE_HA_PINNED     to-do entity for CONFIG.pinnedList, e.g. todo.loml
// HA's lists are filled from the iPhone Shortcut by ha/reminders-sync.yaml. An item's assignee is the
// "Assigned: Name" line of its description. When one of those to-do entities changes in HA (its state
// is the open-item count; the kiosk streams it, ha.js), the lists are reloaded about a second later
// instead of at the next 5-min poll.
// App.todo (todo.js) edits both lists: add, tick/untick, rename and notes, delete, clear completed.
// Each change goes through HA's script.frame_todo, which also notes it for the iPhone Shortcut so the
// next push from the phone doesn't undo it (ha/README.md, "Reminders"). Changes show at once and
// HA's state wins once a reload shows it. Without HA (the Worker fallback) the lists are read-only.
// Views get 'data' with 'reminders' when the items change, and 'todo' when App.todo.status() or
// App.todo.pending() does (the "Syncing…" note); they update those parts themselves.
// When HA stops answering (the same test as the Home tab's banner, hastate.js haDown), the lists turn
// read-only within about 15 s instead of at the next reload, and reload once HA is back.
// Polls pause while the page is hidden and catch up once when it's shown (poll.js).
// 'data' is emitted only when something changed, with what changed: 'events', 'reminders', 'photos'.
import { every } from './poll.js';
import { createTodos, scriptData, splitDesc } from './todo.js';
import { haDown } from './hastate.js';

(function () {
  'use strict';
  var D = window.DATA;
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var CACHE = 'live-events-v1', RCACHE = 'live-reminders-v1', PCACHE = 'live-photos-v1', FAVS = 'photo-favs-v1';
  var GROCERY_LIST = 'grocery list', PINNED_LIST = window.CONFIG.pinnedList.toLowerCase();
  if (!API || !KEY) { console.warn('Live calendar off: VITE_FRAME_API / VITE_FRAME_KEY not set'); return; }
  var env = import.meta.env;
  var HA_CALS = String(env.VITE_HA_CALENDARS || '').split(',').map(function (c) {
    var f = c.trim().split(':');
    return { id: f[0], people: (f[1] || '').split('+').filter(Boolean) };
  }).filter(function (c) { return /^calendar\.[a-z0-9_]+$/.test(c.id) && c.people.length; });
  var HA_GROCERY = env.VITE_HA_GROCERY || '', HA_PINNED = env.VITE_HA_PINNED || '';
  function haOn() { return App.ha && App.ha.ready && App.ha.call; }

  function localDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  // Stable, attribute-safe ids (views put them in data-ev and look them up with findEvent).
  function safeId(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'i' + (h >>> 0).toString(36);
  }
  // Walks logged on the frame are mirrored to the family calendar for phones (WALKS.md). The walk
  // tile already shows them, so they're kept off the frame's schedule (UID dog-walk-…).
  function isWalk(e) { return /(^|\|)dog-walk-/.test(e.id); }
  function apply(j) {
    var seen = {};
    D.events = j.events.filter(function (e) { return !isWalk(e); }).map(function (e) {
      var id = safeId(e.id);
      while (seen[id]) id += 'x';
      seen[id] = 1;
      return {
        id: id, title: e.title, people: e.people, allDay: !!e.allDay, cal: e.cal,
        start: e.allDay ? localDate(e.start) : new Date(e.start),
        end: e.allDay ? localDate(e.end) : new Date(e.end),
        loc: e.loc, notes: e.notes
      };
    });
    D.busyExtras = [];
    App.live = { updated: new Date(j.updated), stale: !!j.stale };
  }
  function list(lists, name) {
    for (var k in lists) if (k.trim().toLowerCase() === name) return lists[k];
    return [];
  }
  // The lists as the views see them: HA's (or the Worker's) items with App.todo's pending changes on
  // top. D.groceries and App.reminders.pinned are rebuilt from App.todo on every change; 'data'
  // goes out only when what's shown changed.
  var LISTS = { grocery: HA_GROCERY, pinned: HA_PINNED }, cats = {}, shown = '', shownTodo = '';
  function cat(t) { return cats[t] || (cats[t] = App.categorize(t)); }
  function publish() {
    var t = App.todo;
    D.groceries = t.items('grocery').map(function (it) {
      return { id: it.id, uid: it.uid, name: it.title, cat: cat(it.title), qty: 1, store: 'grocer', done: it.done, note: it.notes, assignee: it.assignee, pending: it.pending };
    });
    var pinned = t.items('pinned').map(function (it) {
      return { id: it.id, uid: it.uid, title: it.title, notes: it.notes, assignee: it.assignee, who: it.assignee ? personFromName(it.assignee) : null, done: it.done, pending: it.pending };
    });
    App.reminders.pinned = pinned.filter(function (it) { return !it.done; });
    App.reminders.pinnedDone = pinned.filter(function (it) { return it.done; });
    var key = JSON.stringify([D.groceries, pinned]), tkey = t.status() + '|' + t.pending();
    if (key !== shown) { shown = key; App.emit('data', 'reminders'); }
    if (tkey !== shownTodo) { shownTodo = tkey; App.emit('todo'); }
  }
  var status = HA_GROCERY || HA_PINNED ? 'loading' : 'readonly', applied = -1;
  App.todo = createTodos({
    send: function (op) { return App.ha.call('POST', '/api/services/script/frame_todo', scriptData(op, LISTS[op.list])); },
    onChange: function () { if (App.reminders) publish(); },
    // Renames and notes don't change the entity's state (no 'ha' push), so look again shortly.
    onSent: function () { reloadSoon(700); },
    onError: function (op, e) {
      App.toast('Couldn’t save' + (op.title ? ' <b>' + App.esc(op.title) + '</b>' : '') + ' · ' + App.esc(e.message), { tone: 'error', icon: 'bolt', ms: 6000 });
      if (op.kind === 'add') App.emit('todo-add-failed', op);
      reloadSoon(300); // see whether HA is still there (status → 'offline' if not)
    },
    onMismatch: function (op) {
      App.toast('Home Assistant didn’t take the change to <b>' + App.esc(op.title || '') + '</b>', { tone: 'error', icon: 'bolt', ms: 6000 });
    }
  });
  App.todo.online = false;
  // 'ok' (editable), 'loading', 'offline' (HA configured but not answering) or 'readonly' (no HA).
  App.todo.status = function () { return App.todo.online ? 'ok' : status; };
  App.todo.can = function (list) { return App.todo.online && !!LISTS[list]; };
  // Reloads can land out of order; only the newest one counts.
  function applyReminders(j, startedAt) {
    if (startedAt < applied) return;
    applied = startedAt;
    var lists = j.lists || {}, ha = j.source === 'ha';
    function items(name) {
      // From HA, ticked items stay (done) until the phone drops them; the Worker only sends open ones.
      return list(lists, name).filter(function (it) { return !it.done || it.uid; }).map(function (it, i) {
        return { uid: it.uid || 'w' + i, title: it.title, notes: it.notes || '', assignee: it.assignee || '', done: !!it.done };
      });
    }
    App.todo.online = ha && haOn();
    if (!ha) status = haOn() && (HA_GROCERY || HA_PINNED) ? 'offline' : 'readonly';
    App.reminders.updated = j.updated;
    App.todo.setBase('grocery', items(GROCERY_LIST), startedAt);
    App.todo.setBase('pinned', items(PINNED_LIST), startedAt);
    publish();
  }
  // HA to-do lists in the Worker's /reminders shape.
  function haReminders() {
    var ids = [HA_GROCERY, HA_PINNED].filter(Boolean);
    return App.ha.call('POST', '/api/services/todo/get_items?return_response', { entity_id: ids, status: ['needs_action', 'completed'] })
      .then(function (r) {
        var res = (r && r.service_response) || {}, lists = {};
        function items(id) {
          if (!res[id]) throw new Error('no to-do list ' + id);
          return res[id].items.map(function (it) {
            var d = splitDesc(it.description);
            return { title: it.summary, notes: d.notes || undefined, assignee: d.assignee || undefined, done: it.status === 'completed', uid: it.uid, entity: id };
          });
        }
        if (HA_GROCERY) lists[GROCERY_LIST] = items(HA_GROCERY);
        if (HA_PINNED) lists[PINNED_LIST] = items(HA_PINNED);
        return { updated: new Date().toISOString(), lists: lists, source: 'ha' };
      });
  }
  function workerReminders() {
    return fetch(API + '/reminders', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  var reloadTimer = null;
  function reloadSoon(ms) { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadReminders, ms); }
  function loadReminders() {
    clearTimeout(reloadTimer);
    var startedAt = Date.now();
    (haOn() && (HA_GROCERY || HA_PINNED) ? haReminders().catch(function (e) {
      console.warn('HA to-do lists failed, using the Worker', e);
      if (App.todo.online || status !== 'offline') { App.todo.online = false; status = 'offline'; publish(); }
      reloadSoon(60000); // try HA again soon rather than at the next 5-minute load
      return workerReminders();
    }) : workerReminders())
      .then(function (j) {
        if (!j.lists) throw new Error(j.error || 'no lists');
        var cachedKey = JSON.stringify(j.lists);
        applyReminders(j, startedAt);
        if (cachedKey === lastCached) return; // unchanged: no storage write
        lastCached = cachedKey;
        try { localStorage.setItem(RCACHE, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
      })
      .catch(function (e) { console.warn('Reminders fetch failed', e); });
  }
  var lastCached = '';
  function favs() { try { return JSON.parse(localStorage.getItem(FAVS) || '{}'); } catch (e) { return {}; } }
  App.saveFavs = function () {
    var f = {};
    D.photos.forEach(function (p) { if (p.fav && p.id) f[p.id] = 1; });
    try { localStorage.setItem(FAVS, JSON.stringify(f)); } catch (e) { /* storage full or disabled */ }
  };
  function personFromName(name) {
    var n = String(name || '').toLowerCase();
    var hit = D.people.filter(function (p) { return n && p.name.toLowerCase() === n.split(' ')[0]; })[0];
    return hit ? hit.id : 'family';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Keeps the demo photos until the album has at least one photo.
  function applyPhotos(j) {
    if (!j.photos || !j.photos.length) return false;
    var f = favs(), q = '&key=' + encodeURIComponent(KEY);
    D.photos = j.photos.map(function (p) {
      var d = new Date(p.date), day = isNaN(d) ? '2000-01-01' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var base = API + '/photo?id=' + encodeURIComponent(p.id);
      return {
        id: p.id, o: p.h > p.w ? 'p' : 'l', date: day, place: p.caption || '', from: personFromName(p.by), tag: day, fav: !!f[p.id],
        url: { l: base + '&s=l' + q, s: base + '&s=s' + q }
      };
    });
    App.photosVer = (App.photosVer || 0) + 1;
    return true;
  }
  function loadPhotos() {
    fetch(API + '/photos', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var ids = (D.photos || []).map(function (p) { return p.id; }).join();
        if (!j.photos || j.photos.map(function (p) { return p.id; }).join() === ids) return;
        try { localStorage.setItem(PCACHE, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
        if (applyPhotos(j)) App.emit('data', 'photos');
      })
      .catch(function (e) { console.warn('Photos fetch failed', e); });
  }
  // HA calendar events in the Worker's /events shape, over the same window (-7 to +45 days).
  function haEvents() {
    var now = Date.now(), from = new Date(now - 7 * 864e5).toISOString(), to = new Date(now + 45 * 864e5).toISOString();
    return Promise.all(HA_CALS.map(function (c) {
      return App.ha.call('GET', '/api/calendars/' + c.id + '?start=' + from + '&end=' + to).then(function (list) {
        var st = App.ha.states[c.id], name = st ? st.attributes.friendly_name : c.id;
        return list.map(function (e) {
          var allDay = !!e.start.date;
          return {
            id: c.id + '|' + (e.uid || e.summary) + '|' + (e.start.date || e.start.dateTime),
            title: e.summary || '', people: c.people, allDay: allDay, cal: name,
            start: allDay ? e.start.date : e.start.dateTime, end: allDay ? e.end.date : e.end.dateTime,
            loc: e.location || undefined, notes: e.description || undefined
          };
        });
      });
    })).then(function (lists) {
      var events = [].concat.apply([], lists);
      events.sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
      return { updated: new Date().toISOString(), events: events, source: 'ha' };
    });
  }
  function workerEvents() {
    return fetch(API + '/events', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function load() {
    (haOn() && HA_CALS.length ? haEvents().catch(function (e) {
      console.warn('HA calendars failed, using the Worker', e);
      return workerEvents();
    }) : workerEvents())
      .then(function (j) {
        if (!j.events) throw new Error(j.error || 'no events');
        // Unchanged calendars (the usual case) skip the redraw: 'data' rebuilds every view.
        var key = eventsKey(j);
        if (key === shownEvents) return;
        shownEvents = key;
        apply(j);
        try { localStorage.setItem(CACHE, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
        App.emit('data', 'events');
        App.rerender();
      })
      .catch(function (e) { console.warn('Calendar fetch failed', e); });
  }

  D.events = [];
  D.busyExtras = [];
  function eventsKey(j) { return JSON.stringify([j.events, !!j.stale]); }
  var shownEvents = null;
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (cached && cached.events) { apply(cached); shownEvents = eventsKey(cached); }
  } catch (e) { /* ignore a bad cache */ }

  D.stores = [{ id: 'grocer', name: 'Groceries' }];
  D.groceries = [];
  App.reminders = { updated: undefined, pinned: [], pinnedDone: [] };
  try {
    var rcached = JSON.parse(localStorage.getItem(RCACHE) || 'null');
    // Shown until the first load; read-only until HA answers.
    if (rcached && rcached.lists) { applyReminders(rcached, 0); applied = -1; App.todo.online = false; publish(); }
  } catch (e) { /* ignore a bad cache */ }

  try {
    var pcached = JSON.parse(localStorage.getItem(PCACHE) || 'null');
    if (pcached) applyPhotos(pcached);
  } catch (e) { /* ignore a bad cache */ }

  // A to-do list changed in HA (an item ticked or added on a phone, or on the frame): reload the lists
  // shortly.
  var HA_TODOS = [HA_GROCERY, HA_PINNED].filter(Boolean), todoSeen = {};
  function todoKey(id) {
    var st = App.ha.states[id];
    return st ? st.state + '|' + st.last_changed + '|' + st.last_updated : '';
  }
  App.on('ha', function (ids) {
    if (!HA_TODOS.length || !haOn()) return;
    if (ids && ids.length && !HA_TODOS.some(function (id) { return ids.indexOf(id) > -1; })) return;
    var hit = false;
    HA_TODOS.forEach(function (id) {
      var k = todoKey(id);
      if (k && todoSeen[id] && todoSeen[id] !== k) hit = true;
      if (k) todoSeen[id] = k;
    });
    if (!hit) return;
    reloadSoon(1000);
  });

  var BOOT = Date.now(), wasDown = false;
  function checkHA() {
    var down = haDown(App.ha, Date.now(), BOOT, 45000);
    if (down === wasDown) return;
    wasDown = down;
    if (!down) return reloadSoon(500);
    if (App.todo.online || status !== 'offline') { App.todo.online = false; status = 'offline'; publish(); }
  }

  App.startCalendar = function () {
    load();
    loadReminders();
    loadPhotos();
    every(5 * 60000, function () { load(); loadReminders(); });
    if (HA_GROCERY || HA_PINNED) every(15000, checkHA);
    every(15 * 60000, loadPhotos, { delay: 5000 });
  };
})();
