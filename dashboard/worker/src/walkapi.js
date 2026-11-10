// Walk log HTTP API: a thin adapter over the walks in Lifelog (walkstore.js); docs in ../../WALKS.md.
//   GET    /walk            the frame's state: active walk + the last 14 days
//   GET    /walks?days=30   walks, newest first (days 1-3650, limit up to 5000)
//   GET    /walks/summary   last walk, last pee/poop, today and the last 7 days
//   GET    /walks/log.md    the markdown log Home Assistant copies into the vault
//   PUT    /walks/:id       create or replace a walk {startedAt, endedAt?, pee?, poop?, walkers?, notes?}
//   DELETE /walks/:id       delete a walk (and its calendar event)
//   POST   /walks/start     server-timed start {by?}      (iPhone Shortcut)
//   POST   /walks/stop      server-timed stop {pee?, poop?, by?}
//   POST   /walks/resync    retry calendar writes that gave up
// Keys, in a header only: READ_KEY (X-Frame-Key) or WALK_KEY, both read and write. WALK_KEY is a
// Worker secret if set, else derived from PUSH_TOKEN (HMAC-SHA256), so it needs no setup;
// scripts/walk-keys.mjs prints it. Agents read and log walks in Lifelog directly.
import { WalkStore } from './walkstore.js';

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

export async function walkAccess(req, env, same) {
  const headers = [
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''),
    req.headers.get('X-Frame-Key'), req.headers.get('X-Walk-Key'),
  ].filter(Boolean);
  const walk = await walkKey(env, 'WALK_KEY');
  const ok = headers.some((t) => same(t, env.READ_KEY) || same(t, walk));
  return { write: ok, read: ok };
}
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

async function body(req) {
  const t = await req.text();
  if (!t.trim()) return {};
  try { return JSON.parse(t); } catch { return null; }
}

// → { status, body } or a Response (markdown), or null when the path isn't a walk route.
export async function walkRoute(req, url, env, ctx, access) {
  const p = url.pathname, m = req.method, s = new WalkStore(env, ctx);
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
