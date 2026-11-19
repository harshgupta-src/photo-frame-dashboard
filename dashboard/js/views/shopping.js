// Shopping: the shared Grocery list (left / top) + quick add (right / bottom).
// Items come from App.todo (todo.js, live.js): Home Assistant's to-do list with the frame's pending
// changes on top. Tap an item to tick it (1.2 s to change your mind, then undo from the toast); the
// pencil opens it to rename, add notes or delete. Ticked items wait, collapsed, under "Got it"
// until the phone drops them or they're cleared. Quick-add tiles are what's bought most often
// (remembered on this device), topped up with the usuals. Changes to the list update only the
// categories that changed. Without Home Assistant the list is read-only.
import { createTodos, applyLocal, bumpHistory, topHistory } from '../todo.js';

(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, store: 'all', query: '', drawer: false, checking: {} };
  var L = 'grocery', HIST = 'grocery-history-v1';
  window.ICONS.pencil = '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>';
  window.ICONS.trash = '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>';

  // Demo (no Worker configured): the sample list, edited in memory.
  var T = App.todo;
  if (!T) {
    var local = D.groceries.map(function (g) { return { uid: g.id, title: g.name, notes: g.note, assignee: '', done: g.done, store: g.store }; });
    var stores = {};
    local.forEach(function (it) { stores[it.uid] = it.store; });
    T = App.todo = createTodos({
      send: function (op) { applyLocal(local, op); return Promise.resolve(); },
      onSent: function () { T.setBase(L, local.slice(), Date.now()); },
      onChange: function () {
        D.groceries = T.items(L).map(function (it) {
          return { id: it.id, uid: it.uid, name: it.title, cat: App.categorize(it.title), qty: 1, store: stores[it.uid] || 'grocer', done: it.done, note: it.notes, pending: it.pending };
        });
        App.emit('data', 'reminders');
      }
    });
    T.status = function () { return 'ok'; };
    T.can = function (list) { return list === L; };
    T.setBase(L, local.slice(), 0);
  }

  function can() { return T.can(L); }
  function open() { return D.groceries.filter(function (g) { return !g.done && (V.store === 'all' || g.store === V.store); }); }
  function done() { return D.groceries.filter(function (g) { return g.done && (V.store === 'all' || g.store === V.store); }); }
  function byId(id) { return D.groceries.filter(function (g) { return g.id === id; })[0]; }
  function find(name, isDone) {
    return D.groceries.filter(function (g) { return !!g.done === isDone && g.name.toLowerCase() === name.toLowerCase(); })[0];
  }
  var categorize = App.categorize;

  // ---- quick-add history: what went from the list to bought (ticked here or on a phone)
  var hist = {};
  try { hist = JSON.parse(localStorage.getItem(HIST) || '{}') || {}; } catch (e) { hist = {}; }
  var seenOpen = null, deleted = {};
  function saveHist() { try { localStorage.setItem(HIST, JSON.stringify(hist)); } catch (e) { /* storage full or disabled */ } }
  function learn() {
    var now = Date.now(), openNow = {}, doneNow = {}, changed = false;
    D.groceries.forEach(function (g) {
      if (g.pending) return;
      if (g.done) doneNow[g.name.toLowerCase()] = 1; else openNow[g.name.toLowerCase()] = g.name;
    });
    if (seenOpen) {
      for (var k in seenOpen) {
        if (openNow[k]) continue;
        // Ticked here, or gone after a phone push (ticked there): bought. Deleted or renamed here: forgotten
        // unless it was bought before.
        if (doneNow[k] || !deleted[k]) bumpHistory(hist, seenOpen[k], now, true);
        else if (hist[k] && !hist[k].n) delete hist[k];
        changed = true;
        delete deleted[k];
      }
    }
    for (var n in openNow) if (!hist[n]) { bumpHistory(hist, openNow[n], now, false); changed = true; }
    seenOpen = openNow;
    if (changed) saveHist();
  }
  function quickAdds() {
    var out = topHistory(hist, 12), have = {};
    out.forEach(function (t) { have[t.toLowerCase()] = 1; });
    D.usuals.forEach(function (t) { if (out.length < 12 && !have[t.toLowerCase()]) { out.push(t); have[t.toLowerCase()] = 1; } });
    return out;
  }

  // ---- HTML
  function row(g) {
    return '<div class="s-row' + (V.checking[g.id] ? ' is-checking' : '') + (g.pending ? ' is-pending' : '') + '" data-id="' + App.esc(g.id) + '">' +
      '<button class="s-hit" data-check="' + App.esc(g.id) + '">' +
      '<span class="s-box">' + App.icon('check', 22) + '</span>' +
      '<span class="s-name"><b>' + App.esc(g.name) + '</b>' + (g.note ? '<small>' + App.esc(g.note) + '</small>' : '') + '</span>' +
      (V.store === 'all' && g.store === 'costco' ? '<span class="s-store">Costco</span>' : '') +
      '</button>' +
      (g.uid && !g.pending ? '<button class="s-edit" data-edit="' + App.esc(g.id) + '" aria-label="Edit">' + App.icon('pencil', 24) + '</button>' : '<span class="s-edit"></span>') +
      '</div>';
  }
  function groups() {
    var items = open(), order = (D.catOrder[V.store] || D.catOrder.all).concat(['Other']);
    return order.map(function (cat) { return { cat: cat, items: items.filter(function (g) { return g.cat === cat; }) }; })
      .filter(function (x) { return x.items.length; });
  }
  function catHTML(gr) {
    return '<div class="s-cat-h"><span class="label">' + gr.cat + '</span><span class="label">' + gr.items.length + '</span></div>' + gr.items.map(row).join('');
  }
  function drawerHTML() {
    var d = done();
    if (!d.length) return '';
    return '<button class="s-drawer-h" data-drawer><span>' + App.icon('check', 22) + ' Got it <b class="num">(' + d.length + ')</b></span><span class="label">' + (V.drawer ? 'Hide' : 'Show') + '</span></button>' +
      (V.drawer ? '<div class="s-drawer-list">' + d.map(function (g) {
        return '<button class="s-got' + (g.pending ? ' is-pending' : '') + '" data-revive="' + App.esc(g.id) + '"><span class="s-got-t">' + App.esc(g.name) + '</span><span class="label">Add back</span></button>';
      }).join('') + '<button class="btn btn--ghost s-clear" data-clear>Clear ' + d.length + ' checked item' + (d.length === 1 ? '' : 's') + '</button></div>' : '');
  }
  function emptyHTML() {
    return T.status() === 'loading' && !D.groceries.length ? '<div class="s-empty serif">Loading the list…</div>'
      : '<div class="s-empty serif">All stocked up.<br><i>Nothing left to buy.</i></div>';
  }

  function suggestHTML() {
    var q = V.query.trim().toLowerCase();
    if (q) {
      var matches = D.catalog.map(function (c) { return c[0]; }).concat(Object.keys(hist).map(function (k) { return hist[k].t; }));
      var seen = {};
      matches = matches.filter(function (m) { var k = m.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
      matches = matches.filter(function (m) { return m.toLowerCase().indexOf(q) === 0; })
        .concat(matches.filter(function (m) { return m.toLowerCase().indexOf(q) > 0; })).slice(0, 5);
      var exact = matches.some(function (m) { return m.toLowerCase() === q; });
      return '<div class="label">Suggestions</div><div class="s-ac">' + matches.map(function (m) {
        var on = find(m, false);
        return '<button class="s-ac-row" data-add="' + App.esc(m) + '"><b>' + App.esc(m) + '</b><span class="label">' + (on ? 'On list' : categorize(m)) + '</span>' + App.icon('plus', 26) + '</button>';
      }).join('') + (exact ? '' : '<button class="s-ac-row s-ac-row--new" data-add="' + App.esc(V.query.trim()) + '"><b>Add “' + App.esc(V.query.trim()) + '”</b><span class="label">' + categorize(V.query) + '</span>' + App.icon('plus', 26) + '</button>') + '</div>';
    }
    return '<div class="label">Usuals · tap to add</div><div class="s-usuals">' + quickAdds().map(usualTile).join('') + '</div>';
  }
  function usualTile(name) {
    var on = find(name, false);
    return '<button class="s-tile' + (on ? ' is-on' : '') + '" data-add="' + App.esc(name) + '">' +
      '<b>' + App.esc(name) + '</b><span>' + (on ? App.icon('check', 16) + 'On list' : categorize(name)) + '</span></button>';
  }
  function syncText() {
    var st = T.status();
    if (st === 'ok') return T.pending() ? 'Syncing…' : '';
    if (st === 'loading') return 'Connecting…';
    if (st === 'offline') return 'Can’t reach Home Assistant · read-only';
    return App.ha && App.ha.web && !App.ha.web.signedIn ? 'Sign in to Home Assistant to edit' : 'Read-only';
  }

  // ---- painting: only what changed
  function paintList() {
    var l = V.el.querySelector('.s-list'), gs = groups(), have = {}, prev = null;
    gs.forEach(function (gr) { have[gr.cat] = 1; });
    App.$$('.s-cat', l).forEach(function (c) { if (!have[c.dataset.cat]) l.removeChild(c); });
    var empty = l.querySelector('.s-empty');
    if (gs.length && empty) l.removeChild(empty);
    if (!gs.length && !empty) l.insertAdjacentHTML('afterbegin', emptyHTML());
    gs.forEach(function (gr) {
      var c = l.querySelector('.s-cat[data-cat="' + gr.cat + '"]'), h = catHTML(gr);
      if (!c) {
        c = document.createElement('div');
        c.className = 's-cat';
        c.dataset.cat = gr.cat;
        l.insertBefore(c, prev ? prev.nextSibling : l.firstChild);
      }
      if (c._h !== h) { c._h = h; c.innerHTML = h; }
      prev = c;
    });
    var dr = l.querySelector('.s-drawer'), dh = drawerHTML();
    if (!dh && dr) l.removeChild(dr);
    if (dh) {
      if (!dr) { dr = document.createElement('div'); dr.className = 's-drawer'; l.appendChild(dr); }
      dr.classList.toggle('is-open', V.drawer);
      if (dr._h !== dh) { dr._h = dh; dr.innerHTML = dh; }
    }
    paintHead();
  }
  function paintSuggest() {
    var s = V.el.querySelector('.s-suggest'), h = suggestHTML();
    if (s._h !== h) { s._h = h; s.innerHTML = h; }
  }
  function paintHead() {
    var all = D.groceries.filter(function (g) { return !g.done; });
    V.el.querySelector('.s-count').innerHTML = '<span class="num">' + open().length + '</span> to get';
    var seg = V.el.querySelector('.s-stores');
    seg.style.display = D.stores.length < 2 ? 'none' : '';
    if (D.stores.length > 1) {
      seg.innerHTML = [['all', 'All']].concat(D.stores.map(function (s) { return [s.id, s.name]; })).map(function (s) {
        var n = s[0] === 'all' ? all.length : all.filter(function (g) { return g.store === s[0]; }).length;
        return '<button class="' + (V.store === s[0] ? 'is-on' : '') + '" data-store="' + s[0] + '">' + s[1] + ' <span class="num">' + n + '</span></button>';
      }).join('');
    }
    paintSync();
  }
  function paintSync() {
    var t = syncText(), ro = !can(), el = V.el.querySelector('.s-sync');
    el.textContent = t;
    el.className = 's-sync' + (ro ? ' is-warn' : '');
    V.el.querySelector('.shop').classList.toggle('is-ro', ro);
    var input = V.el.querySelector('.s-input');
    input.disabled = ro;
    input.placeholder = ro ? 'Adding needs Home Assistant' : 'Add an item…';
  }
  function render() {
    V.el.innerHTML = '<div class="shop">' +
      '<header class="s-head"><div><div class="label">Shared list</div><h1 class="serif">Groceries</h1></div><div class="s-count"></div><span class="s-sync"></span><div class="seg s-stores"></div></header>' +
      '<div class="s-list"></div>' +
      '<aside class="s-side">' +
      '  <form class="s-add" action="#">' +
      '    <label class="s-input-wrap">' + App.icon('plus', 30) + '<input class="s-input" placeholder="Add an item…" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" maxlength="120"></label>' +
      '    <button class="s-add-btn" type="submit" aria-label="Add">Add</button>' +
      '  </form>' +
      '  <div class="s-suggest"></div>' +
      '</aside></div>';
    var input = V.el.querySelector('.s-input');
    input.value = V.query;
    input.addEventListener('input', function () { V.query = input.value; paintSuggest(); });
    V.el.querySelector('.s-add').addEventListener('submit', function (e) {
      e.preventDefault();
      if (input.value.trim()) add(input.value);
    });
    paintList(); paintSuggest();
  }
  function flash(id) {
    var r = V.el && V.el.querySelector('.s-list [data-id="' + id + '"]');
    if (!r) return;
    r.classList.add('is-flash');
    if (r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { r.classList.remove('is-flash'); }, 1200);
  }

  // ---- actions
  function setQuery(q) {
    V.query = q;
    var input = V.el.querySelector('.s-input');
    if (input) input.value = q;
    paintSuggest();
  }
  function add(name) {
    name = name.trim();
    if (!name) return;
    if (!can()) { App.toast('The list is read-only right now · ' + App.esc(syncText()), { tone: 'error', icon: 'bolt' }); return; }
    var c = D.catalog.filter(function (x) { return x[0].toLowerCase() === name.toLowerCase(); })[0];
    var title = c ? c[0] : name.charAt(0).toUpperCase() + name.slice(1);
    var typed = V.query;
    setQuery('');
    T.add(L, title).then(function (r) {
      if (r && r.dup) { App.toast('<b>' + App.esc(r.dup.title) + '</b> is already on the list', { icon: 'cart', ms: 2500 }); return flash(r.dup.id); }
      // Failed: put what was typed back (live.js has said why).
      if (!r && typed.trim() && V.el && !V.query) setQuery(typed);
    });
    var g = find(title, false);
    if (g) { App.toast('Added <b>' + App.esc(g.name) + '</b> to ' + g.cat, { icon: 'cart', ms: 2500 }); flash(g.id); }
  }
  function check(g) {
    if (!can()) return;
    var id = g.id;
    V.checking[id] = setTimeout(function () {
      delete V.checking[id];
      T.toggle(L, id, true);
    }, 1200);
    var r = V.el.querySelector('.s-list [data-id="' + id + '"]');
    if (r) r.classList.add('is-checking');
    App.toast('<b>' + App.esc(g.name) + '</b> checked off', {
      icon: 'check',
      undo: function () {
        if (V.checking[id]) { uncheck(id); return; }
        T.toggle(L, id, false);
      }
    });
  }
  function uncheck(id) {
    clearTimeout(V.checking[id]);
    delete V.checking[id];
    var r = V.el.querySelector('.s-list [data-id="' + id + '"]');
    if (r) r.classList.remove('is-checking');
  }

  // Shared with the pinned list's sheet (home.js): rename, notes, delete with undo.
  App.todoEditSheet = function (list, id, opts) {
    opts = opts || {};
    var it = T.find(list, id);
    if (!it) return;
    var name = list === L ? 'Grocery list' : window.CONFIG.pinnedList;
    App.sheet('<form class="sheet-pad te" action="#"><div class="label">' + App.esc(name) + '</div>' +
      '<input class="te-title" value="' + App.esc(it.title) + '" maxlength="120" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" aria-label="Title">' +
      '<textarea class="te-notes" rows="3" maxlength="500" placeholder="Notes" aria-label="Notes">' + App.esc(it.notes || '') + '</textarea>' +
      (it.assignee ? '<p class="te-who">Assigned to <b>' + App.esc(it.assignee) + '</b> in Reminders</p>' : '') +
      '<div class="sheet-actions te-actions"><button type="button" class="btn btn--ghost te-del">' + App.icon('trash', 22) + 'Delete</button>' +
      '<button type="submit" class="btn btn--solid te-save">Save</button></div></form>', {
      cls: 'sheet--edit' + (App.phone ? '' : ' sheet--top'),
      onClose: opts.onClose,
      onMount: function (el, close) {
        var form = el.querySelector('.te');
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var title = el.querySelector('.te-title').value.trim();
          if (!title) { el.querySelector('.te-title').focus(); return; }
          if (list === L && title.toLowerCase() !== it.title.toLowerCase()) deleted[it.title.toLowerCase()] = 1;
          T.edit(list, id, { title: title, notes: el.querySelector('.te-notes').value }).then(function (r) {
            if (r && r.dup) App.toast('<b>' + App.esc(title) + '</b> is already on the list', { tone: 'error', icon: 'bolt' });
          });
          close();
        });
        el.querySelector('.te-del').addEventListener('click', function () {
          close();
          // Marked before remove(): it re-renders (and learn() runs) at once, and a deleted item mustn't count as bought.
          var k = it.title.toLowerCase();
          if (list === L) deleted[k] = 1;
          var undo = T.remove(list, id);
          if (undo) App.toast('Deleted <b>' + App.esc(it.title) + '</b>', { icon: 'trash', undo: function () { delete deleted[k]; undo(); } });
        });
      }
    });
  };

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-check]'))) {
      var g = byId(t.dataset.check);
      if (!g || g.pending) return;
      if (V.checking[g.id]) uncheck(g.id); else check(g);
      return;
    }
    if ((t = e.target.closest('[data-edit]'))) return App.todoEditSheet(L, t.dataset.edit);
    if ((t = e.target.closest('[data-add]'))) {
      var on = find(t.dataset.add, false);
      if (on) { App.toast('<b>' + App.esc(on.name) + '</b> is already on the list', { icon: 'cart', ms: 2500 }); return flash(on.id); }
      return add(t.dataset.add);
    }
    if ((t = e.target.closest('[data-store]'))) { V.store = t.dataset.store; return paintList(); }
    if ((t = e.target.closest('[data-drawer]'))) { V.drawer = !V.drawer; return paintList(); }
    if ((t = e.target.closest('[data-revive]'))) {
      var r = byId(t.dataset.revive);
      if (!r || r.pending || !can()) return;
      T.toggle(L, r.id, false);
      return App.toast('Added back <b>' + App.esc(r.name) + '</b>', { icon: 'cart', ms: 2500 });
    }
    if ((t = e.target.closest('[data-clear]'))) {
      var n = done().length, undo = T.clearDone(L);
      V.drawer = false;
      paintList();
      if (undo) App.toast('Cleared ' + n + ' item' + (n === 1 ? '' : 's'), { icon: 'check', undo: undo });
    }
  }

  App.on('data', function (what) {
    if (what && what !== 'reminders') return;
    learn();
    if (V.el && V.el.firstChild && App.onScreen('shopping')) { paintList(); paintSuggest(); }
  });
  App.on('todo', function () { if (V.el && V.el.firstChild && App.onScreen('shopping')) { paintSync(); paintList(); } });

  App.register('shopping', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
})();
