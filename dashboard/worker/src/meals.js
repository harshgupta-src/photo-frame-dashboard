// The dog's meals on the family calendars (WALK_PLAN_CALENDARS: one event per meal, written by people or
// Muse, e.g. "Maya · Lunch" or "Maya lunch 1 cup"). Home Assistant's planner moves and reassigns them
// when calendars change; once a meal is fed it moves to the Life Log calendar (LOG_CALENDAR).
//   GET    /meals?date=YYYY-MM-DD    the day's meal events: kind, start, usual time, calendar, people
//   PUT    /meals/plan/:date         {meals: [{kind, start, people?, note?}], reason?}: moves events in
//                                    place (same UID and file name) and into the feeders' calendar
//   POST   /meals/log                {id, person, at, planned_at?, delta_min?, cups?, purina_pct?,
//                                    fortiflora?, ate?, source?}: writes the Life Log event, stashes and
//                                    removes the planned one (posting again just rewrites the Life Log event)
//   DELETE /meals/log/:id            undo: removes the Life Log event, puts the planned one back
// Meal ids match Home Assistant's: maya_meal-YYYY-MM-DD-<breakfast|walk-snack|lunch|dinner|night-snack>.
// A moved event keeps its regular time in X-MAYA-USUAL, so the planner can bring it back there. An
// occurrence of a recurring series is taken out of it (EXDATE) and becomes its own event when it moves,
// or when it is fed.
import ICAL from 'ical.js';
import { calendarEntries, putEvent, deleteEvent } from './icloud.js';
import { expandICS } from './ics.js';
import { WalkError, localDate, localHM } from './walks.js';
import { when, validDate, planCalendarName } from './walkplan.js';
import { WalkStore, household } from './walkstore.js';
import { logCalendarName } from './dogapi.js';

export const KINDS = { breakfast: 'Breakfast', 'walk-snack': 'Walk snack', lunch: 'Lunch', dinner: 'Dinner', 'night-snack': 'Night snack' };
const DAY = 864e5;
const MARK = '⏰ ';
const ID = /^maya_meal-(\d{4}-\d{2}-\d{2})-([a-z0-9-]{3,40})$/;
const PEOPLE = /^[a-z][a-z0-9_-]{0,31}$/;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const nextDate = (d) => new Date(Date.parse(d + 'T12:00:00Z') + DAY).toISOString().slice(0, 10);

// Same rules as Home Assistant's sensor.maya_meal_plan: the title starts with the dog's name, isn't
// "prep", and names a meal; a plain "snack" before 3 PM is the walk snack, later the night snack.
export function mealKind(title, hour, dog = 'Maya') {
  const t = String(title || '').toLowerCase();
  if (!new RegExp('^\\s*' + dog.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t) || /\bprep\b/.test(t)) return null;
  const m = /breakfast|lunch|dinner|walk snack|night snack|snack/.exec(t);
  if (!m) return null;
  return (m[0] === 'snack' ? (hour < 15 ? 'walk snack' : 'night snack') : m[0]).replace(' ', '-');
}
export function normKind(k) {
  const s = String(k || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return KINDS[s] ? s : null;
}

// "1 1/4" / "0.5" → number; number → "1 1/4".
export function cupsOf(title, notes) {
  const amount = (s) => {
    const m = /^\s*(?:(\d+)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*$/.exec(s || '');
    return m ? Math.round(((m[1] ? +m[1] : 0) + (m[3] ? +m[2] / +m[3] : +m[2])) * 100) / 100 : null;
  };
  const d = /cups?\s*:\s*([0-9./ ]+)/i.exec(notes || ''), t = /((?:\d+\s+)?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*cups?\b/i.exec(title || '');
  return d ? amount(d[1]) : t ? amount(t[1]) : null;
}
export function fmtCups(c) {
  const n = Number(c);
  if (!Number.isFinite(n) || n <= 0) return null;
  const whole = Math.floor(n + 1e-9), f = n - whole;
  const frac = [[0, ''], [0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2'], [2 / 3, '2/3'], [0.75, '3/4'], [1, '']].find(([v]) => Math.abs(f - v) < 0.02);
  const s = !frac ? String(Math.round(n * 100) / 100) : frac[0] === 1 ? String(whole + 1) : [whole || '', frac[1]].filter(Boolean).join(' ');
  return s + (n > 1 ? ' cups' : ' cup');
}

// Calendars that can hold meals: WALK_PLAN_CALENDARS (people → calendar), else CALENDARS.
export function mealCalendars(env) {
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v || {}; } catch { return {}; } };
  const out = new Map();
  for (const [key, name] of Object.entries(parse(env.WALK_PLAN_CALENDARS))) if (!out.has(name)) out.set(name, key.split('+'));
  if (!out.size) for (const [name, people] of Object.entries(parse(env.CALENDARS))) if (Array.isArray(people)) out.set(name, people);
  return [...out].map(([name, people]) => ({ name, people }));
}

const icsProp = (ics, name) => { const m = new RegExp('^' + name + '(?:;[^:\\r\\n]*)?:([^\\r\\n]*)', 'mi').exec(ics); return m ? m[1].trim() : null; };
const uidOf = (ics) => icsProp(ics, 'UID');

// A description with our planner line (MARK…) replaced by line (or dropped).
export function withLine(desc, line) {
  const rest = String(desc || '').split('\n').filter((l) => !l.startsWith(MARK)).join('\n').trim();
  return [rest, line ? MARK + line : ''].filter(Boolean).join('\n\n');
}

// The event moved to [start, end) (UTC), its regular time kept in X-MAYA-USUAL, description set.
export function moveICS(ics, { start, end, usual, desc }, now) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const v = root.getFirstSubcomponent('vevent');
  const utc = (ms) => ICAL.Time.fromJSDate(new Date(ms), true);
  for (const p of ['dtstart', 'dtend', 'duration', 'description', 'dtstamp', 'last-modified']) v.removeAllProperties(p);
  v.addPropertyWithValue('dtstart', utc(start));
  v.addPropertyWithValue('dtend', utc(end));
  v.addPropertyWithValue('dtstamp', utc(now));
  v.addPropertyWithValue('last-modified', utc(now));
  if (desc) v.addPropertyWithValue('description', desc);
  if (usual && !v.hasProperty('x-maya-usual')) v.addPropertyWithValue('x-maya-usual', usual);
  v.updatePropertyWithValue('sequence', (parseInt(v.getFirstPropertyValue('sequence'), 10) || 0) + 1);
  return root.toString() + '\r\n';
}

// A recurring series without one occurrence (occ: its recurrence time as ical.js prints it): an EXDATE,
// and any override of that occurrence dropped.
export function exdateICS(ics, occ, now) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const all = root.getAllSubcomponents('vevent'), master = all.find((v) => !v.hasProperty('recurrence-id'));
  if (!master) throw new WalkError('recurring event without a master', 409);
  for (const v of all) if (v !== master && String(v.getFirstPropertyValue('recurrence-id')) === occ) root.removeSubcomponent(v);
  const p = new ICAL.Property('exdate', master), tzid = master.getFirstProperty('dtstart').getParameter('tzid');
  p.setValue(ICAL.Time.fromString(occ));
  if (tzid && !/Z$/.test(occ)) p.setParameter('tzid', tzid);
  master.addProperty(p);
  const utc = ICAL.Time.fromJSDate(new Date(now), true);
  master.updatePropertyWithValue('dtstamp', utc);
  master.updatePropertyWithValue('last-modified', utc);
  master.updatePropertyWithValue('sequence', (parseInt(master.getFirstPropertyValue('sequence'), 10) || 0) + 1);
  return root.toString() + '\r\n';
}

// A standalone planned meal (an occurrence taken out of a recurring series so it can move on its own).
export function mealICS(uid, ev, now) {
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', '-//photo-frame-dashboard//meal-plan//EN');
  const v = new ICAL.Component('vevent');
  const utc = (ms) => ICAL.Time.fromJSDate(new Date(ms), true);
  v.addPropertyWithValue('uid', uid);
  v.addPropertyWithValue('dtstamp', utc(now));
  v.addPropertyWithValue('dtstart', utc(ev.start));
  v.addPropertyWithValue('dtend', utc(ev.end));
  v.addPropertyWithValue('summary', ev.title);
  if (ev.desc) v.addPropertyWithValue('description', ev.desc);
  if (ev.usual) v.addPropertyWithValue('x-maya-usual', ev.usual);
  root.addSubcomponent(v);
  return root.toString() + '\r\n';
}

// The Life Log event for a fed meal (the frame's dog tab reads "Maya lunch … 1 cup — Harsh" as fed).
export function logICS(id, ev, now) {
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.updatePropertyWithValue('version', '2.0');
  root.updatePropertyWithValue('prodid', '-//photo-frame-dashboard//meal-log//EN');
  const v = new ICAL.Component('vevent');
  const utc = (ms) => ICAL.Time.fromJSDate(new Date(ms), true);
  v.addPropertyWithValue('uid', id + '@frame-data');
  v.addPropertyWithValue('dtstamp', utc(now));
  v.addPropertyWithValue('dtstart', utc(ev.start));
  v.addPropertyWithValue('dtend', utc(ev.end));
  v.addPropertyWithValue('summary', ev.title);
  v.addPropertyWithValue('description', ev.desc);
  v.addPropertyWithValue('categories', ev.category);
  root.addSubcomponent(v);
  return root.toString() + '\r\n';
}

export function mealRoute(req, url, env, ctx, access) {
  return new MealStore(env, ctx).route(req, url, access);
}

export class MealStore {
  constructor(env, ctx) {
    this.env = env;
    this.ws = new WalkStore(env, ctx);
  }

  async route(req, url, access) {
    const p = url.pathname, m = req.method;
    const deny = (what) => (access[what] ? null : { status: 401, body: { error: 'unauthorized' } });
    const run = async (fn) => {
      try { return { status: 200, body: await fn() }; } catch (e) {
        return { status: e instanceof WalkError ? e.status : 500, body: { error: String(e.message || e) } };
      }
    };
    const withBody = async (fn) => {
      if (!access.write) return deny('write');
      let b = null;
      try { b = JSON.parse((await req.text()) || '{}'); } catch { /* not JSON */ }
      return b && typeof b === 'object' ? run(() => fn(b)) : { status: 400, body: { error: 'body must be JSON' } };
    };
    if (p === '/meals' && m === 'GET') return deny('read') || run(() => this.get(url.searchParams.get('date')));
    const plan = /^\/meals\/plan\/([0-9-]{10})$/.exec(p);
    if (plan && m === 'PUT') return withBody((b) => this.putPlan(plan[1], b));
    if (p === '/meals/log' && m === 'POST') return withBody((b) => this.log(b));
    const one = /^\/meals\/log\/([A-Za-z0-9_-]{6,80})$/.exec(p);
    if (one && m === 'DELETE') return deny('write') || run(() => this.unlog(one[1]));
    return { status: 404, body: { error: 'not found' } };
  }

  async home() {
    if (!this._home) {
      const walks = await this.ws.walks(Date.now() - 30 * DAY).catch(() => []);
      const h = household(walks);
      this._home = { tz: h.tz === 'UTC' && this.env.TZ ? this.env.TZ : h.tz, dog: h.dog === 'Dog' ? (this.env.DOG_NAME || 'Maya') : h.dog };
    }
    return this._home;
  }

  async calUrl(name, fresh = false) { return this.ws.calendarUrl(fresh, name); }

  // A write that fails once is retried with the calendar's URL looked up again (it can move).
  async put(name, file, ics) {
    let url = await this.calUrl(name);
    try { await putEvent(this.env, url + file, ics); } catch {
      url = await this.calUrl(name, true);
      await putEvent(this.env, url + file, ics);
    }
    return url + file;
  }

  // The day's meal events, one per kind (single events before series occurrences, then the most recently changed), plus extras.
  async day(date) {
    if (!validDate(date)) throw new WalkError('date must be YYYY-MM-DD');
    const { tz, dog } = await this.home();
    const from = when(date + 'T00:00', date, tz, 'day'), to = when(nextDate(date) + 'T00:00', date, tz, 'day');
    const all = [];
    for (const cal of mealCalendars(this.env)) {
      let rows;
      try { rows = await calendarEntries(this.env, await this.calUrl(cal.name), new Date(from), new Date(to)); } catch (e) {
        rows = await calendarEntries(this.env, await this.calUrl(cal.name, true), new Date(from), new Date(to));
      }
      for (const r of rows) {
        const recurring = /^RRULE[:;]/m.test(r.ics);
        for (const o of expandICS(r.ics, cal, new Date(from), new Date(to))) {
          if (o.allDay) continue;
          const at = Date.parse(o.start), kind = mealKind(o.title, +localHM(at, tz).slice(0, 2), dog);
          if (!kind || localDate(at, tz) !== date) continue;
          all.push({
            id: 'maya_meal-' + date + '-' + kind, kind, meal: KINDS[kind], title: o.title, start: o.start, end: o.end,
            usual: icsProp(r.ics, 'X-MAYA-USUAL') || localHM(at, tz), moved: false, calendar: cal.name, people: cal.people,
            cups: cupsOf(o.title, o.notes), notes: o.notes || null, uid: uidOf(r.ics), recurring,
            occ: recurring ? o.id.slice(o.id.lastIndexOf('@') + 1) : null,
            modified: icsProp(r.ics, 'LAST-MODIFIED') || icsProp(r.ics, 'DTSTAMP') || '', href: r.href, ics: r.ics,
          });
        }
      }
    }
    const byKind = new Map();
    for (const x of all) (byKind.get(x.kind) || byKind.set(x.kind, []).get(x.kind)).push(x);
    const meals = [], dupes = [];
    for (const list of byKind.values()) {
      list.sort((a, b) => (a.recurring - b.recurring) || (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      meals.push(list[0]);
      dupes.push(...list.slice(1));
    }
    for (const x of meals) x.moved = x.usual !== localHM(Date.parse(x.start), tz);
    meals.sort((a, b) => (a.start < b.start ? -1 : 1));
    return { date, tz, dog, meals, dupes };
  }

  async get(date) {
    const d = await this.day(date);
    const pub = ({ href, ics, modified, occ, ...x }) => x;
    return { date: d.date, tz: d.tz, meals: d.meals.map(pub), duplicates: d.dupes.map(pub) };
  }

  async putPlan(date, body) {
    if (!body || !Array.isArray(body.meals)) throw new WalkError('body must be {"meals": [...]}');
    const d = await this.day(date), now = Date.now(), reason = clean(body.reason, 200);
    const byKind = new Map(d.meals.map((x) => [x.kind, x]));
    const out = { date, changed: [], unchanged: [], skipped: [] };
    for (const it of body.meals.slice(0, 10)) {
      const kind = normKind(it && (it.kind || it.meal));
      const m = kind && byKind.get(kind);
      if (!m) { out.skipped.push({ kind: (it && (it.kind || it.meal)) || null, why: 'no meal event that day' }); continue; }
      const start = when(it.start, date, d.tz, kind + ' start');
      if (localDate(start, d.tz) !== date) { out.skipped.push({ kind, why: 'start is not on ' + date }); continue; }
      const oldStart = Date.parse(m.start), end = start + Math.max(5 * 60e3, Date.parse(m.end) - oldStart);
      const people = [...new Set((Array.isArray(it.people) ? it.people : it.people ? [it.people] : []).map((p) => String(p).toLowerCase()).filter((p) => PEOPLE.test(p)))];
      const calendar = (people.length && planCalendarName(this.env, people)) || m.calendar;
      const hm = localHM(start, d.tz), note = clean(it.note, 200) || reason;
      const line = hm !== m.usual ? 'Moved from the usual ' + m.usual + (note ? ': ' + note : '') : null;
      const desc = withLine(m.notes, line);
      if (start === oldStart && calendar === m.calendar && desc === String(m.notes || '').trim()) { out.unchanged.push(kind); continue; }
      if (m.recurring) {
        // Its own event from now on (created before the series loses it).
        await this.put(calendar, 'maya-meal-plan-' + date + '-' + kind + '.ics', mealICS('maya-meal-plan-' + date + '-' + kind + '@frame-data', { start, end, title: m.title, desc, usual: m.usual }, now));
        await putEvent(this.env, m.href, exdateICS(m.ics, m.occ, now));
      } else {
        const ics = moveICS(m.ics, { start, end, usual: m.usual, desc }, now);
        const file = m.href.slice(m.href.lastIndexOf('/') + 1);
        if (calendar === m.calendar) await putEvent(this.env, m.href, ics);
        else { await this.put(calendar, file, ics); await deleteEvent(this.env, m.href); }
      }
      // The same event (same UID) left behind on another calendar, e.g. by an agent re-writing it.
      for (const x of d.dupes) if (x.kind === kind && x.uid && x.uid === m.uid && x.href !== m.href) await deleteEvent(this.env, x.href);
      out.changed.push({ kind, from: m.start, to: new Date(start).toISOString(), usual: m.usual, fromCalendar: m.calendar, calendar });
    }
    return out;
  }

  async log(body) {
    const id = String(body.id || ''), m = ID.exec(id);
    if (!m) throw new WalkError('id must look like maya_meal-YYYY-MM-DD-<meal>');
    const [, date, slug] = m, kind = normKind(slug), now = Date.now();
    const { tz, dog } = await this.home();
    const key = 'meal-log:' + id, stash = (this.env.DATA && await this.env.DATA.get(key, 'json')) || {};
    // Logging again (e.g. "left some") only needs what changed.
    const b = { ...(stash.body || {}), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null && v !== '')) };
    const at = b.at == null ? now : when(b.at, date, tz, 'at');
    let planned = stash.planned || null, fresh = null;
    if (kind && !planned) {
      const x = (await this.day(date)).meals.find((y) => y.kind === kind);
      if (x) fresh = planned = { href: x.href, ics: x.ics, occ: x.occ, calendar: x.calendar, people: x.people, start: x.start, end: x.end, title: x.title, usual: x.usual, notes: x.notes };
    }
    const person = clean(b.person, 32).toLowerCase() || 'someone', who = cap(person);
    const plannedAt = b.planned_at ? when(b.planned_at, date, tz, 'planned_at') : planned ? Date.parse(planned.start) : null;
    const delta = Number.isFinite(+b.delta_min) && b.delta_min !== null && b.delta_min !== '' ? Math.round(+b.delta_min) : plannedAt != null ? Math.round((at - plannedAt) / 60e3) : null;
    const cups = b.cups != null && b.cups !== '' && Number.isFinite(+b.cups) ? +b.cups : planned ? cupsOf(planned.title, planned.notes) : null;
    const t12 = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
    const label = kind ? KINDS[kind].toLowerCase() : 'extra meal';
    const food = [fmtCups(cups), b.purina_pct != null && b.purina_pct !== '' ? b.purina_pct + '% Purina' : null,
      b.fortiflora != null && b.fortiflora !== '' ? b.fortiflora + ' FortiFlora' : null].filter(Boolean).join(' · ');
    const late = delta == null ? '' : delta === 0 ? ', on time' : ', ' + Math.abs(delta) + ' min ' + (delta > 0 ? 'late' : 'early');
    const desc = [
      'Fed by: ' + who,
      'Fed at: ' + t12(at) + (plannedAt != null ? ' (planned ' + t12(plannedAt) + late + ')' : ' (not planned)'),
      planned ? 'Planned on: ' + planned.calendar + ' (' + planned.people.map(cap).join(' & ') + ')' + (plannedAt != null && planned.usual && planned.usual !== localHM(plannedAt, tz) ? ', usual time ' + planned.usual : '') : null,
      food ? 'Food: ' + food : null,
      cups != null ? 'cups: ' + cups : null,
      'Ate: ' + (b.ate === 'some' ? 'some (left some)' : 'all'),
      'Logged via: ' + (clean(b.source, 40) || 'home assistant') + ' · Lifelog ' + id,
      planned && planned.title ? 'Planned event: ' + planned.title : null,
    ].filter(Boolean).join('\n');
    const logName = logCalendarName(this.env);
    if (!logName) throw new WalkError('no Life Log calendar (LOG_CALENDAR / WALK_CALENDAR)', 503);
    const ics = logICS(id, {
      start: at, end: at + 15 * 60e3, desc, category: dog + ' meal',
      title: dog + ' ' + label + ' 🍽️' + (fmtCups(cups) ? ' ' + fmtCups(cups) : '') + ' — ' + who,
    }, now);
    const logHref = await this.put(logName, id + '.ics', ics);
    if (this.env.DATA) await this.env.DATA.put(key, JSON.stringify({ planned, log: { href: logHref, calendar: logName }, body: { ...b, at }, at: now }), { expirationTtl: 60 * 86400 });
    // The planned event goes (a recurring series just loses that day; undo puts the whole object back).
    if (fresh && fresh.occ) await putEvent(this.env, fresh.href, exdateICS(fresh.ics, fresh.occ, now));
    else if (fresh) await deleteEvent(this.env, fresh.href);
    await this.bust();
    return { ok: true, id, log: { calendar: logName, start: new Date(at).toISOString() }, removedFrom: fresh ? fresh.calendar : null };
  }

  async unlog(id) {
    if (!ID.test(id)) throw new WalkError('id must look like maya_meal-YYYY-MM-DD-<meal>');
    const key = 'meal-log:' + id, stash = (this.env.DATA && await this.env.DATA.get(key, 'json')) || {};
    let href = stash.log && stash.log.href;
    if (!href) { const n = logCalendarName(this.env); href = n ? (await this.calUrl(n)) + id + '.ics' : null; }
    const removed = href ? await deleteEvent(this.env, href) : false;
    let restored = null;
    if (stash.planned && stash.planned.href) {
      await putEvent(this.env, stash.planned.href, stash.planned.ics);
      restored = stash.planned.calendar;
    }
    if (this.env.DATA) await this.env.DATA.delete(key);
    await this.bust();
    return { ok: true, id, removed, restored };
  }

  // The dog tab caches the Life Log calendar for 2 minutes.
  async bust() {
    if (!this.env.DATA || !this.env.DATA.list) return;
    const { keys } = await this.env.DATA.list({ prefix: 'dog-log:' });
    for (const k of keys) await this.env.DATA.delete(k.name);
  }
}
