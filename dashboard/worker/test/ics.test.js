import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandICS } from '../src/ics.js';

const TZ = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;
const cal = (body) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:test\n${TZ}\n${body}\nEND:VCALENDAR`.replace(/\n/g, '\r\n');
const meta = { name: 'Family', people: ['alex', 'jordan'] };
const from = new Date('2026-10-26T00:00:00Z'), to = new Date('2026-11-16T00:00:00Z');

test('weekly repeat across DST with a moved and a deleted occurrence', () => {
  const ics = cal(`BEGIN:VEVENT
UID:yoga
SUMMARY:Yoga
DTSTART;TZID=America/New_York:20261001T183000
DTEND;TZID=America/New_York:20261001T193000
RRULE:FREQ=WEEKLY
EXDATE;TZID=America/New_York:20261105T183000
END:VEVENT
BEGIN:VEVENT
UID:yoga
RECURRENCE-ID;TZID=America/New_York:20261029T183000
SUMMARY:Yoga (late)
DTSTART;TZID=America/New_York:20261029T200000
DTEND;TZID=America/New_York:20261029T210000
END:VEVENT`);
  const ev = expandICS(ics, meta, from, to);
  assert.deepEqual(ev.map((e) => [e.title, e.start]), [
    ['Yoga (late)', '2026-10-30T00:00:00.000Z'],
    ['Yoga', '2026-11-12T23:30:00.000Z'],
  ]);
  assert.deepEqual(ev[0].people, ['alex', 'jordan']);
});

test('all-day stays a date; cancelled and out-of-range events are dropped', () => {
  const ics = cal(`BEGIN:VEVENT
UID:trip
SUMMARY:Trip
DTSTART;VALUE=DATE:20261107
DTEND;VALUE=DATE:20261110
END:VEVENT
BEGIN:VEVENT
UID:x
SUMMARY:Cancelled
STATUS:CANCELLED
DTSTART:20261101T150000Z
DTEND:20261101T160000Z
END:VEVENT
BEGIN:VEVENT
UID:old
SUMMARY:Old
DTSTART:20260101T150000Z
DTEND:20260101T160000Z
END:VEVENT`);
  const ev = expandICS(ics, meta, from, to);
  assert.deepEqual(ev.map((e) => [e.title, e.allDay, e.start, e.end]), [['Trip', true, '2026-11-07', '2026-11-10']]);
});
