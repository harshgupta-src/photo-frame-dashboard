// Dog walk log: validation, JSON shapes, the calendar event and the generated markdown log.
// Pure functions (no Cloudflare APIs) so node --test can cover them; walklog.js stores the walks.

export const MIN_TIME = Date.UTC(2026, 0, 1); // frames without an RTC boot at 1970 until NTP syncs
export const MAX_WALK = 6 * 3600e3;
const SKEW = 2 * 60e3;
export const UID_PREFIX = 'dog-walk-';

export class WalkError extends Error {
  constructor(message, status = 400, extra) { super(message); this.status = status; this.extra = extra; }
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;
export const validId = (id) => typeof id === 'string' && ID.test(id);

function time(v, name) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new WalkError(name + ' is not a time');
  return Math.round(t);
}
function bool(v) {
  if (v === true || v === 'true' || v === 1 || v === 'yes' || v === 'Yes') return true;
  if (v === false || v === 'false' || v === 0 || v === 'no' || v === 'No') return false;
  return null;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// [{id, name}] from [{id, name}] | ['harsh'] | 'Harsh, Ambuja'
export function walkersOf(v) {
  if (typeof v === 'string') v = v.split(/\s*[,&+]\s*|\s+and\s+/i);
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const w of v.slice(0, 4)) {
    const name = clean(typeof w === 'object' && w ? w.name || w.id : w, 40);
    const id = clean(typeof w === 'object' && w ? w.id || name : w, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (id && !out.some((x) => x.id === id)) out.push({ id, name: name || id });
  }
  return out;
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

// A PUT body → the fields to store. `now` is server time. If the client says what its clock read
// when it sent the request (clientNow) and that is more than 2 min off, its times are shifted by
// the difference, so a frame with a wrong clock still logs the right times.
export function normalize(body, now) {
  if (!body || typeof body !== 'object') throw new WalkError('body must be a JSON object');
  const clientNow = time(body.clientNow, 'clientNow');
  const shift = clientNow && Math.abs(now - clientNow) > SKEW ? now - clientNow : 0;
  let startedAt = time(body.startedAt, 'startedAt');
  let endedAt = time(body.endedAt, 'endedAt');
  if (startedAt == null) throw new WalkError('startedAt is required');
  startedAt += shift;
  if (endedAt != null) endedAt += shift;
  if (startedAt < MIN_TIME) throw new WalkError('startedAt is before 2026: the clock is not set');
  if (startedAt > now + 5 * 60e3) throw new WalkError('startedAt is in the future');
  if (endedAt != null) {
    if (endedAt < startedAt) throw new WalkError('endedAt is before startedAt');
    if (endedAt > now + 5 * 60e3) throw new WalkError('endedAt is in the future');
    if (endedAt - startedAt > MAX_WALK) throw new WalkError('a walk can be at most 6 hours');
  }
  return {
    startedAt, endedAt,
    pee: bool(body.pee), poop: bool(body.poop),
    walkers: walkersOf(body.walkers != null ? body.walkers : body.by),
    notes: clean(body.notes, 300) || null,
    dog: clean(body.dog, 40) || null,
    tz: validTz(body.tz),
    source: clean(body.source, 20) || 'api',
  };
}

// ------------------------------------------------------------------ dates in the home time zone
const fmtCache = new Map();
function parts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
export const localDate = (ms, tz) => { const p = parts(ms, tz); return p.year + '-' + p.month + '-' + p.day; };
export function clock(ms, tz) {
  const p = parts(ms, tz), h = +p.hour;
  return (h % 12 || 12) + ':' + p.minute + (h < 12 ? 'am' : 'pm');
}
const weekday = (ms, tz) => parts(ms, tz).weekday;
export const minutes = (w) => (w.endedAt == null ? null : Math.round((w.endedAt - w.startedAt) / 60e3));

// ------------------------------------------------------------------ JSON for the frame and agents
export function walkJSON(w, tz) {
  return {
    id: w.id,
    startedAt: new Date(w.startedAt).toISOString(),
    endedAt: w.endedAt == null ? null : new Date(w.endedAt).toISOString(),
    durationMin: minutes(w),
    localDate: localDate(w.startedAt, tz),
    pee: w.pee, poop: w.poop,
    walkers: w.walkers.map((x) => x.name), walkerIds: w.walkers.map((x) => x.id),
    notes: w.notes || undefined,
    source: w.source,
    calendar: w.endedAt == null ? undefined : w.calState,
  };
}

// walks: completed and active, not deleted, newest first.
export function summarize(walks, now, tz) {
  const active = walks.find((w) => w.endedAt == null) || null;
  const done = walks.filter((w) => w.endedAt != null);
  const today = localDate(now, tz);
  const since = (ms) => (ms == null ? null : Math.round((now - ms) / 60e3));
  const lastPee = done.find((w) => w.pee), lastPoop = done.find((w) => w.poop);
  const day = (d) => {
    const list = done.filter((w) => localDate(w.startedAt, tz) === d);
    return {
      date: d, walks: list.length, minutes: list.reduce((s, w) => s + minutes(w), 0),
      pees: list.filter((w) => w.pee).length, poops: list.filter((w) => w.poop).length,
    };
  };
  const week = done.filter((w) => now - w.startedAt < 7 * 864e5);
  const weekMin = week.reduce((s, w) => s + minutes(w), 0);
  return {
    now: new Date(now).toISOString(), tz,
    active: active ? { ...walkJSON(active, tz), minutesSoFar: since(active.startedAt) } : null,
    last: done[0] ? walkJSON(done[0], tz) : null,
    minutesSinceLastWalk: done[0] ? since(done[0].endedAt) : null,
    lastPee: lastPee ? new Date(lastPee.endedAt).toISOString() : null,
    minutesSinceLastPee: lastPee ? since(lastPee.endedAt) : null,
    lastPoop: lastPoop ? new Date(lastPoop.endedAt).toISOString() : null,
    minutesSinceLastPoop: lastPoop ? since(lastPoop.endedAt) : null,
    today: day(today),
    last7Days: {
      walks: week.length, minutes: weekMin,
      avgMinutes: week.length ? Math.round(weekMin / week.length) : 0,
      walksPerDay: Math.round(week.length / 7 * 10) / 10,
      poops: week.filter((w) => w.poop).length,
    },
  };
}

// ------------------------------------------------------------------ calendar event (iCalendar)
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
// RFC 5545 lines are at most 75 octets; continuation lines start with a space.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
export const eventUid = (id) => UID_PREFIX + id + '@frame-data';

export function eventTitle(w) {
  const dog = w.dog || 'Dog';
  const who = w.walkers.length ? ' — ' + w.walkers.map((x) => x.name).join(' & ') : '';
  const potty = [w.pee ? '💧' : '', w.poop ? '💩' : ''].join('');
  return dog + ' walk' + who + ' · ' + (potty || 'no potty');
}

export function walkICS(w, now) {
  const yn = (v) => (v == null ? 'not logged' : v ? 'yes' : 'no');
  const desc = [
    'Duration: ' + minutes(w) + ' min',
    'Pee: ' + yn(w.pee),
    'Poop: ' + yn(w.poop),
    'Walked by: ' + (w.walkers.map((x) => x.name).join(', ') || 'not logged'),
    w.notes ? 'Notes: ' + w.notes : '',
    '',
    'Logged with the walk timer on the photo frame. Edit or delete it there (Today → walk tile → history); changes here are overwritten.',
  ].filter((l, i, a) => l || (i && a[i - 1])).join('\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//photo-frame-dashboard//walks//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + eventUid(w.id),
    'DTSTAMP:' + stamp(now),
    'LAST-MODIFIED:' + stamp(w.updatedAt || now),
    'DTSTART:' + stamp(w.startedAt),
    'DTEND:' + stamp(Math.max(w.endedAt, w.startedAt + 60e3)),
    'SUMMARY:' + icsText(eventTitle(w)),
    'DESCRIPTION:' + icsText(desc),
    'CATEGORIES:' + icsText((w.dog || 'Dog') + ' walk'),
    'TRANSP:TRANSPARENT',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].map(fold).join('\r\n');
}

// ------------------------------------------------------------------ markdown log for the vault
// Deterministic for the same walks and day (no "generated at" time), so the note only changes when
// the data does and the vault isn't rewritten every few minutes.
export function renderLog(walks, now, tz, dog = 'Dog') {
  const done = walks.filter((w) => w.endedAt != null);
  const active = walks.find((w) => w.endedAt == null);
  const s = summarize(walks, now, tz);
  const yn = (v) => (v == null ? '–' : v ? '✓' : '✗');
  const n = (k, word) => k + ' ' + word + (k === 1 ? '' : 's');
  const who = (w) => w.walkers.map((x) => x.name).join(' & ') || '–';
  const when = (ms) => weekday(ms, tz) + ' ' + localDate(ms, tz) + ' ' + clock(ms, tz);
  const latest = walks.reduce((m, w) => Math.max(m, w.updatedAt || w.startedAt), 0);
  const L = [
    '---',
    'type: log',
    'generated: true',
    'source: photo frame walk timer (frame-data Worker)',
    'updated: ' + (latest ? localDate(latest, tz) : localDate(now, tz)),
    'tags: [' + dog.toLowerCase().replace(/[^a-z0-9]+/g, '-') + ', walks, generated]',
    '---',
    '',
    '# ' + dog + ' Walk Log',
    '',
    '> [!info] Generated from the photo frame\'s walk timer. Do not edit: it is rewritten every few minutes and edits are lost.',
    '> Fix a walk on the frame (Today → walk tile → history). Live JSON: frame-data Worker `GET /walks/summary` (read-only agent key).',
    '> Times are ' + tz + '. Pee and poop: ✓ yes, ✗ no, – not logged.',
    '',
    '## Now',
    '',
  ];
  if (active) L.push('- **Out on a walk** since ' + when(active.startedAt) + (active.walkers.length ? ' with ' + who(active) : ''));
  if (s.last) {
    const w = done[0];
    L.push('- Last walk: ' + when(w.startedAt) + '–' + clock(w.endedAt, tz) + ' (' + minutes(w) + ' min), ' + who(w) + ', pee ' + yn(w.pee) + ', poop ' + yn(w.poop));
  } else L.push('- No walks logged yet.');
  const lastOf = (k) => done.find((w) => w[k]);
  if (lastOf('pee')) L.push('- Last pee: ' + when(lastOf('pee').endedAt));
  if (lastOf('poop')) L.push('- Last poop: ' + when(lastOf('poop').endedAt));
  L.push('- Today (' + s.today.date + '): ' + n(s.today.walks, 'walk') + ', ' + s.today.minutes + ' min, ' + n(s.today.pees, 'pee') + ', ' + n(s.today.poops, 'poop'));
  L.push('- Last 7 days: ' + n(s.last7Days.walks, 'walk') + ' (' + s.last7Days.walksPerDay + '/day), ' + s.last7Days.avgMinutes + ' min average, ' + n(s.last7Days.poops, 'poop'));
  L.push('', '## Last 30 days');
  const recent = done.filter((w) => now - w.startedAt < 30 * 864e5);
  if (!recent.length) L.push('', 'No walks in the last 30 days.');
  let day = null;
  for (const w of recent) {
    const d = localDate(w.startedAt, tz);
    if (d !== day) {
      day = d;
      const list = recent.filter((x) => localDate(x.startedAt, tz) === d);
      L.push('', '### ' + weekday(w.startedAt, tz) + ' ' + d + ' · ' + n(list.length, 'walk') + ', ' +
        list.reduce((n, x) => n + minutes(x), 0) + ' min', '', '| Start | End | Min | Pee | Poop | Who | Notes |', '|---|---|---|---|---|---|---|');
    }
    L.push('| ' + clock(w.startedAt, tz) + ' | ' + clock(w.endedAt, tz) + ' | ' + minutes(w) + ' | ' + yn(w.pee) + ' | ' + yn(w.poop) + ' | ' +
      who(w) + ' | ' + String(w.notes || '').replace(/\|/g, '/') + ' |');
  }
  const months = new Map();
  for (const w of done) {
    const m = localDate(w.startedAt, tz).slice(0, 7);
    const o = months.get(m) || { walks: 0, min: 0, poops: 0, days: new Set() };
    o.walks++; o.min += minutes(w); o.poops += w.poop ? 1 : 0; o.days.add(localDate(w.startedAt, tz));
    months.set(m, o);
  }
  if (months.size) {
    L.push('', '## By month', '', '| Month | Walks | Days | Walks/day | Avg min | Poops |', '|---|---|---|---|---|---|');
    for (const [m, o] of months) {
      L.push('| ' + m + ' | ' + o.walks + ' | ' + o.days.size + ' | ' + (Math.round(o.walks / o.days.size * 10) / 10) + ' | ' +
        Math.round(o.min / o.walks) + ' | ' + o.poops + ' |');
    }
  }
  L.push('');
  return L.join('\n');
}
