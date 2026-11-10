// Reminders lists pushed by the iPhone Shortcut (POST /reminders). The Worker keeps the last push in
// KV for the frame's fallback (GET /reminders) and forwards it straight to Home Assistant's reminders
// webhook (secret HA_REMINDERS_WEBHOOK_URL, see ../../ha/README.md), which updates HA's to-do lists.

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

// Accepts {"lists": {...}} or the lists flat at the top level: {"Grocery list": "milk\neggs"}.
// Returns {updated, lists}, or null when the body isn't a lists object.
export function parseReminders(body, now = new Date()) {
  const lists = body && typeof body === 'object' ? (body.lists && typeof body.lists === 'object' ? body.lists : body) : null;
  if (!lists || Array.isArray(lists)) return null;
  const out = { updated: now.toISOString(), lists: {} };
  for (const [name, items] of Object.entries(lists).slice(0, 10)) out.lists[String(name).slice(0, 60)] = cleanList(items);
  return out;
}

// 'ok' (HA answered 2xx; HA answers 200 even for an unknown webhook id), 'failed', or 'off' (no secret).
export async function forwardToHA(env, lists, fetchFn = fetch) {
  const url = env.HA_REMINDERS_WEBHOOK_URL;
  if (!url) return 'off';
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lists),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
