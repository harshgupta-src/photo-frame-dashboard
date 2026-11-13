// Agents: Harsh's GitHub Copilot sessions and usage (data: js/copilot.js). Sessions from the Home
// Assistant Copilot Agent are automations; the rest is Harsh's development work. Tap a session to read
// the conversation: what Harsh asked, Copilot's replies and the actions it took.
(function () {
  'use strict';
  var C = App.copilot, esc = App.esc;
  var PAGE = 120;
  var V = { el: null, filter: 'all', sel: null, detail: false, shown: PAGE, chatFor: null };
  var KINDS = { development: 'Development', automation: 'Automation' };

  function sessions() { return (C.data && C.data.sessions) || []; }
  function filtered() { return sessions().filter(function (s) { return V.filter === 'all' || s.kind === V.filter; }); }
  function find(id) { return sessions().filter(function (s) { return s.id === id; })[0]; }

  function credits(n) {
    n = n || 0;
    return n < 10 ? (Math.round(n * 10) / 10).toString() : Math.round(n).toLocaleString('en-US');
  }
  function big(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : credits(n); }
  function ago(iso) {
    if (!iso) return '';
    var m = Math.round((+App.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var d = new Date(iso);
    if (App.sameDay(d, App.now())) return App.fmt.time(d, true);
    var days = Math.round((+App.dayStart(App.now()) - +App.dayStart(d)) / 864e5);
    return days === 1 ? 'Yesterday' : days < 7 ? App.fmt.day(d) : App.fmt.monthShort(d) + ' ' + d.getDate();
  }
  function live(s) { return s.status === 'active' || s.status === 'in_progress' || s.status === 'running' || s.status === 'queued'; }
  function tag(s) { return '<span class="cp-tag cp-tag--' + s.kind + '">' + (KINDS[s.kind] || s.kind) + '</span>'; }
  function where(s) {
    return s.origin === 'ha' ? 'Home Assistant' : s.origin === 'cloud' ? 'Elsewhere' : (s.cwd || '').replace(/^\/Users\/[^/]+/, '~') || 'Mac';
  }

  // ---------------------------------------------------------------- usage
  function plan() {
    var u = C.data && C.data.usage;
    if (!u) return '<section class="ag-card cp-plan"><div class="label">Plan</div><p class="cp-muted">Waiting for the Mac to send the plan quota.</p></section>';
    var reset = u.resetAt ? new Date(u.resetAt) : null;
    var start = reset ? new Date(reset.getFullYear(), reset.getMonth() - 1, reset.getDate(), reset.getHours(), reset.getMinutes()) : null;
    var pct = u.entitlement ? Math.min(100, u.used / u.entitlement * 100) : 0;
    var pace = start ? Math.max(0, Math.min(100, (+App.now() - +start) / (+reset - +start) * 100)) : null;
    var daysLeft = reset ? Math.max(0, Math.ceil((+reset - +App.now()) / 864e5)) : null;
    var pctText = pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : Math.round(pct);
    return '<section class="ag-card cp-plan">' +
      '<div class="ag-meter-top"><span class="ag-label">' + esc((u.plan || 'Copilot') + ' plan') + ' · AI credits</span><span class="ag-pct num">' + pctText + '<small>%</small></span></div>' +
      '<div class="ag-bar"><i style="width:' + Math.max(pct, 0.6) + '%"></i>' + (pace != null ? '<em style="left:' + pace + '%" title="Even pace"></em>' : '') + '</div>' +
      '<div class="ag-meter-foot"><span><b class="num">' + big(u.used) + '</b> of ' + (u.unlimited ? 'unlimited' : big(u.entitlement)) + ' used</span>' +
      (reset ? '<span>Resets ' + App.fmt.monthShort(new Date(reset.getUTCFullYear(), reset.getUTCMonth(), 1)) + ' ' + reset.getUTCDate() + ' · ' + daysLeft + 'd</span>' : '') + '</div>' +
      '</section>';
  }

  function today() {
    var t0 = App.dayStart(App.now()), list = sessions();
    var todays = list.filter(function (s) { return s.updatedAt && new Date(s.updatedAt) >= t0; });
    var auto = todays.filter(function (s) { return s.kind === 'automation'; }).length;
    var month = new Date(t0.getFullYear(), t0.getMonth(), 1);
    return '<section class="ag-card cp-today">' +
      '<div class="cp-stat"><span class="num">' + credits(C.creditsSince(t0)) + '</span><small>credits today</small></div>' +
      '<div class="cp-stat"><span class="num">' + todays.length + '</span><small>sessions today' + (auto ? ' · ' + auto + ' auto' : '') + '</small></div>' +
      '<div class="cp-stat"><span class="num">' + big(C.creditsSince(month)) + '</span><small>credits this month</small></div>' +
      '<div class="cp-stat"><span class="num">' + list.filter(live).length + '</span><small>running now</small></div>' +
      '</section>';
  }

  function week() {
    var rows = C.byDay(7);
    var max = Math.max.apply(null, rows.map(function (r) { return r.development + r.automation; }).concat([1]));
    return '<section class="ag-card cp-week">' +
      '<div class="cp-week-head"><span class="ag-label">Last 7 days</span><div class="ag-legend"><span class="cp-dev"><i></i>Development</span><span class="cp-auto"><i></i>Automations</span></div></div>' +
      '<div class="ag-chart">' + rows.map(function (r, i) {
        var tot = r.development + r.automation;
        return '<div class="ag-col' + (i === 6 ? ' is-today' : '') + '"><b class="num">' + (tot ? credits(tot) : '') + '</b><div class="ag-stack" style="height:' + (tot / max * 100) + '%">' +
          '<i class="cp-auto" style="flex-grow:' + r.automation + '"></i><i class="cp-dev" style="flex-grow:' + r.development + '"></i></div>' +
          '<span>' + (i === 6 ? 'Today' : App.fmt.dayShort(r.day)) + '</span></div>';
      }).join('') + '</div></section>';
  }

  // ---------------------------------------------------------------- list
  function seg() {
    var all = sessions(), n = function (k) { return all.filter(function (s) { return s.kind === k; }).length; };
    return '<div class="seg cp-seg">' + [['all', 'All', all.length], ['development', 'Development', n('development')], ['automation', 'Automations', n('automation')]].map(function (f) {
      return '<button data-filter="' + f[0] + '"' + (V.filter === f[0] ? ' class="is-on"' : '') + '>' + f[1] + '<span class="num">' + f[2] + '</span></button>';
    }).join('') + '</div>';
  }
  function row(s) {
    return '<button class="cp-row' + (s.id === V.sel ? ' is-sel' : '') + '" data-id="' + esc(s.id) + '">' +
      '<div class="cp-row-top">' + (live(s) ? '<i class="cp-live" title="Running"></i>' : '') + '<b>' + esc(s.title) + '</b><span class="cp-when">' + esc(ago(s.updatedAt)) + '</span></div>' +
      '<div class="cp-row-meta">' + tag(s) + '<span>' + esc(where(s)) + '</span>' + (s.credits ? '<span class="num">' + credits(s.credits) + ' cr</span>' : '') + '</div>' +
      '</button>';
  }
  function list() {
    var l = filtered();
    return l.length ? l.map(row).join('') : '<p class="cp-empty">' + (sessions().length ? 'No sessions of this type.' : C.on && !C.data ? 'Loading…' : 'No Copilot sessions yet.') + '</p>';
  }

  // ---------------------------------------------------------------- conversation
  // Small markdown: code blocks, inline code, bold, headings and bullet lists. Input is escaped first.
  function md(src) {
    var parts = String(src).split(/```[^\n]*\n?/), out = '';
    parts.forEach(function (p, i) {
      if (i % 2) { out += '<pre>' + esc(p.replace(/\n$/, '')) + '</pre>'; return; }
      var html = '', inList = false;
      p.split('\n').forEach(function (line) {
        var m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
        if (m) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(m[1]) + '</li>'; return; }
        if (inList) { html += '</ul>'; inList = false; }
        var h = /^#{1,6}\s+(.*)$/.exec(line);
        if (h) html += '<p><b>' + inline(h[1]) + '</b></p>';
        else if (line.trim()) html += '<p>' + inline(line) + '</p>';
      });
      out += html + (inList ? '</ul>' : '');
    });
    return out;
  }
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');
  }
  function stamp(at) { return at ? '<time>' + App.fmt.time(new Date(at), true) + '</time>' : ''; }

  // Consecutive tool calls fold into one "N actions" group.
  function blocks(items) {
    var out = [];
    items.forEach(function (it) {
      var last = out[out.length - 1];
      if (it.k === 't' && last && last.k === 'tools') last.items.push(it);
      else out.push(it.k === 't' ? { k: 'tools', items: [it] } : it);
    });
    return out;
  }
  function tools(g) {
    var bad = g.items.filter(function (t) { return t.ok === false; }).length;
    var names = g.items.slice(0, 3).map(function (t) { return esc(t.label); }).join(' · ') + (g.items.length > 3 ? ' …' : '');
    return '<details class="cp-tools' + (bad ? ' has-bad' : '') + '"><summary><b>' + g.items.length + (g.items.length === 1 ? ' action' : ' actions') + '</b>' +
      (bad ? '<em>' + bad + ' failed</em>' : '') + '<span>' + names + '</span></summary><ol>' +
      g.items.map(function (t) {
        return '<li class="' + (t.ok === false ? 'is-bad' : '') + '"><i>' + (t.ok === false ? '✕' : t.ok ? '✓' : '·') + '</i><div><b>' + esc(t.label) + '</b>' +
          (t.detail ? '<code>' + esc(t.detail) + '</code>' : '') + (t.out && t.ok === false ? '<pre>' + esc(t.out) + '</pre>' : '') + '</div></li>';
      }).join('') + '</ol></details>';
  }
  function block(b) {
    if (b.k === 'tools') return tools(b);
    if (b.k === 'u') return '<div class="cp-msg cp-msg--me">' + (b.q ? '<div class="cp-q">' + esc(b.q) + '</div>' : '') + '<div class="cp-bubble">' + esc(b.text).replace(/\n/g, '<br>') + '</div>' + stamp(b.at) + '</div>';
    if (b.k === 'a') return '<div class="cp-msg cp-msg--ai"><div class="cp-md">' + md(b.text) + '</div></div>';
    if (b.k === 'e') return '<div class="cp-err">' + App.icon('bolt', 16) + esc(b.text) + '</div>';
    return '';
  }

  function detailHead(s) {
    var started = s.startedAt ? new Date(s.startedAt) : null;
    var bits = [where(s), s.model, started ? App.fmt.rel(started) + ' ' + App.fmt.time(started, true) : '',
      s.prompts ? s.prompts + (s.prompts === 1 ? ' prompt' : ' prompts') : '', s.tools ? s.tools + ' actions' : '', s.credits ? credits(s.credits) + ' credits' : ''].filter(Boolean);
    return '<header class="cp-dhead"><button class="icon-btn cp-back" data-back aria-label="Back">' + App.icon('left', 26) + '</button>' +
      '<div><div class="cp-dtitle">' + (live(s) ? '<i class="cp-live"></i>' : '') + '<b>' + esc(s.title) + '</b></div>' +
      '<div class="cp-row-meta">' + tag(s) + bits.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '</div></div></header>';
  }

  function renderDetail() {
    var pane = V.el.querySelector('.cp-detail');
    if (!pane) return;
    var s = find(V.sel);
    if (!s) { pane.innerHTML = '<p class="cp-empty">Pick a session to read the conversation.</p>'; V.chatFor = null; return; }
    var key = s.id + '|' + s.updatedAt;
    if (V.chatFor === key && pane.querySelector('.cp-chat')) return;
    var chat = pane.querySelector('.cp-chat'), keep = V.chatFor && V.chatFor.split('|')[0] === s.id && chat ? chat.scrollTop : 0;
    V.chatFor = key;
    pane.innerHTML = detailHead(s) + '<div class="cp-chat"><p class="cp-empty">Loading…</p></div>';
    chat = pane.querySelector('.cp-chat');
    chat.addEventListener('scroll', App.resetIdle, { passive: true });
    if (!s.transcript) {
      chat.innerHTML = '<div class="cp-note">' + (s.preview ? '<div class="cp-msg cp-msg--me"><div class="cp-bubble">' + esc(s.preview) + '</div></div>' : '') +
        '<p>This session ran outside this Mac and Home Assistant. GitHub doesn\u2019t share its conversation, so only its summary is shown.</p></div>';
      return;
    }
    C.transcript(s.id).then(function (t) {
      if (V.chatFor !== key) return;
      var all = blocks(t.items || []), shown = all.slice(0, V.shown);
      chat.innerHTML = (shown.length ? shown.map(block).join('') : '<p class="cp-empty">No messages yet.</p>') +
        (all.length > shown.length ? '<button class="btn cp-more" data-more>Show more · ' + (all.length - shown.length) + ' left</button>' : '');
      chat.scrollTop = keep;
    }, function (e) {
      if (V.chatFor === key) chat.innerHTML = '<p class="cp-empty">' + esc(e.message) + '</p>';
    });
  }

  // ---------------------------------------------------------------- page
  function synced() {
    var src = (C.data && C.data.sources) || {}, at = C.demo ? null : C.updated;
    var mac = src.mac ? 'Mac ' + ago(src.mac) : 'Mac not synced', ha = src.ha ? 'HA ' + ago(src.ha) : 'HA not synced';
    return C.demo ? 'Demo data' : (C.error && !at ? 'Offline' : mac + ' · ' + ha);
  }

  function render() {
    var l = filtered();
    if (V.sel && !find(V.sel)) V.sel = null;
    if (!V.sel && !App.portrait && l.length) V.sel = l[0].id;
    V.chatFor = null;
    V.el.innerHTML = '<div class="agents">' +
      '<header class="ag-top"><div><div class="label">GitHub Copilot · sessions &amp; usage</div><h1 class="serif">Agents</h1></div>' +
      '<div class="ag-sync"><span class="label" data-synced>' + esc(synced()) + '</span>' +
      '<button class="icon-btn" data-refresh aria-label="Refresh">' + App.icon('undo', 26) + '</button></div></header>' +
      '<div class="cp-usage">' + plan() + today() + week() + '</div>' +
      '<div class="cp-body' + (V.detail ? ' is-detail' : '') + '"><div class="cp-side">' + seg() + '<div class="cp-list">' + list() + '</div></div>' +
      '<div class="cp-detail"></div></div></div>';
    V.el.querySelector('.cp-list').addEventListener('scroll', App.resetIdle, { passive: true });
    renderDetail();
  }

  function refreshList() {
    if (!V.el || !V.el.firstChild) return;
    var lst = V.el.querySelector('.cp-list'), top = lst.scrollTop;
    var usage = V.el.querySelector('.cp-usage');
    usage.innerHTML = plan() + today() + week();
    V.el.querySelector('.cp-seg').outerHTML = seg();
    lst.innerHTML = list();
    lst.scrollTop = top;
    V.el.querySelector('[data-synced]').textContent = synced();
    renderDetail();
  }

  function select(id) {
    V.sel = id; V.shown = PAGE; V.detail = true;
    App.$$('.cp-row', V.el).forEach(function (r) { r.classList.toggle('is-sel', r.dataset.id === id); });
    V.el.querySelector('.cp-body').classList.add('is-detail');
    renderDetail();
  }

  function click(e) {
    var t = e.target;
    var row = t.closest('.cp-row');
    if (row) return select(row.dataset.id);
    var f = t.closest('[data-filter]');
    if (f) {
      V.filter = f.dataset.filter;
      var l = filtered();
      if (!App.portrait && !l.some(function (s) { return s.id === V.sel; })) V.sel = l.length ? l[0].id : null;
      return refreshList();
    }
    if (t.closest('[data-back]')) { V.detail = false; V.el.querySelector('.cp-body').classList.remove('is-detail'); return; }
    if (t.closest('[data-more]')) {
      var chat = V.el.querySelector('.cp-chat'), top = chat.scrollTop;
      V.shown += PAGE; V.chatFor = null; renderDetail();
      V.el.querySelector('.cp-chat').scrollTop = top;
      return;
    }
    if (t.closest('[data-refresh]')) {
      var b = t.closest('[data-refresh]');
      b.classList.add('is-busy');
      C.refresh().then(function () { b.classList.remove('is-busy'); refreshList(); });
    }
  }

  App.register('agents', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', click); }
      render();
      if (C.on && (!C.updated || Date.now() - C.updated > 60e3)) C.refresh();
    }
  });
  App.on('copilot', function () { if (App.current === 'agents') refreshList(); });
  App.on('minute', function () { if (App.current === 'agents') refreshList(); });
  App.on('orient', function () { if (V.el && V.el.firstChild) render(); });
})();
