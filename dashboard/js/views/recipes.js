// Recipes: the recipe notes in the Obsidian vault (RECIPES.md), from the Worker's GET /recipes. Only on
// phones, iPads and browsers: the frame (the kiosk, window.HomeHQ) never shows the tab or fetches them.
// The last copy is kept in localStorage, so the kitchen still has the recipes when the network drops.
// While a recipe is open: tap ingredients to tick them off, tap a step to mark where you are, and the
// screen stays on (Screen Wake Lock, where the browser has it).
(function () {
  'use strict';
  if (window.HomeHQ) {
    var tab = document.querySelector('.rail-item[data-go="recipes"]');
    if (tab) tab.remove();
    return;
  }
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var CACHE = 'recipes-v1', esc = App.esc;
  var R = { on: !!(API && KEY), data: null, error: null, updated: null, busy: false };
  var V = { el: null, sel: null, q: '', detail: false, done: {}, step: {} };

  function read() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }

  function refresh(force) {
    if (!R.on) return Promise.resolve();
    R.busy = true;
    var changed = false;
    return fetch(API + '/recipes' + (force ? '?refresh=1' : ''), { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }); })
      .then(function (j) {
        changed = JSON.stringify(j.recipes) !== JSON.stringify(R.data && R.data.recipes);
        R.data = j; R.error = j.stale ? j.error || 'Showing the last copy' : null; R.updated = Date.now();
        write({ at: R.updated, data: j });
      })
      .catch(function (e) { R.error = e.message; console.warn('Recipes sync failed', e); })
      .then(function () {
        R.busy = false;
        // Left the tab meanwhile: redraw when it's next opened (the router rebuilds dirty views), so a
        // stale "Loading…" can't stick.
        if (!App.onScreen('recipes')) { if (App.views.recipes._built) App.views.recipes._dirty = true; }
        else if (changed || !R.data) render(); else syncLine();
      });
  }

  function recipes() { return (R.data && R.data.recipes) || []; }
  function find(id) { return recipes().filter(function (r) { return r.id === id; })[0]; }
  function filtered() {
    var words = V.q.toLowerCase().split(/\s+/).filter(Boolean);
    return recipes().filter(function (r) {
      var hay = (r.title + ' ' + r.summary + ' ' + r.body).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) > -1; });
    });
  }
  function dateLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? '' : App.fmt.monthShort(d) + ' ' + d.getDate() + (d.getFullYear() !== App.now().getFullYear() ? ', ' + d.getFullYear() : '');
  }

  // ---------------------------------------------------------------- markdown
  // The subset the recipe notes use: ## / ### headings, - and 1. lists, > quotes, paragraphs, **bold**,
  // _italic_, `code`, [links](https://…) and [[wikilinks]] (to another recipe when there is one).
  // Input is escaped first. Fact dates ("_(2026-11-14)_") are dropped; they're for agents.
  function inline(s) {
    s = esc(s).replace(/\s*_\(\d{4}-\d{2}-\d{2}\)_/g, '');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])[_*]([^_*]+)[_*](?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (m, target, label) {
      var name = target.replace(/#.*$/, '').trim(), text = label || name;
      var raw = name.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      return find(raw) ? '<button class="rc-link" data-open="' + name + '">' + text + '</button>' : text;
    });
  }
  function md(text) {
    var out = [], list = null, para = [];
    function flush() {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
      if (list) { out.push('</' + list + '>'); list = null; }
    }
    text.split('\n').forEach(function (line) {
      var h = line.match(/^(#{2,4})\s+(.*)$/), li = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), q = line.match(/^>\s?(.*)$/);
      if (h) { flush(); out.push('<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>'); }
      else if (li || ol) {
        if (para.length) flush();
        var want = li ? 'ul' : 'ol';
        if (list !== want) { if (list) out.push('</' + list + '>'); out.push('<' + want + '>'); list = want; }
        out.push('<li>' + inline((li || ol)[1]) + '</li>');
      }
      else if (q) { flush(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); }
      else if (!line.trim()) flush();
      else { if (list) flush(); para.push(line.trim()); }
    });
    flush();
    return out.join('');
  }
  // ## sections; History is kept for the record but folded away.
  function sections(body) {
    var parts = ('\n' + body).split(/\n(?=## )/).filter(function (p) { return p.trim(); });
    return parts.map(function (p) {
      var m = p.match(/^\n?## +(.*)\n?([\s\S]*)$/);
      if (!m) return '<section class="rc-sec">' + md(p) + '</section>';
      var title = m[1].trim(), html = md(m[2]);
      if (/^history$/i.test(title)) return '<details class="rc-sec rc-hist"><summary>' + inline(title) + '</summary>' + html + '</details>';
      var kind = /^recipe$/i.test(title) ? ' rc-sec--recipe' : /^key facts$/i.test(title) ? ' rc-sec--facts' : '';
      return '<section class="rc-sec' + kind + '"><h2>' + inline(title) + '</h2>' + html + '</section>';
    }).join('');
  }

  // ---------------------------------------------------------------- page
  function syncText() {
    if (!R.on) return 'Demo recipes';
    if (R.busy && !R.data) return 'Loading…';
    var at = R.data && R.data.updated ? new Date(R.data.updated) : null;
    var when = at ? (App.sameDay(at, App.now()) ? App.fmt.time(at, true) : App.fmt.monthShort(at) + ' ' + at.getDate()) : '';
    return (R.error ? (R.data ? 'Offline · last copy ' + when : 'Couldn\u2019t load recipes') : 'From the vault · ' + when);
  }
  function syncLine() {
    var s = V.el && V.el.querySelector('[data-synced]');
    if (s) s.textContent = syncText();
    var b = V.el && V.el.querySelector('[data-refresh]');
    if (b) b.classList.toggle('is-busy', R.busy);
  }
  function row(r) {
    return '<button class="rc-row' + (r.id === V.sel ? ' is-sel' : '') + '" data-id="' + esc(r.id) + '">' +
      '<b>' + esc(r.title) + '</b>' + (r.summary ? '<span class="rc-sum">' + esc(r.summary.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')) + '</span>' : '') +
      (r.updated ? '<span class="rc-when">' + esc(dateLabel(r.updated)) + '</span>' : '') + '</button>';
  }
  function list() {
    var l = filtered();
    if (l.length) return l.map(row).join('');
    if (recipes().length) return '<p class="rc-empty">No recipe matches \u201c' + esc(V.q) + '\u201d.</p>';
    return '<p class="rc-empty">' + (R.on && !R.data ? (R.error ? esc(R.error) : 'Loading…') : 'No recipes in the vault yet.') + '</p>';
  }
  function detail() {
    var r = find(V.sel);
    if (!r) return '<p class="rc-empty rc-pick">Pick a recipe.</p>';
    return '<header class="rc-dhead"><button class="icon-btn rc-back" data-back aria-label="Back">' + App.icon('left', 26) + '</button>' +
      '<div><h1 class="serif">' + esc(r.title) + '</h1>' + (r.summary ? '<p class="rc-dsum">' + inline(r.summary) + '</p>' : '') +
      (r.updated ? '<span class="label">Updated ' + esc(dateLabel(r.updated)) + '</span>' : '') + '</div></header>' +
      '<div class="rc-doc">' + sections(r.body) + '</div>';
  }
  // Ticked ingredients and the current step, per recipe, until the page reloads.
  function restoreMarks() {
    var doc = V.el.querySelector('.rc-doc');
    if (!doc) return;
    var done = V.done[V.sel] || {}, step = V.step[V.sel];
    App.$$('.rc-sec:not(.rc-sec--facts):not(.rc-hist) ul > li', V.el).forEach(function (li, i) { li.dataset.i = i; li.classList.toggle('is-done', !!done[i]); });
    App.$$('.rc-doc ol > li', V.el).forEach(function (li, i) { li.dataset.s = i; li.classList.toggle('is-step', step === i); });
  }
  function renderDetail() {
    var pane = V.el.querySelector('.rc-detail');
    pane.innerHTML = detail();
    pane.scrollTop = 0;
    if (App.phone) V.el.scrollTop = 0;
    restoreMarks();
  }
  function render() {
    if (!V.el) return;
    if (V.sel && !find(V.sel)) { V.sel = null; V.detail = false; }
    if (!V.sel && !App.portrait && recipes().length) V.sel = recipes()[0].id;
    var focused = document.activeElement && document.activeElement.matches && document.activeElement.matches('.rc-search input');
    V.el.innerHTML = '<div class="recipes' + (V.detail ? ' is-detail' : '') + '">' +
      '<header class="rc-top"><div><div class="label">' + recipes().length + (recipes().length === 1 ? ' recipe' : ' recipes') + ' · Obsidian</div><h1 class="serif">Recipes</h1></div>' +
      '<div class="rc-sync"><span class="label" data-synced></span>' +
      '<button class="icon-btn" data-refresh aria-label="Refresh">' + App.icon('undo', 26) + '</button></div></header>' +
      '<div class="rc-body"><div class="rc-side"><label class="rc-search">' +
      '<input type="search" placeholder="Search recipes or ingredients" value="' + esc(V.q) + '" autocomplete="off" enterkeyhint="search"></label>' +
      '<div class="rc-list">' + list() + '</div></div><article class="rc-detail"></article></div></div>';
    syncLine();
    renderDetail();
    if (focused) { var inp = V.el.querySelector('.rc-search input'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }

  function open(id) {
    V.sel = id; V.detail = true;
    App.$$('.rc-row', V.el).forEach(function (r) { r.classList.toggle('is-sel', r.dataset.id === id); });
    V.el.querySelector('.recipes').classList.add('is-detail');
    renderDetail();
    wake(true);
  }
  function back() {
    V.detail = false;
    V.el.querySelector('.recipes').classList.remove('is-detail');
    wake(false);
  }

  // Keep the screen on while a recipe is open on a phone or iPad.
  var lock = null;
  function wake(on) {
    if (!on) { if (lock) { lock.release().catch(function () {}); lock = null; } return; }
    if (lock || !navigator.wakeLock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (l) {
      lock = l;
      l.addEventListener('release', function () { if (lock === l) lock = null; });
    }).catch(function () { /* not allowed here; fine */ });
  }
  function wanted() { return App.current === 'recipes' && (V.detail || !App.portrait) && !!V.sel; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && wanted()) wake(true); });

  function click(e) {
    var t = e.target;
    var link = t.closest('[data-open]');
    if (link) { if (V.q && !filtered().some(function (r) { return r.id === link.dataset.open; })) { V.q = ''; render(); } return open(link.dataset.open); }
    var rw = t.closest('.rc-row');
    if (rw) return open(rw.dataset.id);
    if (t.closest('[data-back]')) return back();
    if (t.closest('a')) return;
    var li = t.closest('.rc-doc li');
    if (li && li.dataset.i != null) {
      var d = V.done[V.sel] = V.done[V.sel] || {};
      d[li.dataset.i] = !d[li.dataset.i];
      li.classList.toggle('is-done', d[li.dataset.i]);
      return;
    }
    if (li && li.dataset.s != null) {
      var s = +li.dataset.s;
      V.step[V.sel] = V.step[V.sel] === s ? null : s;
      restoreMarks();
      return;
    }
    if (t.closest('[data-refresh]')) refresh(true);
  }
  function input(e) {
    if (!e.target.matches('.rc-search input')) return;
    V.q = e.target.value;
    V.el.querySelector('.rc-list').innerHTML = list();
  }

  // ---------------------------------------------------------------- demo (no Worker configured)
  function demo() {
    return { updated: new Date().toISOString(), recipes: [
      { id: 'Toum', title: 'Toum', summary: 'Lebanese garlic sauce; fiercely garlicky fresh, mellow after a few hours.', updated: '2026-11-08',
        body: '## Key facts\n- Makes about 2 cups\n\n## Recipe\n\n### Ingredients\n- 50 g peeled garlic\n- 5 g salt\n- 60 mL lemon juice\n- 360 mL neutral oil\n\n### Method\n1. Blitz the garlic and salt to a paste.\n2. With the motor running, add the oil in a thin stream, alternating with the lemon juice.\n3. Rest in the fridge for a few hours.' },
      { id: 'Very Spicy Chicken Fried Rice', title: 'Very Spicy Chicken Fried Rice', summary: 'Heat layered four ways. Goes with [[Toum]] if you\u2019re brave.', updated: '2026-10-18',
        body: '## Recipe\n\n### The rice\n- 900 g cooked jasmine rice, cold\n\n### Method\n1. Fry the chicken.\n2. Fry the rice hard.\n3. Toss it all together.' }
    ] };
  }

  var c = read();
  if (c) { R.data = c.data; R.updated = c.at; }
  if (!R.on) R.data = demo();

  App.register('recipes', {
    stay: true, // the frame layout (an iPad browser) doesn't idle back to Today mid-recipe
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.addEventListener('click', click);
        el.addEventListener('input', input);
      }
      render();
      if (App.current === 'recipes' && wanted()) wake(true);
      if (R.on && !R.busy && (!R.updated || Date.now() - R.updated > 60e3)) refresh();
    },
    resume: function () { if (wanted()) wake(true); if (R.on && !R.busy && Date.now() - (R.updated || 0) > 5 * 60e3) refresh(); },
    hide: function () { wake(false); }
  });
  App.on('orient', function () { if (V.el && V.el.firstChild && App.onScreen('recipes')) render(); });
})();
