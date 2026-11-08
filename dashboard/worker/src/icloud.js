// iCloud calendars over CalDAV with an Apple ID + app-specific password (appleid.apple.com →
// Sign-In and Security → App-Specific Passwords). Sees calendars shared with the account too.
// Reminders lists are not readable this way (iOS 13+ moved them off CalDAV).
import { XMLParser } from 'fast-xml-parser';

const ROOT = 'https://caldav.icloud.com/';
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });
const arr = (x) => (x == null || x === '' ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x && typeof x === 'object' ? x['#text'] : x);

export class ICloudError extends Error {}

// Case-insensitive, and Apple's curly apostrophe (Alex’s Calendar) matches a typed straight one.
export const calKey = (name) => String(name).trim().toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");

async function dav(env, method, url, body, depth) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: 'Basic ' + btoa(env.ICLOUD_APPLE_ID + ':' + env.ICLOUD_APP_PASSWORD),
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: String(depth),
    },
    body,
  });
  if (r.status === 401 || r.status === 403) throw new ICloudError('iCloud rejected the Apple ID or app-specific password');
  if (!r.ok && r.status !== 207) throw new ICloudError('iCloud HTTP ' + r.status + ' on ' + method);
  const ms = xml.parse(await r.text()).multistatus;
  return arr(ms && ms.response).map((res) => ({
    href: text(res.href),
    prop: Object.assign({}, ...arr(res.propstat)
      .filter((p) => !p.status || / 200 /.test(text(p.status)))
      .map((p) => p.prop || {})),
  }));
}

async function calendarHome(env) {
  const p1 = await dav(env, 'PROPFIND', ROOT, `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`, 0);
  const principal = p1[0] && p1[0].prop['current-user-principal'];
  if (!principal) throw new ICloudError('iCloud: no account principal');
  const p2 = await dav(env, 'PROPFIND', new URL(text(principal.href), ROOT).href,
    `<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, 0);
  const homeSet = p2[0] && p2[0].prop['calendar-home-set'];
  if (!homeSet) throw new ICloudError('iCloud: no calendar home');
  return new URL(text(homeSet.href), ROOT).href;
}

// Event calendars on the account (own + shared-with-me), skipping Reminders lists and inboxes.
export async function listCalendars(env) {
  const home = await calendarHome(env);
  const rows = await dav(env, 'PROPFIND', home,
    `<d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/></d:prop></d:propfind>`, 1);
  return rows.filter((c) => {
    const rt = c.prop.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) return false;
    const comps = arr(c.prop['supported-calendar-component-set'] && c.prop['supported-calendar-component-set'].comp).map((x) => x['@_name']);
    return !comps.length || comps.includes('VEVENT');
  }).map((c) => ({
    name: String(text(c.prop.displayname) || 'Untitled'),
    url: new URL(c.href, home).href,
    color: /^#[0-9a-f]{6}/i.test(String(text(c.prop['calendar-color']) || '')) ? String(text(c.prop['calendar-color'])).slice(0, 7) : null,
    shared: 'shared' in (c.prop.resourcetype || {}) || 'shared-owner' in (c.prop.resourcetype || {}),
  }));
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

// Raw VCALENDAR texts for objects with an occurrence in [from, to). Recurring masters come back
// unexpanded; ics.js expands them.
export async function calendarObjects(env, url, from, to) {
  const rows = await dav(env, 'REPORT', url,
    `<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`, 1);
  return rows.map((r) => text(r.prop['calendar-data'])).filter((t) => typeof t === 'string' && t.includes('BEGIN:VEVENT'));
}

const basic = (env) => 'Basic ' + btoa(env.ICLOUD_APPLE_ID + ':' + env.ICLOUD_APP_PASSWORD);

// Writes one event (the whole VCALENDAR text) to href, creating or replacing it. Needs write access
// to the calendar (own, or shared with "can edit").
export async function putEvent(env, href, ics) {
  const r = await fetch(href, { method: 'PUT', headers: { Authorization: basic(env), 'Content-Type': 'text/calendar; charset=utf-8' }, body: ics });
  if (r.status === 401 || r.status === 403) throw new ICloudError('iCloud refused the write (' + r.status + '): read-only calendar or bad password');
  if (!r.ok) throw new ICloudError('iCloud HTTP ' + r.status + ' on PUT');
  return r.headers.get('ETag');
}

// Deletes an event; one that is already gone counts as deleted.
export async function deleteEvent(env, href) {
  const r = await fetch(href, { method: 'DELETE', headers: { Authorization: basic(env) } });
  if (r.status === 404 || r.status === 410) return;
  if (!r.ok) throw new ICloudError('iCloud HTTP ' + r.status + ' on DELETE');
}
