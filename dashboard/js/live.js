// Live data from the frame-data Worker, refreshed every 5 min and cached in localStorage so a reboot
// without Wi-Fi still shows something:
//   /events     iCloud calendars via CalDAV → D.events
//   /reminders  Apple Reminders lists pushed by an iPhone Shortcut → D.groceries ("Grocery list")
//               and App.reminders.pinned (CONFIG.pinnedList, shown on the Today screen)
//   /photos     iCloud Shared Album → D.photos (images load through the Worker's /photo proxy)
// Build-time config in dashboard/.env.local (gitignored): VITE_FRAME_API, VITE_FRAME_KEY.
(function () {
  'use strict';
  var D = window.DATA;
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var CACHE = 'live-events-v1', RCACHE = 'live-reminders-v1', PCACHE = 'live-photos-v1', FAVS = 'photo-favs-v1';
  var GROCERY_LIST = 'grocery list', PINNED_LIST = window.CONFIG.pinnedList.toLowerCase();
  if (!API || !KEY) { console.warn('Live calendar off: VITE_FRAME_API / VITE_FRAME_KEY not set'); return; }

  function localDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  // Stable, attribute-safe ids (views put them in data-ev and look them up with findEvent).
  function safeId(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'i' + (h >>> 0).toString(36);
  }
  function apply(j) {
    var seen = {};
    D.events = j.events.map(function (e) {
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
    D.groceries = list(lists, GROCERY_LIST).filter(function (it) { return !it.done; }).map(function (it, i) {
      return { id: 'r' + i, name: it.title, cat: App.categorize(it.title), qty: 1, store: 'grocer', done: false, note: it.notes || '' };
    });
    App.reminders = {
      updated: j.updated,
      pinned: list(lists, PINNED_LIST).filter(function (it) { return !it.done; })
    };
    return true;
  }
  function loadReminders() {
    fetch(API + '/reminders', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
  function load() {
    fetch(API + '/events', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
