// Copilot session events (events.jsonl from the Copilot CLI or the Copilot SDK) → a session summary
// and a compact transcript for the frame's Agents tab (COPILOT.md). Used by the Mac pusher
// (worker/scripts/copilot-push.mjs). The HA Copilot Agent add-on has a Python port
// (ha-copilot-agent: src/ha_copilot_agent/sessions.py); keep the two in step.
//
// Only the main conversation is kept: sub-agent events (parentToolCallId) are dropped, the sub-agent
// itself shows up as the tool call that started it. Tool output is clipped and secrets are masked.

// The event types worth parsing; pushers test raw lines against this before JSON.parse.
export const KEEP = /^\{"type":"(session\.start|session\.model_change|user\.message|assistant\.message|tool\.execution_start|tool\.execution_complete|session\.usage_record|human_response\.recorded|session\.error|abort)"/;

const MAX_TEXT = 12000, MAX_OUT = 400, MAX_DETAIL = 240;
const SKIP_TOOLS = new Set(['report_intent']);

const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const ASSIGNED = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi;

export function redact(s) {
  return String(s).replace(TOKENS, '•••').replace(BEARER, '$1•••').replace(ASSIGNED, '$1•••');
}
export function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const text = (s, n) => clip(redact(s), n).trim();

// "Do X. Then Y" → "Do X"; used to title sessions that have no name (the HA add-on's jobs).
export function firstSentence(s, n = 90) {
  const line = String(s || '').trim().split('\n').find((l) => l.trim()) || '';
  const m = /^(.+?[.!?])(\s|$)/.exec(line.trim());
  return clip((m ? m[1] : line).trim(), n);
}

function detail(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args : '';
  for (const k of ['command', 'path', 'pattern', 'query', 'url', 'prompt', 'message', 'skill', 'agent_id', 'shellId']) {
    if (typeof args[k] === 'string' && args[k]) return args[k];
  }
  const s = JSON.stringify(args);
  return s === '{}' ? '' : s;
}

function resultText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) return r.content.map((c) => (typeof c === 'string' ? c : c && c.text) || '').join('\n');
  return '';
}

function answers(response) {
  const c = response && response.content;
  if (c == null) return '';
  if (typeof c !== 'object') return String(c);
  return Object.entries(c).map(([k, v]) => (Object.keys(c).length > 1 ? k + ': ' : '') + (Array.isArray(v) ? v.join(', ') : String(v))).join('\n');
}

// events: parsed event objects in file order. meta: {id, title, updatedAt}.
// Returns {summary, transcript}. Credits are AI credits (copilotUsage.totalNanoAiu / 1e9);
// summary.hours maps a UTC hour (ms since epoch / 3600000) to the credits used in it, and
// summary.models maps each model that served a request to {name, credits, tokens, calls, hours}.
export function compact(events, meta = {}) {
  const s = {
    id: meta.id, title: meta.title || '', preview: '', startedAt: null, updatedAt: null, model: null, cwd: null,
    prompts: 0, replies: 0, tools: 0, errors: 0, credits: 0, tokens: 0, hours: {}, models: {},
  };
  const items = [], open = new Map();
  for (const e of events) {
    const d = (e && e.data) || {}, at = e.timestamp || null;
    if (at && (!s.startedAt || at < s.startedAt)) s.startedAt = at;
    if (at && (!s.updatedAt || at > s.updatedAt)) s.updatedAt = at;
    if (d.parentToolCallId && e.type !== 'session.usage_record') continue;
    switch (e.type) {
      case 'session.start':
        s.model = d.selectedModel || s.model;
        s.cwd = (d.context && d.context.cwd) || s.cwd;
        if (d.startTime && (!s.startedAt || d.startTime < s.startedAt)) s.startedAt = d.startTime;
        break;
      case 'session.model_change':
        if (d.newModel) s.model = d.newModel;
        break;
      case 'user.message': {
        if (d.source || !d.content || !String(d.content).trim()) break;
        const t = text(d.content, MAX_TEXT);
        if (!s.preview) s.preview = clip(t.replace(/\s+/g, ' '), 160);
        s.prompts++;
        items.push({ k: 'u', at, text: t });
        break;
      }
      case 'human_response.recorded': {
        const a = answers(d.response);
        if (!a) break;
        s.prompts++;
        items.push({ k: 'u', at, text: text(a, MAX_TEXT), q: text((d.response && d.response.message) || '', 600) });
        break;
      }
      case 'assistant.message':
        if (!d.content || !String(d.content).trim()) break;
        s.replies++;
        items.push({ k: 'a', at, text: text(d.content, MAX_TEXT) });
        break;
      case 'tool.execution_start': {
        if (SKIP_TOOLS.has(d.toolName)) break;
        const args = d.arguments || {};
        const it = { k: 't', at, tool: String(d.toolName || 'tool'), label: text(args.description || d.toolTitle || d.toolName || 'Tool', 120), detail: text(detail(args), MAX_DETAIL) };
        s.tools++;
        items.push(it);
        if (d.toolCallId) open.set(d.toolCallId, it);
        break;
      }
      case 'tool.execution_complete': {
        const it = open.get(d.toolCallId);
        if (!it) break;
        open.delete(d.toolCallId);
        it.ok = d.success !== false;
        const out = resultText(d.result) || (d.error && (d.error.message || d.error)) || '';
        if (out) it.out = text(out, MAX_OUT);
        if (!it.ok) s.errors++;
        break;
      }
      case 'session.usage_record': {
        const u = d.usage || {};
        const c = ((u.copilotUsage && u.copilotUsage.totalNanoAiu) || 0) / 1e9;
        s.credits += c;
        const tk = (u.inputTokens || 0) + (u.outputTokens || 0);
        s.tokens += tk;
        const id = typeof u.model === 'string' && u.model ? u.model.slice(0, 60) : 'unknown';
        const m = s.models[id] || (s.models[id] = { name: '', credits: 0, tokens: 0, calls: 0, hours: {} });
        if (u.modelDisplayName && !m.name) m.name = String(u.modelDisplayName).slice(0, 60);
        m.credits += c; m.tokens += tk; m.calls++;
        if (c && at) {
          const h = Math.floor(Date.parse(at) / 3600e3);
          s.hours[h] = (s.hours[h] || 0) + c;
          m.hours[h] = (m.hours[h] || 0) + c;
        }
        break;
      }
      case 'session.error':
        s.errors++;
        items.push({ k: 'e', at, text: text(d.message || d.errorType || 'Error', 600) });
        break;
      case 'abort':
        items.push({ k: 'e', at, text: 'Cancelled' + (d.reason ? ': ' + text(d.reason, 200) : '') });
        break;
    }
  }
  if (meta.updatedAt && (!s.updatedAt || meta.updatedAt > s.updatedAt)) s.updatedAt = meta.updatedAt;
  if (!s.title) s.title = firstSentence(s.preview) || 'Untitled session';
  s.credits = Math.round(s.credits * 100) / 100;
  for (const h of Object.keys(s.hours)) s.hours[h] = Math.round(s.hours[h] * 100) / 100;
  for (const m of Object.values(s.models)) {
    m.credits = Math.round(m.credits * 100) / 100;
    for (const h of Object.keys(m.hours)) m.hours[h] = Math.round(m.hours[h] * 100) / 100;
  }
  return { summary: s, transcript: { v: 1, id: meta.id, items } };
}

// Raw events.jsonl text → parsed events of the kept types (lines that fail to parse are skipped).
export function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!KEEP.test(line)) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line while the session is writing */ }
  }
  return out;
}
