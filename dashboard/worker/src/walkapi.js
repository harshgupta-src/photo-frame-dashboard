// Walk log HTTP API and a small MCP endpoint for agents. The data lives in the WalkLog Durable
// Object (walklog.js); docs in ../../WALKS.md.
//   GET    /walk            the frame's state: active walk + the last 14 days
//   GET    /walks?days=30   walks, newest first (days 1-3650, limit up to 5000)
//   GET    /walks/summary   last walk, last pee/poop, today and the last 7 days
//   GET    /walks/log.md    the markdown log Home Assistant copies into the vault
//   PUT    /walks/:id       create or replace a walk {startedAt, endedAt?, pee?, poop?, walkers?, notes?}
//   DELETE /walks/:id       delete a walk (and its calendar event)
//   POST   /walks/start     server-timed start {by?}      (iPhone Shortcut)
//   POST   /walks/stop      server-timed stop {pee?, poop?, by?}
//   POST   /walks/resync    retry calendar writes that gave up
//   POST   /mcp             MCP (Streamable HTTP, stateless): walk_summary, list_walks, walk_log
// Keys: reads take READ_KEY (X-Frame-Key), WALK_KEY or AGENT_KEY; writes take READ_KEY or WALK_KEY,
// in a header only. AGENT_KEY is read-only. WALK_KEY and AGENT_KEY are Worker secrets if set, else
// derived from PUSH_TOKEN (HMAC-SHA256), so they need no setup; scripts/walk-keys.mjs prints them.
const enc = new TextEncoder();
const derived = new Map();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function walkKey(env, name) {
  if (env[name]) return env[name];
  if (!env.PUSH_TOKEN) return '';
  const id = name + '\n' + env.PUSH_TOKEN;
  if (!derived.has(id)) {
    const k = await crypto.subtle.importKey('raw', enc.encode(env.PUSH_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    derived.set(id, b64url(await crypto.subtle.sign('HMAC', k, enc.encode('frame-data/' + name + '/v1'))));
  }
  return derived.get(id);
}

export async function walkAccess(req, url, env, same) {
  const headers = [
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''),
    req.headers.get('X-Frame-Key'), req.headers.get('X-Walk-Key'), req.headers.get('X-Agent-Key'),
  ].filter(Boolean);
  const query = req.method === 'GET' ? url.searchParams.get('key') : null;
  const [walk, agent] = await Promise.all([walkKey(env, 'WALK_KEY'), walkKey(env, 'AGENT_KEY')]);
  const has = (list, secret) => list.some((t) => same(t, secret));
  const write = has(headers, env.READ_KEY) || has(headers, walk);
  return { write, read: write || has(headers, agent) || (!!query && has([query], agent)) };
}

const stub = (env) => env.WALKS.get(env.WALKS.idFromName('household'));
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

async function body(req) {
  const t = await req.text();
  if (!t.trim()) return {};
  try { return JSON.parse(t); } catch { return null; }
}

// → { status, body } or a Response (markdown), or null when the path isn't a walk route.
export async function walkRoute(req, url, env, access) {
  const p = url.pathname, m = req.method, s = stub(env);
  const need = (what) => (access[what] ? null : { status: 401, body: { error: 'unauthorized' } });
  if (p === '/walk' && m === 'GET') return need('read') || s.run('state');
  if (p === '/walks' && m === 'GET') {
    return need('read') || s.run('list', clampInt(url.searchParams.get('days'), 30, 1, 3650), clampInt(url.searchParams.get('limit'), 1000, 1, 5000));
  }
  if (p === '/walks/summary' && m === 'GET') return need('read') || s.run('summary');
  if (p === '/walks/log.md' && m === 'GET') {
    const denied = need('read');
    if (denied) return denied;
    const r = await s.run('log');
    if (r.status !== 200) return r;
    return new Response(r.body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const op = { '/walks/start': 'start', '/walks/stop': 'stop', '/walks/resync': 'resync' }[p];
  if (op && m === 'POST') {
    const denied = need('write');
    if (denied) return denied;
    const b = await body(req);
    return b ? s.run(op, b) : { status: 400, body: { error: 'body must be JSON' } };
  }
  const one = /^\/walks\/([A-Za-z0-9_-]{6,64})$/.exec(p);
  if (one && (m === 'PUT' || m === 'DELETE')) {
    const denied = need('write');
    if (denied) return denied;
    if (m === 'DELETE') return s.run('remove', one[1]);
    const b = await body(req);
    return b ? s.run('upsert', one[1], b) : { status: 400, body: { error: 'body must be JSON' } };
  }
  if (p === '/walk' || p.startsWith('/walks')) return { status: 404, body: { error: 'not found' } };
  return null;
}

// ---------------------------------------------------------------------------- MCP for agents
const TOOLS = [
  {
    name: 'walk_summary',
    description: 'The dog\'s walk status: active walk (if out now), last walk, time since last walk/pee/poop, today\'s and the last 7 days\' counts. Times are ISO 8601 UTC; localDate and tz give the home time zone.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_walks',
    description: 'Logged dog walks, newest first: start/end, duration, pee, poop, who walked her, notes.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 3650, description: 'How many days back (default 7)' } }, additionalProperties: false },
  },
  {
    name: 'walk_log',
    description: 'The full walk log as markdown (same as the vault note): summary, the last 30 days by day, monthly totals.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export async function mcp(req, env, access) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'POST only (stateless Streamable HTTP)' } };
  if (!access.read) return { status: 401, body: { error: 'unauthorized' } };
  const msg = await body(req);
  if (!msg || Array.isArray(msg)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'one JSON-RPC message per request' } } };
  if (msg.id === undefined) return { status: 202, body: null }; // notification
  const ok = (result) => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id, result } });
  const fail = (code, message) => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id, error: { code, message } } });
  if (msg.method === 'initialize') {
    return ok({
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'frame-walks', version: '1.0.0' },
      instructions: 'Read-only dog walk log from the family photo frame. Use walk_summary for "when did she last go out/pee/poop", list_walks for history.',
    });
  }
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name, args = (msg.params && msg.params.arguments) || {}, s = stub(env);
    let r;
    if (name === 'walk_summary') r = await s.run('summary');
    else if (name === 'list_walks') r = await s.run('list', clampInt(args.days, 7, 1, 3650), 2000);
    else if (name === 'walk_log') r = await s.run('log');
    else return fail(-32602, 'unknown tool ' + name);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 1);
    return ok({ content: [{ type: 'text', text }], isError: r.status !== 200 });
  }
  return fail(-32601, 'method not found');
}
