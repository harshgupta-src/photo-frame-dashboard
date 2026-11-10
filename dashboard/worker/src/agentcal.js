// Calendar read/write for household agents (the Home Brain MCP gateway), over the same iCloud
// account the frame reads. Agents can only create, change or delete their own events: every agent
// event has a UID starting with "hb-" and lives at <calendar>/<uid>.ics, so events people made are
// never touched.
//   GET    /agent/calendars                         [{alias, name, write}]
//   GET    /agent/events?calendar=&from=&to=&q=     events (all agent calendars if no calendar)
//   PUT    /agent/events/:uid                       create or replace {calendar, title, start, end, ...}
//   DELETE /agent/events/:uid[?calendar=]           delete (from every writable calendar if none given)
// Auth: Authorization: Bearer AGENT_CAL_KEY (a Worker secret if set, else derived from PUSH_TOKEN like
// WALK_KEY; scripts/walk-keys.mjs writes it). X-Agent-Person / X-Agent tag who wrote an event.
// Secret AGENT_CALENDARS: {"alias": {"name": "iCloud calendar name", "write": true | false | ["person", ...]}}.
import { listCalendars, calendarObjects, putEvent, deleteEvent, calKey } from './icloud.js';
import { expandICS } from './ics.js';
import { walkKey } from './walkapi.js';

const DAY = 864e5;
const MAX_RANGE_DAYS = 120;
export const AGENT_UID = /^hb-[a-z0-9][a-z0-9._-]{0,120}$/;
export const DEFAULT_TZ = 'America/New_York';

export class AgentCalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function agentCalendars(env) {
  let m = env.AGENT_CALENDARS;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { throw new AgentCalError(500, 'AGENT_CALENDARS is not valid JSON'); }
  }
  return Object.entries(m || {}).map(([alias, v]) => ({
    alias, name: typeof v === 'string' ? v : v.name, write: typeof v === 'string' ? false : v.write ?? false,
  }));
}

export const canWrite = (cal, person) =>
  cal.write === true || (Array.isArray(cal.write) && !!person && cal.write.map((p) => String(p).toLowerCase()).includes(person.toLowerCase()));

// ------------------------------------------------------------------ time handling
const pad = (n) => String(n).padStart(2, '0');

// Offset (ms) of `tz` from UTC at instant `ms`.
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// ISO with Z/offset → that instant. Wall-clock "YYYY-MM-DDTHH:MM[:SS]" → that time in `tz`.
export function parseTime(s, tz = DEFAULT_TZ) {
  const str = String(s ?? '').trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const ms = Date.parse(str);
    if (Number.isNaN(ms)) throw new AgentCalError(400, 'bad time: ' + str);
    return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (!m) throw new AgentCalError(400, 'bad time (use 2026-11-12T12:30 or ISO with offset): ' + str);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let ms = wall - tzOffset(wall, tz);
  ms = wall - tzOffset(ms, tz); // second pass settles DST boundaries
  return ms;
}

const parseDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) throw new AgentCalError(400, 'bad date (use YYYY-MM-DD): ' + s);
  return m[1] + m[2] + m[3];
};

// ------------------------------------------------------------------ iCalendar
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
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

// Validated event input → VCALENDAR text.
export function agentICS(uid, ev, now, by = {}) {
  if (!AGENT_UID.test(uid)) throw new AgentCalError(400, 'uid must match ' + AGENT_UID);
  const title = String(ev.title ?? '').trim();
  if (!title) throw new AgentCalError(400, 'title is required');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//photo-frame-dashboard//agents//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(now), 'LAST-MODIFIED:' + stamp(now),
  ];
  if (ev.allDay) {
    const s = parseDate(ev.start);
    const e = ev.end ? parseDate(ev.end) : null;
    const next = (d) => { const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) + DAY); return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate()); };
    const end = e && e > s ? e : next(s);
    lines.push('DTSTART;VALUE=DATE:' + s, 'DTEND;VALUE=DATE:' + end);
  } else {
    const s = parseTime(ev.start, ev.timezone);
    const e = ev.end ? parseTime(ev.end, ev.timezone) : s + 30 * 60e3;
    if (e <= s) throw new AgentCalError(400, 'end must be after start');
    if (e - s > 14 * DAY) throw new AgentCalError(400, 'events longer than 14 days are not supported');
    lines.push('DTSTART:' + stamp(s), 'DTEND:' + stamp(e));
  }
  lines.push('SUMMARY:' + icsText(title.slice(0, 250)));
  if (ev.description) lines.push('DESCRIPTION:' + icsText(String(ev.description).slice(0, 4000)));
  if (ev.location) lines.push('LOCATION:' + icsText(String(ev.location).slice(0, 250)));
  if (ev.busy === false) lines.push('TRANSP:TRANSPARENT');
  if (by.person) lines.push('X-HOMEBRAIN-PERSON:' + icsText(by.person));
  if (by.agent) lines.push('X-HOMEBRAIN-AGENT:' + icsText(by.agent));
  const alarms = Array.isArray(ev.alarms) ? ev.alarms : [];
  if (alarms.length > 3) throw new AgentCalError(400, 'at most 3 alarms');
  for (const a of alarms) {
    const min = Number(a);
    if (!Number.isInteger(min) || min < 0 || min > 10080) throw new AgentCalError(400, 'alarms are whole minutes before the start (0-10080)');
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(title.slice(0, 250)), 'TRIGGER:' + (min ? '-PT' + min + 'M' : 'PT0S'), 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.map(fold).join('\r\n');
}

// ------------------------------------------------------------------ HTTP
export async function agentCalAccess(req, env, same) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return !!t && same(t, await walkKey(env, 'AGENT_CAL_KEY'));
}

async function resolved(env) {
  const wanted = agentCalendars(env);
  if (!wanted.length) throw new AgentCalError(500, 'AGENT_CALENDARS is not set');
  const all = await listCalendars(env);
  return wanted.map((w) => ({ ...w, url: (all.find((c) => calKey(c.name) === calKey(w.name)) || {}).url || null }));
}

function pick(cals, alias) {
  const c = cals.find((x) => x.alias === alias);
  if (!c) throw new AgentCalError(400, 'unknown calendar "' + alias + '"; use one of: ' + cals.map((x) => x.alias).join(', '));
  if (!c.url) throw new AgentCalError(502, 'calendar "' + c.name + '" is not visible to the iCloud account');
  return c;
}

const hrefFor = (cal, uid) => cal.url + encodeURIComponent(uid) + '.ics';

// → { status, body } or null when the path isn't an agent route.
export async function agentCalRoute(req, url, env, ctx, ok) {
  const p = url.pathname, m = req.method;
  if (p !== '/agent/calendars' && p !== '/agent/events' && !p.startsWith('/agent/events/')) return null;
  if (!ok) return { status: 401, body: { error: 'unauthorized' } };
  const person = (req.headers.get('X-Agent-Person') || '').trim().slice(0, 40);
  const agent = (req.headers.get('X-Agent') || '').trim().slice(0, 60);
  try {
    if (p === '/agent/calendars' && m === 'GET') {
      const cals = await resolved(env);
      return { status: 200, body: cals.map((c) => ({ alias: c.alias, name: c.name, write: canWrite(c, person), found: !!c.url })) };
    }
    if (p === '/agent/events' && m === 'GET') {
      const now = Date.now();
      const from = url.searchParams.get('from') ? parseTime(url.searchParams.get('from').length === 10 ? url.searchParams.get('from') + 'T00:00' : url.searchParams.get('from')) : now - DAY;
      const to = url.searchParams.get('to') ? parseTime(url.searchParams.get('to').length === 10 ? url.searchParams.get('to') + 'T00:00' : url.searchParams.get('to')) : from + 14 * DAY;
      if (to <= from || to - from > MAX_RANGE_DAYS * DAY) throw new AgentCalError(400, 'range must be positive and at most ' + MAX_RANGE_DAYS + ' days');
      const cals = await resolved(env);
      const alias = url.searchParams.get('calendar');
      const list = alias ? [pick(cals, alias)] : cals.filter((c) => c.url);
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const events = [], errors = [];
      await Promise.all(list.map(async (c) => {
        try {
          for (const t of await calendarObjects(env, c.url, new Date(from), new Date(to))) {
            for (const e of expandICS(t, { name: c.name }, new Date(from), new Date(to))) {
              const uid = e.id; // recurring occurrences are "uid@occurrence"
              events.push({ uid, calendar: c.alias, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.loc, description: e.notes, managed: AGENT_UID.test(uid) });
            }
          }
        } catch (err) { errors.push(c.alias + ': ' + err.message); }
      }));
      const out = events.filter((e) => !q || (e.title + ' ' + (e.description || '')).toLowerCase().includes(q));
      out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      return { status: 200, body: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), events: out, errors } };
    }
    const one = /^\/agent\/events\/([^/]+)$/.exec(p);
    if (one && (m === 'PUT' || m === 'DELETE')) {
      const uid = decodeURIComponent(one[1]);
      if (!AGENT_UID.test(uid)) throw new AgentCalError(403, 'agents can only change their own events (uid starting with "hb-")');
      const cals = await resolved(env);
      if (m === 'PUT') {
        let ev;
        try { ev = await req.json(); } catch { throw new AgentCalError(400, 'body must be JSON'); }
        const cal = pick(cals, ev.calendar);
        if (!canWrite(cal, person)) throw new AgentCalError(403, 'calendar "' + cal.alias + '" is read-only for ' + (person || 'this caller'));
        const ics = agentICS(uid, ev, Date.now(), { person, agent });
        await putEvent(env, hrefFor(cal, uid), ics);
        // Same uid on another calendar = the event moved (e.g. someone else covers it now).
        const movedFrom = [];
        for (const c of cals) {
          if (c === cal || !c.url || !canWrite(c, person)) continue;
          if (await deleteEvent(env, hrefFor(c, uid))) movedFrom.push(c.alias);
        }
        ctx.waitUntil(env.DATA.delete('events'));
        return { status: 200, body: { ok: true, uid, calendar: cal.alias, ...(movedFrom.length ? { movedFrom } : {}) } };
      }
      const alias = url.searchParams.get('calendar');
      const targets = alias ? [pick(cals, alias)] : cals.filter((c) => c.url && canWrite(c, person));
      const deleted = [];
      for (const c of targets) {
        if (!canWrite(c, person)) throw new AgentCalError(403, 'calendar "' + c.alias + '" is read-only for ' + (person || 'this caller'));
        if (await deleteEvent(env, hrefFor(c, uid))) deleted.push(c.alias);
      }
      if (!deleted.length) throw new AgentCalError(404, 'no agent event "' + uid + '" (agents can only delete events they created)');
      ctx.waitUntil(env.DATA.delete('events'));
      return { status: 200, body: { ok: true, uid, deletedFrom: deleted } };
    }
    return { status: 404, body: { error: 'not found' } };
  } catch (e) {
    if (e instanceof AgentCalError) return { status: e.status, body: { error: e.message } };
    return { status: 502, body: { error: e.message } };
  }
}
