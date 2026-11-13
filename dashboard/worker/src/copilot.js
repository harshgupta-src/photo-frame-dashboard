// Copilot sessions and usage for the frame's Agents tab (../../COPILOT.md). The Worker only stores
// what the pushers send: the Mac (worker/scripts/copilot-push.mjs: local Copilot CLI sessions, the
// account's cloud session list and the plan quota) and the HA Copilot Agent add-on (its own sessions).
//   POST /copilot/push         {source, sessions: [summary], transcripts?: {id: transcript}, usage?}
//        Authorization: Bearer COPILOT_KEY (a Worker secret if set, else derived from PUSH_TOKEN like
//        WALK_KEY; scripts/walk-keys.mjs writes it). Replaces that source's session list, stores the
//        transcripts sent and keeps the newest usage snapshot.
//   GET  /copilot              READ_KEY  {usage, sources: {mac, ha}, sessions} newest first
//   GET  /copilot/session?id=  READ_KEY  one transcript {v, id, items}
// Sessions from Home Assistant are automations; everything else is Harsh's development work.
// KV: copilot:src:<source>, copilot:t:<session id>, copilot:usage.

export const SOURCES = ['mac', 'ha'];
const ORIGINS = { mac: ['mac', 'cloud'], ha: ['ha'] };
const MAX_SESSIONS = 2000, MAX_TRANSCRIPT = 4 * 1024 * 1024, TRANSCRIPT_TTL = 400 * 86400;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export const kindOf = (origin) => (origin === 'ha' ? 'automation' : 'development');

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
const iso = (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

function cleanHours(x) {
  const hours = {};
  if (x && typeof x === 'object') {
    for (const [h, c] of Object.entries(x)) if (/^\d{6,7}$/.test(h) && num(c)) hours[h] = Math.round(c * 100) / 100;
  }
  return hours;
}

function cleanModels(x) {
  const models = {};
  if (!x || typeof x !== 'object') return models;
  for (const [id, m] of Object.entries(x).slice(0, 20)) {
    if (!m || typeof m !== 'object' || !/^[\w.:/-]{1,60}$/.test(id)) continue;
    models[id] = { name: str(m.name, 60), credits: Math.round(num(m.credits) * 100) / 100, tokens: num(m.tokens), calls: num(m.calls), hours: cleanHours(m.hours) };
  }
  return models;
}

export function cleanSummary(x, source) {
  if (!x || typeof x !== 'object' || !ID.test(x.id || '')) return null;
  const origin = ORIGINS[source].includes(x.origin) ? x.origin : source;
  const hours = cleanHours(x.hours);
  return {
    id: x.id, origin, kind: kindOf(origin),
    title: str(x.title, 160) || 'Untitled session', preview: str(x.preview, 200), cwd: str(x.cwd, 200),
    model: str(x.model, 60), status: str(x.status, 30),
    startedAt: iso(x.startedAt), updatedAt: iso(x.updatedAt) || iso(x.startedAt),
    prompts: num(x.prompts), replies: num(x.replies), tools: num(x.tools), errors: num(x.errors),
    credits: Math.round(num(x.credits) * 100) / 100, tokens: num(x.tokens), hours, models: cleanModels(x.models),
    transcript: x.transcript !== false && origin !== 'cloud',
  };
}

// GitHub's /copilot_internal/user → the plan quota the tab shows.
export function cleanUsage(raw) {
  const q = raw && raw.quota_snapshots && raw.quota_snapshots.premium_interactions;
  if (!q) return null;
  return {
    plan: str(raw.copilot_plan, 40), at: iso(q.timestamp_utc) || new Date().toISOString(),
    resetAt: iso(raw.quota_reset_date_utc) || iso(raw.quota_reset_date),
    used: num(q.credits_used != null ? q.credits_used : q.entitlement - q.remaining),
    entitlement: num(q.entitlement), percentRemaining: num(q.percent_remaining),
    unlimited: !!q.unlimited, overage: num(q.overage_count), overagePermitted: !!q.overage_permitted,
  };
}

async function push(req, env) {
  let body;
  try { body = await req.json(); } catch { return { status: 400, body: { error: 'body must be JSON' } }; }
  const source = body && body.source;
  if (!SOURCES.includes(source)) return { status: 400, body: { error: 'source must be one of ' + SOURCES.join(', ') } };
  if (!Array.isArray(body.sessions) || body.sessions.length > MAX_SESSIONS) return { status: 400, body: { error: 'sessions must be a list of at most ' + MAX_SESSIONS } };
  const sessions = body.sessions.map((x) => cleanSummary(x, source)).filter(Boolean);
  const ids = new Set(sessions.filter((x) => x.transcript).map((x) => x.id));
  const writes = [], stored = [], skipped = [];
  for (const [id, t] of Object.entries(body.transcripts || {})) {
    const json = JSON.stringify({ v: 1, id, source, items: Array.isArray(t && t.items) ? t.items : [] });
    if (!ids.has(id) || json.length > MAX_TRANSCRIPT) { skipped.push(id); continue; }
    writes.push(env.DATA.put('copilot:t:' + id, json, { expirationTtl: TRANSCRIPT_TTL }));
    stored.push(id);
  }
  writes.push(env.DATA.put('copilot:src:' + source, JSON.stringify({ at: new Date().toISOString(), sessions })));
  const usage = cleanUsage(body.usage);
  if (usage) {
    const old = await env.DATA.get('copilot:usage', 'json');
    if (!old || old.at < usage.at) writes.push(env.DATA.put('copilot:usage', JSON.stringify(usage)));
  }
  await Promise.all(writes);
  return { status: 200, body: { ok: true, sessions: sessions.length, transcripts: stored.length, skipped } };
}

async function list(env) {
  const [usage, ...srcs] = await Promise.all([env.DATA.get('copilot:usage', 'json'), ...SOURCES.map((s) => env.DATA.get('copilot:src:' + s, 'json'))]);
  const byId = new Map(), sources = {};
  SOURCES.forEach((s, i) => {
    const d = srcs[i];
    sources[s] = d ? d.at : null;
    for (const x of (d && d.sessions) || []) {
      const had = byId.get(x.id);
      if (!had || (had.origin === 'cloud' && x.origin !== 'cloud')) byId.set(x.id, x);
    }
  });
  const sessions = [...byId.values()].sort((a, b) => ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1));
  return { status: 200, body: { usage: usage || null, sources, sessions } };
}

// access: {read, push} booleans from index.js.
export async function copilotRoute(req, url, env, access) {
  if (url.pathname === '/copilot/push') {
    if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    return access.push ? push(req, env) : { status: 401, body: { error: 'unauthorized' } };
  }
  if (req.method !== 'GET') return { status: 405, body: { error: 'GET only' } };
  if (!access.read) return { status: 401, body: { error: 'unauthorized' } };
  if (url.pathname === '/copilot') return list(env);
  if (url.pathname === '/copilot/session') {
    const id = url.searchParams.get('id') || '';
    if (!ID.test(id)) return { status: 400, body: { error: 'bad id' } };
    const t = await env.DATA.get('copilot:t:' + id, 'json');
    return t ? { status: 200, body: t } : { status: 404, body: { error: 'no transcript for this session' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
