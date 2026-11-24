// The day's walk plan (decided by the Home Assistant agent each morning): pure functions so node --test
// can cover them; walkstore.js keeps plans in KV (walk-plan:<date>) and mirrors each planned walk to the
// calendar of whoever walks (WALK_PLAN_CALENDARS, else the CALENDARS entry for exactly those people).
// A planned walk's event is removed once a walk is logged for it: the walk names it (planId, sent by the
// frame) or, failing that, is the nearest walk within 90 minutes of its start.
import { icsTime, VTIMEZONE } from './ics.js';
import { WalkError, walkersOf, validId, validTz, localDate, localHM, PLAN_PREFIX } from './walks.js';
import { expectPotty, normalizeExpect } from './walkexpect.js';

export const MATCH_WINDOW = 90 * 60e3;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (d) => typeof d === 'string' && DATE.test(d) && !Number.isNaN(Date.parse(d + 'T12:00:00Z'));
// The calendar day after date (not localDate(now + 24 h): days are 23 or 25 hours around DST changes).
export const nextDate = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
export const prevDate = (d) => new Date(Date.parse(d + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

function tzOffset(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// "16:00" or "2026-11-09T16:00" in tz, or ISO with an offset, or epoch ms → epoch ms.
export function when(v, date, tz, name) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v ?? '').trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) s = date + 'T' + s.padStart(5, '0');
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new WalkError(name + ' is not a time: ' + s);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return wall - tzOffset(wall - tzOffset(wall, tz), tz);
}

// PUT body {walks: [{id?, start, end? | durationMin?, walkers, note?, expect?: {pee, poop}}], notes?, source?, lateUntil?}
// → the stored plan. expect: what the agent thinks the walk will bring (the end-of-walk sheet's defaults); optional.
// Bedtime: walks starting after 22:00 local are dropped (plan.dropped) unless lateUntil ("HH:MM", from HA:
// 30 min after the last non-Maya calendar event that ends after 22:00 that day) allows them, or their id
// is in keep (already walked or under way).
// start/end: "16:00" (local, on that date), "2026-11-09T16:00" (local) or ISO with an offset.
// names: walker id → display name (from the frame's walks).
export const BEDTIME = '22:00';
export function normalizePlan(body, date, tz, names = {}, now = Date.now(), keep = new Set()) {
  if (!validDate(date)) throw new WalkError('the plan date must be YYYY-MM-DD');
  if (!validTz(tz)) throw new WalkError('tz is not a time zone');
  if (!body || typeof body !== 'object' || !Array.isArray(body.walks)) throw new WalkError('body must be {"walks": [...]}');
  if (body.walks.length > 8) throw new WalkError('at most 8 walks a day');
  let late = when(BEDTIME, date, tz, 'bedtime');
  if (body.lateUntil) { try { late = Math.max(late, when(body.lateUntil, date, tz, 'lateUntil')); } catch { /* ignore a bad lateUntil */ } }
  const all = body.walks.map((x, i) => {
    if (!x || typeof x !== 'object') throw new WalkError('walk ' + (i + 1) + ' is not an object');
    const start = when(x.start, date, tz, 'start');
    const end = x.end != null ? when(x.end, date, tz, 'end') : start + Math.round(Number(x.durationMin ?? x.minutes ?? 30)) * 60e3;
    if (!Number.isFinite(end) || end - start < 5 * 60e3 || end - start > 3 * 3600e3) throw new WalkError('walk ' + (i + 1) + ' must last 5 to 180 minutes');
    if (localDate(start, tz) !== date) throw new WalkError('walk ' + (i + 1) + ' does not start on ' + date);
    const walkers = walkersOf(x.walkers ?? x.by).map(({ id, name, named }) => ({ id, name: named ? name : names[id] || name }));
    if (!walkers.length) throw new WalkError('walk ' + (i + 1) + ' needs walkers');
    const auto = !validId(x.id), id = auto ? date + '-' + new Date(start).toISOString().slice(11, 16).replace(':', '') : x.id;
    return { id, auto, start, end, walkers, note: clean(x.note ?? x.notes, 200) || null, expect: normalizeExpect(x.expect), created: now };
  }).sort((a, b) => a.start - b.start);
  // An auto id (date + UTC start) that another walk already has, e.g. a new walk at the same minute as a
  // kept one, gets a suffix; walks the PUT names keep theirs (and so their calendar events). Two new
  // walks at the same minute are still rejected below.
  const named = new Set(all.filter((x) => !x.auto).map((x) => x.id)), taken = new Set(named);
  for (const x of all) {
    if (x.auto && named.has(x.id)) { const base = x.id; for (let n = 2; taken.has(x.id); n++) x.id = base + '-' + n; }
    taken.add(x.id);
    delete x.auto;
  }
  const items = all.filter((x) => x.start <= late || keep.has(x.id));
  const dropped = all.filter((x) => !items.includes(x)).map((x) => ({ start: new Date(x.start).toISOString(), walkers: x.walkers.map((p) => p.id), reason: 'after bedtime' }));
  if (new Set(items.map((x) => x.id)).size !== items.length) throw new WalkError('two planned walks share an id or a start time');
  return {
    date, tz, items, notes: clean(body.notes, 500) || null, source: clean(body.source, 40) || 'api', updated: new Date(now).toISOString(),
    lateUntil: new Date(late).toISOString(), ...(dropped.length ? { dropped } : {}),
  };
}

// Which logged walk covers each planned item → Map(itemId → walk). Walks naming a plan item win; the
// rest take the nearest free item within MATCH_WINDOW of their start, but never one planned after the walk
// ended (a replan made after a walk mustn't count it as done). walks: live (not deleted).
export function matchPlan(items, walks, key = (x) => x.id) {
  const out = new Map(), used = new Set(), named = new Set();
  for (const w of walks) {
    const x = w.planId && !named.has(w.planId) && items.find((i) => i.id === w.planId && !out.has(key(i)));
    if (x) { out.set(key(x), w); used.add(w.id); named.add(w.planId); }
  }
  for (const w of [...walks].sort((a, b) => a.startedAt - b.startedAt)) {
    if (used.has(w.id) || (w.planId && named.has(w.planId))) continue;
    let best = null;
    for (const x of items) {
      if (out.has(key(x)) || (x.created && w.endedAt != null && x.created > w.endedAt)) continue;
      const d = Math.abs(w.startedAt - x.start);
      if (d <= MATCH_WINDOW && (!best || d < best.d)) best = { x, d };
    }
    if (best) { out.set(key(best.x), w); used.add(w.id); }
  }
  return out;
}

// matchPlan over neighbouring days at once, so a walk around midnight counts for one day's plan only
// (the nearest), not for both. plans: [{date, items}] → Map(date → Map(itemId → walk)).
export function matchPlans(plans, walks) {
  const items = plans.flatMap((p) => p.items.map((x) => ({ ...x, day: p.date })));
  const all = matchPlan(items, walks, (x) => x.day + ' ' + x.id);
  const out = new Map(plans.map((p) => [p.date, new Map()]));
  for (const x of items) if (all.has(x.day + ' ' + x.id)) out.get(x.day).set(x.id, all.get(x.day + ' ' + x.id));
  return out;
}

// planned | active (its walk is under way) | done | missed (ended with no walk)
export function planStatus(item, walk, now) {
  if (walk) return walk.endedAt == null ? 'active' : 'done';
  return item.end < now ? 'missed' : 'planned';
}

// The calendar for a set of walkers: WALK_PLAN_CALENDARS {"harsh": "...", "ambuja+harsh": "..."} (ids
// sorted, joined by +), else the CALENDARS entry whose people are exactly them, else null (no event).
export function planCalendarName(env, walkerIds) {
  const key = [...new Set(walkerIds)].sort().join('+');
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v || {}; } catch { return {}; } };
  const explicit = parse(env.WALK_PLAN_CALENDARS);
  if (explicit[key]) return explicit[key];
  // Keys written in another order ("harsh+ambuja") or case.
  for (const [k, name] of Object.entries(explicit)) {
    if ([...new Set(k.toLowerCase().split('+').map((x) => x.trim()))].sort().join('+') === key) return name;
  }
  for (const [name, people] of Object.entries(parse(env.CALENDARS))) {
    if (Array.isArray(people) && [...new Set(people)].sort().join('+') === key) return name;
  }
  return null;
}

// What the planned event shows; a change means it must be rewritten.
export function planRev(item, dog) {
  return JSON.stringify([item.start, item.end, item.walkers.map((x) => x.name), item.note, dog]);
}

export const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export const planUid = (id) => PLAN_PREFIX + id + '@frame-data';

export function planICS(item, dog, now) {
  const who = item.walkers.map((x) => x.name).join(' & ');
  const desc = [
    item.note || '',
    'Planned walk for ' + dog + ' (Home Assistant agent). Start it from the walk tile on the photo frame; this event is removed once the walk is logged and the walk itself goes on the Life Log calendar.',
  ].filter(Boolean).join('\n\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//photo-frame-dashboard//walk-plan//EN', 'CALSCALE:GREGORIAN', ...VTIMEZONE, 'BEGIN:VEVENT',
    'UID:' + planUid(item.id),
    'DTSTAMP:' + stamp(now),
    icsTime('DTSTART', item.start),
    icsTime('DTEND', item.end),
    'SUMMARY:' + icsText('🐕 ' + dog + ' walk — ' + who),
    'DESCRIPTION:' + icsText(desc),
    'CATEGORIES:' + icsText(dog + ' walk plan'),
    'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
}

// Minutes since local midnight in tz.
export const minuteOfDay = (tz) => (ms) => { const [h, m] = localHM(ms, tz).split(':'); return +h * 60 + +m; };

// The plan as JSON for the frame and agents (times ISO; status from the matched walks). walks (live
// walks of the last 14 days) give each walk's expect {pee, poop, from: plan|history|usual, n?}.
export function planJSON(plan, matched, now, walks = [], tz = plan.tz || 'UTC') {
  const mod = minuteOfDay(tz);
  return {
    date: plan.date, updated: plan.updated, source: plan.source, notes: plan.notes || undefined,
    lateUntil: plan.lateUntil || undefined, dropped: plan.dropped || undefined,
    walks: plan.items.map((x) => {
      const w = matched.get(x.id);
      return {
        id: x.id, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString(),
        created: x.created ? new Date(x.created).toISOString() : undefined,
        durationMin: Math.round((x.end - x.start) / 60e3),
        walkers: x.walkers.map((p) => p.name), walkerIds: x.walkers.map((p) => p.id),
        note: x.note || undefined, status: planStatus(x, w, now), walkId: w ? w.id : undefined,
        expect: expectPotty(x.expect, walks, x.start, mod, w && w.id),
        calendar: x.cal ? (x.cal.error ? 'error' : x.cal.href ? 'synced' : x.cal.name ? 'none' : 'off') : 'off',
        calendarName: x.cal && x.cal.name || undefined,
      };
    }),
  };
}
