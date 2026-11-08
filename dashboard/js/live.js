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
// HA's lists are filled from the iPhone Shortcut by ha/reminders-sync.yaml. Ticking a grocery item
// on the frame completes it in HA. An item's assignee is the "Assigned: Name" line of its description.
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
  // Re-apply only when the phone pushed something new, so ticks made on the frame stick until then.
  function applyReminders(j) {
    if (App.reminders.updated === j.updated) return false;
    var lists = j.lists || {};
    // From HA, ticked items stay (done) until the phone drops them; the Worker only sends open ones.
    D.groceries = list(lists, GROCERY_LIST).filter(function (it) { return !it.done || it.uid; }).map(function (it, i) {
      return {
        id: 'r' + i, name: it.title, cat: App.categorize(it.title), qty: 1, store: 'grocer', done: !!it.done, note: it.notes || '',
        ha: it.uid ? { uid: it.uid, entity: it.entity } : undefined
      };
    });
    App.reminders = {
      updated: j.updated,
      pinned: list(lists, PINNED_LIST).filter(function (it) { return !it.done; }).map(function (it) {
        return { title: it.title, notes: it.notes, assignee: it.assignee, who: it.assignee ? personFromName(it.assignee) : null };
      })
    };
    return true;
  }
  // "notes\nAssigned: Name" → { notes, assignee }
  function splitDesc(d) {
    var lines = String(d || '').split('\n'), m = /^Assigned:\s*(.+)$/.exec(lines[lines.length - 1] || '');
    if (m) lines.pop();
    return { notes: lines.join('\n').trim() || undefined, assignee: m ? m[1].trim() : undefined };
  }
  // HA to-do lists in the Worker's /reminders shape. updated is a fingerprint of the lists, so the
  // frame re-applies them only when something changed.
  function haReminders() {
    var ids = [HA_GROCERY, HA_PINNED].filter(Boolean);
    return App.ha.call('POST', '/api/services/todo/get_items?return_response', { entity_id: ids, status: ['needs_action', 'completed'] })
      .then(function (r) {
        var res = (r && r.service_response) || {}, lists = {};
        function items(id) {
          if (!res[id]) throw new Error('no to-do list ' + id);
          return res[id].items.map(function (it) {
            var d = splitDesc(it.description);
            return { title: it.summary, notes: d.notes, assignee: d.assignee, done: it.status === 'completed', uid: it.uid, entity: id };
          });
        }
        if (HA_GROCERY) lists[GROCERY_LIST] = items(HA_GROCERY);
        if (HA_PINNED) lists[PINNED_LIST] = items(HA_PINNED);
        return { updated: 'ha:' + JSON.stringify(lists), lists: lists, source: 'ha' };
      });
  }
  function workerReminders() {
    return fetch(API + '/reminders', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  // A grocery item ticked (or un-ticked) on the frame; HA keeps it until the phone drops it.
  App.reminderDone = function (g, done) {
    if (!g.ha || !haOn()) return;
    App.ha.call('POST', '/api/services/todo/update_item', { entity_id: g.ha.entity, item: g.ha.uid, status: done ? 'completed' : 'needs_action' })
      .catch(function (e) { App.toast('Couldn’t update Home Assistant · ' + App.esc(e.message), { tone: 'error', icon: 'bolt' }); });
  };
  function loadReminders() {
    (haOn() && (HA_GROCERY || HA_PINNED) ? haReminders().catch(function (e) {
      console.warn('HA to-do lists failed, using the Worker', e);
      return workerReminders();
    }) : workerReminders())
      .then(function (j) {
        if (!j.lists) throw new Error(j.error || 'no lists');
        try { localStorage.setItem(RCACHE, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
        if (applyReminders(j)) { App.emit('data'); App.rerender(); }
      })
      .catch(function (e) { console.warn('Reminders fetch failed', e); });
  }
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
        if (applyPhotos(j)) App.emit('data');
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
        apply(j);
        try { localStorage.setItem(CACHE, JSON.stringify(j)); } catch (e) { /* storage full or disabled */ }
        App.emit('data');
        App.rerender();
      })
      .catch(function (e) { console.warn('Calendar fetch failed', e); });
  }

  D.events = [];
  D.busyExtras = [];
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (cached && cached.events) apply(cached);
  } catch (e) { /* ignore a bad cache */ }

  D.stores = [{ id: 'grocer', name: 'Groceries' }];
  D.groceries = [];
  App.reminders = { updated: undefined, pinned: [] };
  try {
    var rcached = JSON.parse(localStorage.getItem(RCACHE) || 'null');
    if (rcached && rcached.lists) applyReminders(rcached);
  } catch (e) { /* ignore a bad cache */ }

  try {
    var pcached = JSON.parse(localStorage.getItem(PCACHE) || 'null');
    if (pcached) applyPhotos(pcached);
  } catch (e) { /* ignore a bad cache */ }

  App.startCalendar = function () {
    load();
    loadReminders();
    loadPhotos();
    setInterval(function () { load(); loadReminders(); }, 5 * 60000);
    setInterval(loadPhotos, 15 * 60000);
  };
})();
