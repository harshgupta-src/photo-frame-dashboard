// Reminders lists pushed by the iPhone Shortcut (POST /reminders). The Worker keeps the last push in
// KV for the frame's fallback (GET /reminders) and forwards it straight to Home Assistant's reminders
// webhook (secret HA_REMINDERS_WEBHOOK_URL, see ../../ha/README.md), which updates HA's to-do lists.
// Changes made on the frame wait in HA's ledger (sensor.frame_reminders_ledger), which HA publishes
// here (POST /reminders/ops); the Shortcut reads them (GET /reminders/ops), makes them in Reminders and
// sends "ack": <ack> with its next push so HA stops protecting them.

export function cleanList(items) {
  // Shortcuts sends a list most easily as newline-separated text.
  if (typeof items === 'string') items = items.split(/\r?\n/);
  if (!Array.isArray(items)) return [];
  return items.slice(0, 300).map((it) => (typeof it === 'string' ? { title: it } : it || {}))
    .map((it) => ({
      title: String(it.title || it.name || '').trim().slice(0, 120),
      notes: it.notes ? String(it.notes).slice(0, 200) : undefined,
      due: it.due ? String(it.due).slice(0, 40) : undefined,
      assignee: it.assignee ? String(it.assignee).trim().slice(0, 40) || undefined : undefined,
      done: it.done === true || it.done === 'true' || it.done === 'Yes' || it.completed === true,
    }))
    .filter((it) => it.title);
}

const seqOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

// Accepts {"lists": {...}, "ack": 12} or the lists flat at the top level: {"Grocery list": "milk\neggs"}
// (an "ack" key there is the ack, not a list). Returns {updated, lists, ack}, or null when the body
// isn't a lists object. ack is 0 when absent.
export function parseReminders(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const wrapped = body.lists && typeof body.lists === 'object';
  const lists = wrapped ? body.lists : body;
  if (Array.isArray(lists)) return null;
  const out = { updated: now.toISOString(), lists: {}, ack: seqOf(body.ack) };
  for (const [name, items] of Object.entries(lists).filter(([k]) => wrapped || k !== 'ack').slice(0, 10)) {
    out.lists[String(name).slice(0, 60)] = cleanList(items);
  }
  return out;
}

const OPS = ['add', 'rename', 'edit', 'complete', 'reopen', 'delete'];
const str = (v, n) => String(v ?? '').trim().slice(0, n);

// HA's ledger, as posted by automation frame_reminders_ops_publish: {seq, ops: [{seq, op, list,
// title, old_title, notes, assignee, at, ...}]}. Returns what's stored in KV, or null if malformed.
export function cleanOps(body, now = new Date()) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.ops)) return null;
  const ops = body.ops.slice(-300).filter((o) => o && OPS.includes(o.op) && seqOf(o.seq) && str(o.title, 120))
    .map((o) => ({
      seq: seqOf(o.seq), op: o.op, list: str(o.list, 60), title: str(o.title, 120),
      old_title: str(o.old_title, 120), notes: str(o.notes, 500), assignee: str(o.assignee, 40), at: str(o.at, 40),
    }))
    .sort((a, b) => a.seq - b.seq);
  return { updated: now.toISOString(), seq: Math.max(seqOf(body.seq), ...ops.map((o) => o.seq), 0), ops };
}

// For the Shortcut: the pending ops, and the ack to send with the next push once they're made.
export function opsForPhone(stored) {
  const s = stored && Array.isArray(stored.ops) ? stored : { updated: null, seq: 0, ops: [] };
  return { updated: s.updated, ack: s.ops.length ? s.ops[s.ops.length - 1].seq : s.seq || 0, count: s.ops.length, ops: s.ops.map(phoneOp) };
}

// Shortcuts' If can't reliably compare against text set outside the editor, so each op also carries
// flag keys the Shortcut tests with "has any value": is_<op>, and in_grocery / in_loml for the list.
// apple_notes is the Reminders notes text, with the frame's assignee as an "Assigned: Name" last line.
export function phoneOp(o) {
  const out = { ...o, [`is_${o.op}`]: 'yes' };
  const list = String(o.list || '').toLowerCase();
  if (list.startsWith('grocery')) out.in_grocery = 'yes';
  else if (list === 'loml') out.in_loml = 'yes';
  out.apple_notes = [o.notes, o.assignee ? `Assigned: ${o.assignee}` : ''].filter(Boolean).join('\n');
  return out;
}

// 'ok' (HA answered 2xx; HA answers 200 even for an unknown webhook id), 'failed', or 'off' (no secret).
// Sends {"lists": {...}} plus "ack" when the push carried one.
export async function forwardToHA(env, lists, fetchFn = fetch, ack = 0) {
  const url = env.HA_REMINDERS_WEBHOOK_URL;
  if (!url) return 'off';
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ack ? { lists, ack } : { lists }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
