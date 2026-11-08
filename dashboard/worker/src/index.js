// frame-data Worker: the frame's only data source for calendars, Reminders lists and photos.
//   GET  /events     ?key=READ_KEY  iCloud events, cached EVENTS_TTL seconds in KV
//   GET  /calendars  ?key=READ_KEY  calendar names visible to the Apple ID (setup aid)
//   GET  /reminders  ?key=READ_KEY  lists last pushed by the iPhone Shortcut
//   GET  /photos     ?key=READ_KEY  photos in the iCloud Shared Album(s) in secret PHOTO_ALBUM
//   GET  /photo      ?key=READ_KEY&id=GUID&s=l|s  the image itself (proxied; iCloud's URLs expire)
//   POST /reminders  Authorization: Bearer PUSH_TOKEN (Home Assistant pulls GET /reminders; ../ha/README.md)
//   GET  anything else: the dashboard itself (../dist, Workers static assets), for the frame only.
//        The kiosk opens /?key=READ_KEY once; that sets a cookie that covers the page's own files.
// Secrets: ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD, READ_KEY, PUSH_TOKEN, PHOTO_ALBUM.
// Secret CALENDARS: {"Calendar name": ["person id", ...]} as JSON; only these calendars are read.
// Person ids match VITE_PEOPLE in the dashboard's .env.local.
import { listCalendars, calendarObjects } from './icloud.js';
import { expandICS } from './ics.js';
import { readAlbum } from './photos.js';

const DAY = 864e5;
const EVENTS_TTL = 300;
const PHOTOS_TTL = 600; // iCloud's signed image URLs last ~15-20 min; /photo refreshes on expiry anyway
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Frame-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const canRead = (req, url, env) => same(req.headers.get('X-Frame-Key') || url.searchParams.get('key') || '', env.READ_KEY);
const cookieKey = (req) => {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)frame_key=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
const canPush = (req, env) => same((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.PUSH_TOKEN);

// Case-insensitive, and Apple's curly apostrophe (Alex’s Calendar) matches a typed straight one.
const calKey = (name) => String(name).trim().toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");

function calendarMap(env) {
  const m = typeof env.CALENDARS === 'string' ? JSON.parse(env.CALENDARS) : env.CALENDARS || {};
  const out = new Map();
  for (const [name, people] of Object.entries(m)) out.set(calKey(name), { name, people });
  return out;
}

export async function fetchEvents(env, now = new Date()) {
  const from = new Date(now.getTime() - 7 * DAY), to = new Date(now.getTime() + 45 * DAY);
  const wanted = calendarMap(env);
  const cals = (await listCalendars(env)).filter((c) => wanted.has(calKey(c.name)));
  const missing = [...wanted.values()].filter((w) => !cals.some((c) => calKey(c.name) === calKey(w.name))).map((w) => w.name);
  const events = [], errors = [];
  await Promise.all(cals.map(async (c) => {
    const meta = { name: c.name, people: wanted.get(calKey(c.name)).people };
    try {
      for (const t of await calendarObjects(env, c.url, from, to)) events.push(...expandICS(t, meta, from, to));
    } catch (e) { errors.push(c.name + ': ' + e.message); }
  }));
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { updated: now.toISOString(), from: from.toISOString(), to: to.toISOString(), events, missing, errors };
}

async function events(env, ctx) {
  const cached = await env.DATA.get('events', 'json');
  if (cached && Date.now() - Date.parse(cached.updated) < EVENTS_TTL * 1000) return json(cached);
  try {
    const fresh = await fetchEvents(env);
    if (!fresh.errors.length) ctx.waitUntil(env.DATA.put('events', JSON.stringify(fresh)));
    return json(fresh);
  } catch (e) {
    if (cached) return json({ ...cached, stale: true, errors: [e.message] });
    return json({ error: e.message }, 502);
  }
}

function cleanList(items) {
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

async function pushReminders(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  // Accept {"lists": {...}} or the lists flat at the top level: {"Grocery list": "milk\neggs"}.
  const lists = body && typeof body === 'object' ? (body.lists && typeof body.lists === 'object' ? body.lists : body) : null;
  if (!lists || Array.isArray(lists)) return json({ error: 'expected {"List name": "item\\nitem"} or {"lists": {"List name": [...]}}' }, 400);
  const out = { updated: new Date().toISOString(), lists: {} };
  for (const [name, items] of Object.entries(lists).slice(0, 10)) out.lists[String(name).slice(0, 60)] = cleanList(items);
  await env.DATA.put('reminders', JSON.stringify(out));
  return json({ ok: true, counts: Object.fromEntries(Object.entries(out.lists).map(([k, v]) => [k, v.length])) });
}

// PHOTO_ALBUM: one or more shared album links, separated by spaces, commas or new lines.
async function albumData(env, force) {
  const cached = await env.DATA.get('photos', 'json');
  if (!force && cached && Date.now() - Date.parse(cached.updated) < PHOTOS_TTL * 1000) return cached;
  const links = String(env.PHOTO_ALBUM || '').split(/[\s,]+/).filter(Boolean);
  if (!links.length) return { updated: new Date().toISOString(), photos: [] };
  try {
    const seen = new Set(), photos = [];
    for (const link of links) {
      for (const p of (await readAlbum(link)).photos) if (!seen.has(p.id)) { seen.add(p.id); photos.push(p); }
    }
    const out = { updated: new Date().toISOString(), photos };
    await env.DATA.put('photos', JSON.stringify(out));
    return out;
  } catch (e) {
    if (cached) return { ...cached, stale: true };
    throw e;
  }
}

async function photoList(env) {
  const d = await albumData(env);
  return json({ updated: d.updated, stale: !!d.stale, photos: d.photos.map(({ url, ...p }) => p) });
}

async function photoImage(url, env) {
  const id = url.searchParams.get('id'), size = url.searchParams.get('s') === 's' ? 's' : 'l';
  for (const force of [false, true]) {
    const p = (await albumData(env, force)).photos.find((x) => x.id === id);
    if (!p) return json({ error: 'no such photo' }, 404);
    const r = await fetch(p.url[size] || p.url.l);
    if (r.ok) {
      return new Response(r.body, {
        headers: { ...CORS, 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=2592000, immutable' },
      });
    }
    // Signed URL expired: refresh the album once and retry.
  }
  return json({ error: 'image unavailable' }, 502);
}

// The built dashboard bakes in READ_KEY, so it is only served to the frame.
async function dashboard(req, url, env) {
  const viaQuery = same(url.searchParams.get('key') || '', env.READ_KEY);
  if (!viaQuery && !same(cookieKey(req), env.READ_KEY)) {
    return new Response('Not authorised', { status: 401, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
  const assetUrl = new URL(url);
  assetUrl.search = '';
  const res = await env.ASSETS.fetch(new Request(assetUrl, req));
  if (!viaQuery) return res;
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.append('Set-Cookie', `frame_key=${encodeURIComponent(env.READ_KEY)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`);
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'POST' && url.pathname === '/reminders') {
      return canPush(req, env) ? pushReminders(req, env) : json({ error: 'unauthorized' }, 401);
    }
    if (req.method !== 'GET') return json({ error: 'not found' }, 404);
    if (!['/events', '/calendars', '/reminders', '/photos', '/photo'].includes(url.pathname)) return dashboard(req, url, env);
    if (!canRead(req, url, env)) return json({ error: 'unauthorized' }, 401);
    try {
      if (url.pathname === '/events') return await events(env, ctx);
      if (url.pathname === '/photos') return await photoList(env);
      if (url.pathname === '/photo') return await photoImage(url, env);
      if (url.pathname === '/calendars') return json((await listCalendars(env)).map((c) => ({ name: c.name, shared: c.shared })));
      return json((await env.DATA.get('reminders', 'json')) || { updated: null, lists: {} });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};
