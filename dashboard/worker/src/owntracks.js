// OwnTracks (iOS, HTTP mode) → precise GPS for the dog's walks; docs in ../../WALKS.md "OwnTracks".
//   POST /owntracks                  the phones' OwnTracks posts (Basic auth, per person)
//   GET  /owntracks/setup/<user>     a page with an "Install in OwnTracks" link (READ_KEY)
// A location fix is kept only while a walk with that person is out (or, for fixes the phone queued
// offline, when its time falls inside such a walk): KV ot:pts:<walk id>:<walker>, 3 days. Everything
// else is dropped. The answer switches the phone's monitoring mode: move (2, continuous GPS) while
// that person is on a walk, significant changes (1) otherwise, sent only when the mode must change.
// Secrets: OWNTRACKS_USERS {"<user>": {"password": "…", "walker": "<person id>"}}, OWNTRACKS_HOME
// "lat,lon" (the home region in the setup config), optional OWNTRACKS_URL (the public URL of POST /owntracks;
// default: the workers.dev host the Cloudflare proxy forwards for, else this request's origin).
import { WalkStore, Lifelog } from './walkstore.js';
import { normalizeRoute } from './walks.js';

const DAY = 864e5;
const TTL_S = 3 * 86400;
export const MAX_POINTS = 2000; // per walker and walk: > 5 h of fixes every 10 s
const MAX_ACC = 100; // m, worse fixes are dropped
const SLACK = 60e3; // ms around a walk's start and end
const WALKS_TTL = 120e3; // the cached walk list; walk writes through the Worker clear it
const MODE_TTL_S = 30 * 86400;
const ROUTE_MAX = 5000; // normalizeRoute's limit
export const SIGNIFICANT = 1, MOVE = 2;
export const MOVE_SETTINGS = { locatorDisplacement: 10, locatorInterval: 10 };
const HOME_RADIUS = 120;
const HOME_TST = 1763510400; // fixed, so re-installing the config updates the region instead of adding one
const WALKS_KEY = 'ot:walks';
const ptsKey = (walkId, walker) => 'ot:pts:' + walkId + ':' + walker;
const haKey = (walkId) => 'ot:ha:' + walkId;
const ID = /^[a-z0-9_-]{1,32}$/;

const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

// {user: {password, walker}} with valid entries only.
export function otUsers(env) {
  let m = env.OWNTRACKS_USERS;
  try { if (typeof m === 'string') m = JSON.parse(m); } catch { return {}; }
  const out = {};
  for (const [user, u] of Object.entries(m && typeof m === 'object' ? m : {})) {
    const walker = u && String(u.walker || '').toLowerCase();
    if (ID.test(user) && u && typeof u.password === 'string' && u.password.length >= 16 && ID.test(walker)) out[user] = { password: u.password, walker };
  }
  return out;
}

// Authorization: Basic … → {user, walker} or null.
export function otAuth(header, users, same) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!m) return null;
  let s;
  try { s = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
  const i = s.indexOf(':');
  if (i < 1) return null;
  const user = s.slice(0, i), u = Object.hasOwn(users, user) ? users[user] : null;
  // Compare against something either way, so a wrong user costs the same as a wrong password.
  const ok = same(s.slice(i + 1), u ? u.password : '\u0000'.repeat(32));
  return u && ok ? { user, walker: u.walker } : null;
}

// The walk (from recentWalks) a fix at tMs belongs to, for that walker. An active walk takes any fix
// from its start on; an ended one only fixes inside it.
export function walkAt(walks, walker, tMs) {
  return walks.find((w) => w.who.includes(walker) && tMs >= w.s - SLACK && (w.e == null || tMs <= w.e + SLACK)) || null;
}
export const wantedMode = (walks, walker) => (walks.some((w) => w.e == null && w.who.includes(walker)) ? MOVE : SIGNIFICANT);

// Send a setConfiguration when the mode last sent differs, or the phone says it is in another one.
export function needsCmd(wanted, lastSent, reported) {
  return lastSent !== wanted || (Number.isInteger(reported) && reported !== wanted);
}
export function modeCmd(mode) {
  return [{ _type: 'cmd', action: 'setConfiguration', configuration: { _type: 'configuration', monitoring: mode, ...(mode === MOVE ? MOVE_SETTINGS : {}) } }];
}

// Walks of the last 3 days as {id, s, e, who: [walker ids]}, cached in KV for WALKS_TTL. A Lifelog
// outage falls back to the stale copy.
export async function recentWalks(env, now = Date.now()) {
  const cached = await env.DATA.get(WALKS_KEY, 'json');
  if (cached && now - cached.at < WALKS_TTL) return cached.walks;
  try {
    const list = await new WalkStore(env).walks(now - 3 * DAY, { limit: 30 });
    const walks = list.filter((w) => !w.deletedAt && !w.abandoned && Number.isFinite(w.startedAt))
      .map((w) => ({ id: w.id, s: w.startedAt, e: w.endedAt, who: w.walkers.map((x) => x.id) }));
    await env.DATA.put(WALKS_KEY, JSON.stringify({ at: now, walks }), { expirationTtl: 86400 });
    return walks;
  } catch (e) {
    console.warn('owntracks walks:', e.message || e);
    return cached ? cached.walks : [];
  }
}
// After any walk write through the Worker (index.js), so a start or stop switches the phones at once.
export async function forgetWalks(env) { if (env.DATA && env.DATA.delete) await env.DATA.delete(WALKS_KEY); }

// Adds a fix to its walk's list; → true when it was new.
async function addPoint(env, walkId, walker, p) {
  const k = ptsKey(walkId, walker), list = (await env.DATA.get(k, 'json')) || [];
  if (list.some((x) => x[3] === p[3])) return false;
  list.push(p);
  list.sort((a, b) => a[3] - b[3]);
  await env.DATA.put(k, JSON.stringify(list.length > MAX_POINTS ? list.slice(-MAX_POINTS) : list), { expirationTtl: TTL_S });
  return true;
}

// The walk's OwnTracks fixes: {walker: [[lat, lon, acc, unix s], ...]}.
export async function owntracksPoints(env, walkId) {
  const out = {};
  if (!env.DATA) return out;
  const walkers = [...new Set(Object.values(otUsers(env)).map((u) => u.walker))];
  await Promise.all(walkers.map(async (w) => {
    const l = await env.DATA.get(ptsKey(walkId, w), 'json');
    if (Array.isArray(l) && l.length) out[w] = l;
  }));
  return out;
}

// Per walker: with ≥ 5 OwnTracks fixes, those plus the HA fixes outside their time span; else the
// union. Sorted by time; one fix per second (OwnTracks' wins).
export function mergePaths(haPaths = {}, otPaths = {}) {
  const out = {};
  for (const who of new Set([...Object.keys(haPaths || {}), ...Object.keys(otPaths || {})])) {
    const ha = (haPaths && haPaths[who]) || [], ot = (otPaths && otPaths[who]) || [];
    let keep = ha;
    if (ot.length >= 5) {
      const lo = Math.min(...ot.map((p) => p[3])), hi = Math.max(...ot.map((p) => p[3]));
      keep = ha.filter((p) => p[3] < lo || p[3] > hi);
    }
    const byT = new Map();
    for (const p of keep) byT.set(p[3], p);
    for (const p of ot) byT.set(p[3], p);
    out[who] = [...byT.values()].sort((a, b) => a[3] - b[3]);
  }
  return out;
}

export const pathsToPoints = (paths) => Object.entries(paths).flatMap(([who, l]) => l.map(([lat, lon, acc, t]) => ({ who, lat, lon, acc, t })));

// A route PUT body with the walk's OwnTracks fixes merged in (putRoute's input; unchanged without any).
export async function withOwntracks(env, walkId, body) {
  if (!body || !Array.isArray(body.points)) return body;
  let ot;
  try { ot = await owntracksPoints(env, walkId); } catch (e) { console.warn('owntracks points:', e.message || e); return body; }
  if (!Object.keys(ot).length) return body;
  const merged = mergePaths(normalizeRoute(body).paths, ot);
  // Thin the longest paths if the total would pass normalizeRoute's limit.
  for (let n = Object.values(merged).reduce((s, l) => s + l.length, 0); n > ROUTE_MAX;) {
    const [who, l] = Object.entries(merged).sort((a, b) => b[1].length - a[1].length)[0];
    merged[who] = l.filter((_, i) => i % 2 === 0 || i === l.length - 1);
    n -= l.length - merged[who].length;
  }
  return { ...body, points: pathsToPoints(merged) };
}

// HA's own route PUT body (index.js keeps it), for re-saving the route when late fixes arrive.
export async function keepHaRoute(env, walkId, text) {
  if (!env.DATA || !text || text.length > 1e6) return;
  await env.DATA.put(haKey(walkId), text, { expirationTtl: TTL_S });
}

// Late fixes for a walk that has ended: rewrite its route once they stop coming (debounced).
async function resaveLater(env, ctx, walkId, delayMs) {
  const token = crypto.randomUUID(), k = 'ot:resave:' + walkId;
  await env.DATA.put(k, token, { expirationTtl: 3600 });
  const run = (async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    if ((await env.DATA.get(k)) !== token) return; // a later fix will do it
    await env.DATA.delete(k);
    await resaveRoute(env, ctx, walkId);
  })().catch((e) => console.error('owntracks route re-save', walkId, e.message || e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);
  return run;
}

export async function resaveRoute(env, ctx, walkId) {
  let ha = null;
  const text = await env.DATA.get(haKey(walkId));
  if (text) { try { ha = JSON.parse(text); } catch { ha = null; } }
  if (!ha || !Array.isArray(ha.points)) {
    // Not kept (HA hasn't sent it, or sent it before this existed): start from the stored route.
    const r = await new Lifelog(env).req('GET', '/events/' + encodeURIComponent(walkId + '-route')).catch(() => null);
    ha = { points: r && !r.deleted_at && r.data && r.data.paths ? pathsToPoints(r.data.paths) : [] };
  }
  const body = await withOwntracks(env, walkId, { ...ha, source: ha.source || 'owntracks' });
  const res = await new WalkStore(env, ctx).run('putRoute', walkId, body);
  if (res.status !== 200) console.warn('owntracks route re-save', walkId, res.status, res.body && res.body.error);
  return res;
}

// POST /owntracks. → a Response (a JSON array of OwnTracks messages).
export async function owntracksPost(req, env, ctx, same, { resaveDelayMs = 20e3, now = Date.now() } = {}) {
  const who = otAuth(req.headers.get('Authorization'), otUsers(env), same);
  if (!who) return reply({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Basic realm="owntracks"' });
  let msg;
  try { msg = JSON.parse(await req.text()); } catch { return reply([]); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reply([]);

  const walks = await recentWalks(env, now);
  if (msg._type === 'location') {
    const num = (v) => (v == null || v === '' ? NaN : Number(v)); // Number(null) is 0: a fix at 0,0
    const lat = num(msg.lat), lon = num(msg.lon), acc = msg.acc == null ? null : Math.round(Number(msg.acc));
    const t = Number(msg.tst);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && Number.isInteger(t) && t * 1000 <= now + 300e3 &&
      !(acc != null && !(acc >= 0 && acc <= MAX_ACC))) {
      const w = walkAt(walks, who.walker, t * 1000);
      if (w && await addPoint(env, w.id, who.walker, [+lat.toFixed(6), +lon.toFixed(6), acc, t]) && w.e != null) {
        await resaveLater(env, ctx, w.id, resaveDelayMs);
      }
    }
  }

  const device = String(req.headers.get('X-Limit-D') || 'phone').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'phone';
  const mk = 'ot:mode:' + who.user + ':' + device, wanted = wantedMode(walks, who.walker);
  const last = Number(await env.DATA.get(mk)) || null;
  const reported = msg._type === 'location' && Number.isInteger(msg.m) ? msg.m : null;
  if (!needsCmd(wanted, last, reported)) return reply([]);
  await env.DATA.put(mk, String(wanted), { expirationTtl: MODE_TTL_S });
  return reply(modeCmd(wanted));
}

// ---------------------------------------------------------------- phone setup
export function homeOf(env) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(env.OWNTRACKS_HOME || ''));
  if (!m) return null;
  const lat = +(+m[1]).toFixed(4), lon = +(+m[2]).toFixed(4);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function postUrl(req, url, env) {
  if (env.OWNTRACKS_URL) return String(env.OWNTRACKS_URL);
  const fwd = req.headers.get('X-Forwarded-Host') || '';
  return (/^[a-z0-9.-]+\.workers\.dev$/i.test(fwd) ? 'https://' + fwd : url.origin) + '/owntracks';
}

// The OwnTracks configuration (iOS Settings fromDictionary keys) for one person.
export function setupConfig(postTo, user, u, home) {
  return {
    _type: 'configuration',
    mode: 3, // HTTP
    url: postTo,
    auth: true, usePassword: true, username: user, password: u.password,
    deviceId: 'iphone', tid: u.walker.slice(0, 2).toUpperCase(),
    monitoring: SIGNIFICANT, ...MOVE_SETTINGS,
    // iOS reads remoteConfiguration; allowRemoteConfiguration is the documented name, ignored by iOS.
    cmd: true, remoteConfiguration: true, allowRemoteConfiguration: true,
    // Battery: no beacon ranging, no auto downgrade/adapt (the Worker switches modes), short history.
    ranging: false, downgrade: 0, adapt: 0, extendedData: true,
    ignoreInaccurateLocations: 0, ignoreStaleLocations: 0, positions: 50, maxHistory: 0, locked: false,
    waypoints: home ? [{ _type: 'waypoint', desc: 'Home', lat: home.lat, lon: home.lon, rad: HOME_RADIUS, tst: HOME_TST }] : [],
  };
}

// owntracks:///config?inline=… — iOS decodes standard base64 (processURIConfig), percent-decoded first.
export function configLink(config) {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'owntracks:///config?inline=' + encodeURIComponent(btoa(bin));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GET /owntracks/setup/<user> (the caller checked READ_KEY).
export function setupPage(req, url, env, user) {
  const u = otUsers(env)[user];
  if (!u) return new Response('No such OwnTracks user', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  const home = homeOf(env), postTo = postUrl(req, url, env), link = configLink(setupConfig(postTo, user, u, home));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>OwnTracks setup · ${esc(user)}</title>
<style>body{font:17px/1.45 -apple-system,system-ui,sans-serif;max-width:34em;margin:2em auto;padding:0 1em;color:#222}
a.btn{display:block;text-align:center;background:#0a7d6c;color:#fff;text-decoration:none;font-size:1.3em;font-weight:600;padding:1em;border-radius:14px;margin:1.5em 0}
li{margin:.4em 0}small{color:#666}</style></head><body>
<h1>OwnTracks for ${esc(user)}</h1>
<p>Accurate GPS for Maya's walks, sent only to the household's own server. Nothing is kept outside walks.</p>
<ol>
<li>Install <b>OwnTracks</b> from the App Store (version 27.1.2 or later).</li>
<li>Open it, allow location <b>Always</b> (with Precise Location) and Motion &amp; Fitness.</li>
<li>In OwnTracks <b>Settings</b>, turn on configuration by URL / file (it asks you to confirm).</li>
<li>Back here, tap the button, then accept the changes OwnTracks shows.</li>
</ol>
<a class="btn" href="${esc(link)}">Install in OwnTracks</a>
<p><small>Sets HTTP mode to ${esc(postTo)} as <b>${esc(user)}</b>, significant-changes mode, remote
configuration on (the server switches to move mode during walks), and a ${HOME_RADIUS} m Home region${home ? '' : ' (not set: OWNTRACKS_HOME is missing)'}.
Afterwards the OwnTracks map should show your position and Settings → Status should say the last post was accepted.
This page holds your OwnTracks password: don't share it.</small></p>
</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' },
  });
}
