import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  otAuth, otUsers, needsCmd, wantedMode, mergePaths, owntracksPoints, owntracksPost, withOwntracks, configLink, setupConfig,
  MOVE, SIGNIFICANT,
} from '../worker/src/owntracks.js';

const same = (a, b) => typeof a === 'string' && a === b;
const PW = { harsh: 'h'.repeat(20), ambuja: 'a'.repeat(20) };
const USERS = JSON.stringify({ harsh: { password: PW.harsh, walker: 'harsh' }, ambuja: { password: PW.ambuja, walker: 'ambuja' } });
const basic = (u, p) => 'Basic ' + btoa(u + ':' + p);
const LL = 'https://lifelog.test';
const NOW = Date.parse('2026-11-19T15:00:00Z'), S = NOW / 1000;
let kv, env, puts;

beforeEach(() => {
  kv = new Map();
  puts = [];
  env = {
    OWNTRACKS_USERS: USERS, LIFELOG_URL: LL, LIFELOG_TOKEN: 't', LIFELOG_WALK_TYPE: 'rex_walk',
    DATA: {
      get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
  };
  // Lifelog: one ended walk (for putRoute) and route PUTs recorded.
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), m = init.method || 'GET', res = (s, j) => new Response(JSON.stringify(j), { status: s });
    if (m === 'GET' && u.pathname === '/events/walk-ended') {
      return res(200, { id: 'walk-ended', type: 'rex_walk', started_at: new Date(NOW - 3600e3).toISOString(), ended_at: new Date(NOW - 1800e3).toISOString(), data: { walkers: ['Harsh'], walker_ids: ['harsh'] } });
    }
    if (m === 'PUT') { const b = JSON.parse(init.body); puts.push(b); return res(200, { ...b, id: decodeURIComponent(u.pathname.split('/').pop()) }); }
    return res(404, { error: 'not found' });
  };
});

function walks(list) { kv.set('ot:walks', JSON.stringify({ at: NOW, walks: list })); }
async function post(user, body, { device = 'iphone', pw = PW[user] } = {}) {
  const waits = [];
  const req = new Request('https://w/owntracks', {
    method: 'POST', headers: { Authorization: basic(user, pw), 'X-Limit-U': user, 'X-Limit-D': device }, body: JSON.stringify(body),
  });
  const r = await owntracksPost(req, env, { waitUntil: (p) => waits.push(p) }, same, { now: NOW, resaveDelayMs: 0 });
  await Promise.all(waits);
  return { status: r.status, body: await r.json() };
}
const loc = (t, extra = {}) => ({ _type: 'location', lat: 40.7, lon: -74.0, acc: 5, tst: t, m: 1, ...extra });
const modeOf = (body) => body.length && body[0].configuration.monitoring;

test('auth: per-person Basic credentials', () => {
  const users = otUsers({ OWNTRACKS_USERS: USERS });
  assert.deepEqual(otAuth(basic('harsh', PW.harsh), users, same), { user: 'harsh', walker: 'harsh' });
  assert.equal(otAuth(basic('harsh', PW.ambuja), users, same), null);
  assert.equal(otAuth(basic('maya', PW.harsh), users, same), null);
  assert.equal(otAuth(basic('constructor', 'x'), users, same), null);
  assert.equal(otAuth('Bearer ' + PW.harsh, users, same), null);
  assert.equal(otAuth('Basic !!!', users, same), null);
  // Short passwords and bad walker ids are not accepted as users.
  assert.deepEqual(otUsers({ OWNTRACKS_USERS: '{"x": {"password": "short", "walker": "x"}}' }), {});
  assert.deepEqual(otUsers({ OWNTRACKS_USERS: 'not json' }), {});
});

test('POST /owntracks rejects wrong credentials', async () => {
  walks([]);
  assert.equal((await post('harsh', loc(S), { pw: 'wrong-password-123456' })).status, 401);
});

test('cmd decision: send on a mode change or a phone in the wrong mode', () => {
  assert.equal(needsCmd(MOVE, null, null), true);
  assert.equal(needsCmd(MOVE, MOVE, null), false);
  assert.equal(needsCmd(MOVE, MOVE, MOVE), false);
  assert.equal(needsCmd(MOVE, MOVE, SIGNIFICANT), true);
  assert.equal(needsCmd(SIGNIFICANT, MOVE, MOVE), true);
  const w = [{ id: 'w1', s: NOW, e: null, who: ['harsh'] }, { id: 'w0', s: NOW - 7200e3, e: NOW - 3600e3, who: ['ambuja'] }];
  assert.equal(wantedMode(w, 'harsh'), MOVE);
  assert.equal(wantedMode(w, 'ambuja'), SIGNIFICANT);
});

test('during a walk: fixes kept, move mode sent once, resent when the phone reports another mode', async () => {
  walks([{ id: 'walk-active', s: NOW - 600e3, e: null, who: ['harsh'] }]);
  let r = await post('harsh', { _type: 'transition', event: 'leave', tst: S - 500 });
  assert.equal(modeOf(r.body), MOVE);
  assert.equal(r.body[0].configuration.locatorDisplacement, 10);
  r = await post('harsh', loc(S - 400, { m: 2 }));
  assert.deepEqual(r.body, []);
  r = await post('harsh', loc(S - 390, { m: 1 }));
  assert.equal(modeOf(r.body), MOVE);
  await post('harsh', loc(S - 390, { m: 2 })); // same second: not added twice
  await post('harsh', loc(S - 380, { acc: 500, m: 2 })); // too inaccurate
  assert.deepEqual(await owntracksPoints(env, 'walk-active'), { harsh: [[40.7, -74, 5, S - 400], [40.7, -74, 5, S - 390]] });
  // Ambuja isn't on it: nothing stored, significant mode once, then nothing.
  r = await post('ambuja', loc(S - 300));
  assert.equal(modeOf(r.body), SIGNIFICANT);
  assert.deepEqual((await post('ambuja', loc(S - 200))).body, []);
  assert.deepEqual(await owntracksPoints(env, 'walk-active'), { harsh: [[40.7, -74, 5, S - 400], [40.7, -74, 5, S - 390]] });
});

test('outside walks: nothing stored, back to significant mode', async () => {
  walks([{ id: 'walk-ended', s: NOW - 3600e3, e: NOW - 1800e3, who: ['harsh'] }]);
  kv.set('ot:mode:harsh:iphone', '2');
  const r = await post('harsh', loc(S - 60, { m: 2 }));
  assert.equal(modeOf(r.body), SIGNIFICANT);
  assert.deepEqual(await owntracksPoints(env, 'walk-ended'), {});
  assert.equal(puts.length, 0);
});

test('a late fix for an ended walk is kept and re-saves the route with HA\'s points', async () => {
  walks([{ id: 'walk-ended', s: NOW - 3600e3, e: NOW - 1800e3, who: ['harsh'] }]);
  const t0 = S - 3000;
  kv.set('ot:ha:walk-ended', JSON.stringify({ source: 'ha', points: [{ who: 'harsh', lat: 40.6, lon: -74.1, acc: 30, t: t0 - 100 }] }));
  for (let i = 0; i < 5; i++) await post('harsh', loc(t0 + 10 * i, { lat: 40.7 + i / 1e4 }));
  assert.equal(puts.length, 5); // each new fix re-saves once its debounce passes (0 ms here)
  const route = puts.at(-1);
  assert.equal(route.type, 'rex_walk_route');
  assert.equal(route.source, 'ha');
  assert.deepEqual(route.data.paths.harsh.map((p) => p[3]), [t0 - 100, t0, t0 + 10, t0 + 20, t0 + 30, t0 + 40]);
});

test('merge: OwnTracks wins inside its span, HA fills outside it', () => {
  const ot = [10, 20, 30, 40, 50].map((t) => [1, 1, 5, t]);
  const ha = [[2, 2, 40, 5], [2, 2, 40, 25], [2, 2, 40, 55]];
  assert.deepEqual(mergePaths({ harsh: ha }, { harsh: ot }).harsh.map((p) => p[3]), [5, 10, 20, 30, 40, 50, 55]);
  // Fewer than 5 OwnTracks fixes: the union by time, one per second (OwnTracks' kept).
  const few = mergePaths({ harsh: [[2, 2, 40, 5], [2, 2, 40, 20]], ambuja: [[3, 3, 9, 1]] }, { harsh: [[1, 1, 5, 20], [1, 1, 5, 30]] });
  assert.deepEqual(few.harsh, [[2, 2, 40, 5], [1, 1, 5, 20], [1, 1, 5, 30]]);
  assert.deepEqual(few.ambuja, [[3, 3, 9, 1]]);
  assert.deepEqual(mergePaths({}, {}), {});
});

test('withOwntracks merges stored fixes into a route body; unchanged without any', async () => {
  const body = { points: [{ who: 'harsh', lat: 40.6, lon: -74.1, acc: 30, t: (S - 100) * 1000 }] };
  assert.equal(await withOwntracks(env, 'walk-x', body), body);
  kv.set('ot:pts:walk-x:harsh', JSON.stringify([[40.7, -74, 5, S]]));
  const out = await withOwntracks(env, 'walk-x', body);
  assert.deepEqual(out.points.map((p) => p.t), [S - 100, S]);
});

test('setup link: standard base64 JSON, percent-encoded, with the home region', () => {
  const cfg = setupConfig('https://w.example/owntracks', 'harsh', { password: PW.harsh, walker: 'harsh' }, { lat: 40.1234, lon: -74.5678 });
  const link = configLink(cfg);
  assert.ok(link.startsWith('owntracks:///config?inline='));
  const inline = decodeURIComponent(link.split('inline=')[1]);
  assert.match(inline, /^[A-Za-z0-9+/]+=*$/);
  const back = JSON.parse(Buffer.from(inline, 'base64').toString('utf8'));
  assert.equal(back.mode, 3);
  assert.equal(back.url, 'https://w.example/owntracks');
  assert.equal(back.monitoring, 1);
  assert.equal(back.cmd, true);
  assert.equal(back.remoteConfiguration, true);
  assert.deepEqual(back.waypoints[0], { _type: 'waypoint', desc: 'Home', lat: 40.1234, lon: -74.5678, rad: 120, tst: 1763510400 });
});
