// Expands iCalendar text into plain event JSON for the frame.
import ICAL from 'ical.js';

const pad = (n) => String(n).padStart(2, '0');
const dateOnly = (t) => t.year + '-' + pad(t.month) + '-' + pad(t.day);
const MAX_OCCURRENCES = 2000;

// One CalDAV object (or a whole .ics feed) → events overlapping [from, to).
// All-day dates stay 'YYYY-MM-DD' (end exclusive) so the frame reads them in its own time zone.
export function expandICS(icsText, cal, from, to) {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const id = tz.getFirstPropertyValue('tzid');
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
  }
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
    const sMs = s.toJSDate().getTime(), eMs = e.toJSDate().getTime();
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
    const it = ev.iterator();
    for (let n = 0, next; (next = it.next()) && n < MAX_OCCURRENCES; n++) {
      if (next.toJSDate().getTime() >= toMs) break;
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate, ev.uid + '@' + next.toString());
    }
  }
  return out;
}
