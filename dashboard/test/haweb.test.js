import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowed, createWebHA, AUTH_KEY } from '../js/haweb.js';

const HA = 'https://ha.example', CLIENT = 'https://dash.example/';
const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
// fetch stub: answers from `routes` (url → fn(init) → response) and records each request.
const stub = (routes) => {
  const log = [];
  const f = async (url, init = {}) => { log.push({ url, init }); return routes[url.replace(HA, '')](init, log); };
  return { f, log };
};

test('allowlist matches the kiosk bridge', () => {
  // The same patterns as kiosk MainActivity HA_GET / HA_POST, so phones can do what the frame can and no more.
  const java = readFileSync(new URL('../kiosk/src/com/wesbos/homehq/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /HA_POST = Pattern\.compile\(\s*"\/api\/services\/\(light\|switch\|fan\|climate\|media_player\|vacuum\|scene\|script\)/);
  assert.ok(allowed('GET', '/api/states'));
  assert.ok(allowed('GET', '/api/states/light.kitchen'));
  assert.ok(allowed('GET', '/api/calendars/calendar.family?start=2026-11-14T00:00:00Z&end=2026-11-15T00:00:00Z'));
  assert.ok(allowed('POST', '/api/services/light/turn_on'));
  assert.ok(allowed('POST', '/api/services/todo/get_items?return_response'));
  assert.ok(!allowed('POST', '/api/services/lock/unlock'));
  assert.ok(!allowed('POST', '/api/services/homeassistant/restart'));
  assert.ok(!allowed('GET', '/api/services/light/turn_on'));
  assert.ok(!allowed('POST', '/api/states/light.kitchen'));
});

test('a refused request never reaches HA', async () => {
  const { f, log } = stub({});
  const ha = createWebHA({ haUrl: HA, clientId: CLIENT, storage: memory({ [AUTH_KEY]: JSON.stringify({ access: 't', longLived: true }) }), fetch: f });
  await assert.rejects(ha.call('POST', '/api/services/lock/unlock', {}), /not allowed/);
  assert.equal(log.length, 0);
});

test('code exchange, then calls refresh the access token when it is about to expire', async () => {
  let t = 1000;
  const storage = memory();
  const { f, log } = stub({
    '/auth/token': (init) => {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get('client_id'), CLIENT);
      if (p.get('grant_type') === 'authorization_code') return res(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 1800 });
      assert.equal(p.get('refresh_token'), 'r1');
      return res(200, { access_token: 'a2', expires_in: 1800 });
    },
    '/api/states': (init) => res(200, [{ entity_id: 'light.x', auth: init.headers.Authorization }]),
  });
  const ha = createWebHA({ haUrl: HA, clientId: CLIENT, storage, fetch: f, now: () => t });
  assert.equal(ha.signedIn(), false);
  await ha.exchange('code1');
  assert.equal(ha.signedIn(), true);
  assert.equal((await ha.call('GET', '/api/states'))[0].auth, 'Bearer a1');
  t += 1800e3 - 30e3; // 30 s before expiry
  assert.equal((await ha.call('GET', '/api/states'))[0].auth, 'Bearer a2');
  assert.equal(log.filter((r) => r.url.endsWith('/auth/token')).length, 2);
});

test('a revoked refresh token signs out; a network error keeps it', async () => {
  const storage = memory({ [AUTH_KEY]: JSON.stringify({ access: 'old', refresh: 'r1', expires: 0 }) });
  let down = true;
  const { f } = stub({
    '/auth/token': async () => { if (down) throw new TypeError('Load failed'); return res(400, { error: 'invalid_grant' }); },
  });
  const ha = createWebHA({ haUrl: HA, clientId: CLIENT, storage, fetch: f });
  await assert.rejects(ha.call('GET', '/api/states'), /Load failed/);
  assert.equal(ha.signedIn(), true);
  down = false;
  await assert.rejects(ha.call('GET', '/api/states'), /signed out/);
  assert.equal(ha.signedIn(), false);
});

test('a 401 retries once with a fresh token', async () => {
  const storage = memory({ [AUTH_KEY]: JSON.stringify({ access: 'stale', refresh: 'r1', expires: Date.now() + 3600e3 }) });
  const { f } = stub({
    '/auth/token': () => res(200, { access_token: 'fresh', expires_in: 1800 }),
    '/api/services/light/turn_off': (init) => (init.headers.Authorization === 'Bearer fresh' ? res(200, []) : res(401, null)),
  });
  const ha = createWebHA({ haUrl: HA, clientId: CLIENT, storage, fetch: f });
  assert.deepEqual(await ha.call('POST', '/api/services/light/turn_off', { entity_id: ['light.x'] }), []);
});
