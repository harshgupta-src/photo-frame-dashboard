// Expands iCalendar text into plain event JSON for the frame.
import ICAL from 'ical.js';

const pad = (n) => String(n).padStart(2, '0');
const dateOnly = (t) => t.year + '-' + pad(t.month) + '-' + pad(t.day);
const MAX_OCCURRENCES = 2000, MAX_STEPS = 50000;

// ------------------------------------------------------------------ writing local times
// Timed events we write carry TZID=America/New_York plus this VTIMEZONE (US rules since 2007), so
// Apple Calendar shows them in Eastern Time instead of as UTC.
export const EVENT_TZ = 'America/New_York';
export const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:' + EVENT_TZ,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
// TZID=America/New_York reads correctly even from objects that leave the VTIMEZONE out.
ICAL.TimezoneService.register(new ICAL.Component(ICAL.parse(VTIMEZONE.join('\r\n'))));

// Offset (ms) of `tz` from UTC at instant `ms` (whole seconds).
export function tzOffset(ms, tz = EVENT_TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

const wallParts = (ms, tz) => {
  const d = new Date(Math.floor(ms / 1000) * 1000 + tzOffset(ms, tz));
  return [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()), pad(d.getUTCMinutes()), pad(d.getUTCSeconds())];
};
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

// The local wall time of `ms` also names another instant (the hour repeated when DST ends).
function ambiguous(ms, tz) {
  const off = tzOffset(ms, tz), wall = Math.floor(ms / 1000) * 1000 + off;
  return [tzOffset(ms - 3600e3, tz), tzOffset(ms + 3600e3, tz)]
    .some((o) => o !== off && tzOffset(wall - o, tz) === o);
}

// 'DTSTART' + ms → 'DTSTART;TZID=America/New_York:20261112T123000'. Times in the hour repeated when
// DST ends stay UTC: readers disagree on which pass a bare wall time means (RFC 5545 says the first,
// ical.js takes the second).
export function icsTime(name, ms, tz = EVENT_TZ) {
  if (ambiguous(ms, tz)) return name + ':' + utcStamp(ms);
  const [y, mo, d, h, mi, s] = wallParts(ms, tz);
  return name + ';TZID=' + tz + ':' + y + mo + d + 'T' + h + mi + s;
}

// ms → '2026-11-12T12:30:00-05:00' (local time with its offset).
export function localISO(ms, tz = EVENT_TZ) {
  const [y, mo, d, h, mi, s] = wallParts(ms, tz);
  const off = tzOffset(ms, tz) / 60e3, a = Math.abs(off);
  return y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + s + (off < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}

const knownTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// An ical.js time → ms. A TZID with no VTIMEZONE in the file (other than ours) and floating times come
// out of ical.js as floating, which toJSDate() reads in the server's zone (UTC on the VM): read them
// in that IANA zone instead (via Intl), or in the home zone.
export function icalMs(t, tzid) {
  if (t.isDate || !t.zone || t.zone.tzid !== 'floating') return t.toJSDate().getTime();
  const tz = tzid && knownTz(tzid) ? tzid : EVENT_TZ;
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return wall - tzOffset(wall - tzOffset(wall, tz), tz);
}
const tzidOf = (comp, name) => { const p = comp.getFirstProperty(name); return p ? p.getParameter('tzid') : null; };

// One CalDAV object (or a whole .ics feed) → events overlapping [from, to).
// All-day dates stay 'YYYY-MM-DD' (end exclusive) so the frame reads them in its own time zone.
function parseRoot(icsText) {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const id = tz.getFirstPropertyValue('tzid');
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
  }
  return root;
}

// What one CalDAV object holds for `uid` (exact match): {title, start, recurring}, or null.
export function describeUid(icsText, uid) {
  let root;
  try { root = parseRoot(icsText); } catch { return null; }
  const vs = root.getAllSubcomponents('vevent').filter((v) => v.getFirstPropertyValue('uid') === uid);
  if (!vs.length) return null;
  const ev = new ICAL.Event(vs.find((v) => !v.hasProperty('recurrence-id')) || vs[0]);
  const s = ev.startDate;
  return {
    title: ev.summary || '(No title)',
    start: !s ? null : s.isDate ? dateOnly(s) : localISO(icalMs(s, tzidOf(ev.component, 'dtstart'))),
    recurring: ev.isRecurring(),
  };
}

export function expandICS(icsText, cal, from, to) {
  const root = parseRoot(icsText);
  const masters = new Map(), overrides = [];
  for (const v of root.getAllSubcomponents('vevent')) {
    if (v.hasProperty('recurrence-id')) overrides.push(v);
    else masters.set(v.getFirstPropertyValue('uid'), new ICAL.Event(v));
  }
  for (const v of overrides) {
    const m = masters.get(v.getFirstPropertyValue('uid'));
    if (m) m.relateException(v);
    else masters.set(v.getFirstPropertyValue('uid') + '@' + v.getFirstPropertyValue('recurrence-id'), new ICAL.Event(v));
  }

  const fromMs = +from, toMs = +to, out = [];
  const push = (ev, s, e, id) => {
    if (String(ev.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    if (!e) e = s.clone();
    const sTz = tzidOf(ev.component, 'dtstart');
    const sMs = icalMs(s, sTz), eMs = icalMs(e, ev.component.hasProperty('dtend') ? tzidOf(ev.component, 'dtend') : sTz);
    if (sMs >= toMs || Math.max(eMs, sMs + 1) <= fromMs) return;
    out.push({
      id, cal: cal.name, people: cal.people, title: ev.summary || '(No title)', allDay: s.isDate,
      start: s.isDate ? dateOnly(s) : new Date(sMs).toISOString(),
      end: s.isDate ? dateOnly(e) : new Date(eMs).toISOString(),
      loc: ev.location || undefined,
      notes: ev.description ? String(ev.description).slice(0, 500) : undefined,
    });
  };
  for (const ev of masters.values()) {
    if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate, ev.uid); continue; }
    // Only occurrences in range count toward MAX_OCCURRENCES, so a daily series started years ago still
    // reaches today; MAX_STEPS bounds the walk from DTSTART.
    const it = ev.iterator(), before = out.length;
    for (let n = 0, next; (next = it.next()) && n < MAX_STEPS && out.length - before < MAX_OCCURRENCES; n++) {
      if (next.toJSDate().getTime() >= toMs) break;
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate, ev.uid + '@' + next.toString());
    }
  }
  return out;
}
