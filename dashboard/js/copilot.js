// GitHub Copilot sessions and usage for the Agents tab (views/agents.js), from the Worker's GET /copilot
// (COPILOT.md): the Mac pushes its Copilot CLI sessions, the account's other sessions and the plan
// quota; the Home Assistant Copilot Agent pushes its own sessions (tagged as automations).
//   App.copilot.data              {usage, sources, sessions} (sessions newest first)
//   App.copilot.transcript(id)    Promise → {items} for one session
//   App.copilot.byDay(days)       [{day: Date, development, automation}] AI credits per local day
// Emits 'copilot' when the list changes.
(function () {
  'use strict';
  var API = import.meta.env.VITE_FRAME_API, KEY = import.meta.env.VITE_FRAME_KEY;
  var CACHE = 'copilot-v1', H = 3600e3;
  var C = App.copilot = { on: !!(API && KEY), demo: !(API && KEY), data: null, error: null, updated: null };
  var transcripts = {};

  function read() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } }

  C.refresh = function () {
    if (!C.on) return Promise.resolve();
    return fetch(API + '/copilot', { headers: { 'X-Frame-Key': KEY }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var before = JSON.stringify(C.data);
        C.data = j; C.error = null; C.updated = Date.now();
        write({ at: C.updated, data: j });
        if (JSON.stringify(j) !== before) App.emit('copilot');
      }).catch(function (e) { C.error = e.message; console.warn('Copilot sync failed', e); });
  };

  // Transcripts are kept per session until the session changes (active ones are refetched).
  C.transcript = function (id) {
    var s = (C.data && C.data.sessions || []).filter(function (x) { return x.id === id; })[0];
    var v = s ? s.updatedAt : '';
    var hit = transcripts[id];
    if (hit && hit.v === v) return hit.p;
    var p = C.demo ? Promise.resolve(demoTranscript(s))
      : fetch(API + '/copilot/session?id=' + encodeURIComponent(id), { headers: { 'X-Frame-Key': KEY } })
        .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? 'No conversation stored for this session yet' : 'HTTP ' + r.status); return r.json(); });
    p.catch(function () { if (transcripts[id] && transcripts[id].p === p) delete transcripts[id]; });
    transcripts[id] = { v: v, p: p };
    return p;
  };

  function dayKey(d) { d = new Date(d); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); }
  C.byDay = function (days) {
    var t0 = App.dayStart(App.now()), out = [], ix = {};
    for (var i = days - 1; i >= 0; i--) {
      var d = App.addDays(t0, -i), row = { day: d, development: 0, automation: 0 };
      ix[dayKey(d)] = row; out.push(row);
    }
    ((C.data && C.data.sessions) || []).forEach(function (s) {
      Object.keys(s.hours || {}).forEach(function (h) {
        var row = ix[dayKey(+h * H)];
        if (row) row[s.kind === 'automation' ? 'automation' : 'development'] += s.hours[h];
      });
    });
    return out;
  };
  C.creditsSince = function (since) {
    var from = Math.floor(+since / H), sum = 0;
    ((C.data && C.data.sessions) || []).forEach(function (s) {
      Object.keys(s.hours || {}).forEach(function (h) { if (+h >= from) sum += s.hours[h]; });
    });
    return sum;
  };

  var c = read();
  if (c) { C.data = c.data; C.updated = c.at; }

  // ---------------------------------------------------------------- demo (no Worker configured)
  function demo() {
    var now = +App.now(), hr = Math.floor(now / H);
    var rows = [
      ['d1', 'mac', 'Add Copilot sessions to the frame', 0.3, 4, 412, 'active'],
      ['a1', 'ha', 'Maya walk planner', 2, 1, 18, 'completed'],
      ['d2', 'mac', 'Fix the walk log sync', 20, 3, 236, 'idle'],
      ['a2', 'ha', 'Maya food advisor', 26, 1, 22, 'completed'],
      ['c1', 'cloud', 'Gmail and Notion MCP setup', 70, 2, 151, 'completed'],
      ['a3', 'ha', 'Maya walk planner', 50, 1, 17, 'completed'],
      ['d3', 'mac', 'Photo frame portrait layout', 96, 2, 318, 'idle'],
      ['a4', 'ha', 'Maya food advisor', 122, 1, 21, 'completed']
    ];
    return {
      usage: { plan: 'enterprise', at: new Date(now).toISOString(), resetAt: new Date(App.addDays(App.dayStart(App.now()), 18)).toISOString(), used: 8783, entitlement: 1e7, percentRemaining: 99.9 },
      sources: { mac: new Date(now - 4 * 60e3).toISOString(), ha: new Date(now - 30 * 60e3).toISOString() },
      sessions: rows.map(function (r) {
        var at = now - r[3] * H, hours = {};
        hours[hr - Math.round(r[3])] = r[5];
        return { id: r[0], origin: r[1], kind: r[1] === 'ha' ? 'automation' : 'development', title: r[2], preview: r[2], cwd: r[1] === 'ha' ? '' : '~/code/photo-frame-dashboard',
          model: 'claude-opus-5.5', status: r[6], startedAt: new Date(at - 40 * 60e3).toISOString(), updatedAt: new Date(at).toISOString(),
          prompts: r[4], replies: r[4] * 3, tools: r[4] * 9, errors: 0, credits: r[5], tokens: r[5] * 9000, hours: hours, transcript: r[1] !== 'cloud' };
      })
    };
  }
  function demoTranscript(s) {
    var at = s ? s.startedAt : new Date().toISOString();
    return { v: 1, id: s && s.id, items: [
      { k: 'u', at: at, text: s && s.kind === 'automation' ? 'Plan today\u2019s walks for Maya around everyone\u2019s calendars.' : 'Can you add the session details to the agents view in the photo frame?' },
      { k: 'a', at: at, text: 'I\u2019ll look at how the **Agents** tab gets its data first.' },
      { k: 't', at: at, tool: 'view', label: 'View agents.js', detail: 'js/views/agents.js', ok: true },
      { k: 't', at: at, tool: 'bash', label: 'Run the tests', detail: 'npm test', ok: true, out: '5 passing' },
      { k: 'a', at: at, text: 'Done. The tab now lists every session:\n\n- tap one to read the chat\n- filter by `Development` or `Automations`' }
    ] };
  }

  if (C.demo) { C.data = demo(); return; }
  App.on('ready', function () {
    C.refresh();
    setInterval(C.refresh, 5 * 60000);
    window.addEventListener('online', C.refresh);
  });
})();
