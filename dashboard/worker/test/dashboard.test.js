import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'k3y';
const env = {
  READ_KEY: KEY,
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === '/manifest.webmanifest') return Response.json({ name: 'Home HQ', start_url: '/', display: 'fullscreen' });
      return new Response('asset ' + p);
    },
  },
};
const get = (path, headers = {}) => worker.fetch(new Request('https://frame.example' + path, { headers }), env, {});

test('home-screen icons are public; the page and manifest need the key', async () => {
  for (const p of ['/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']) assert.equal((await get(p)).status, 200, p);
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/manifest.webmanifest')).status, 401);
});

test('the manifest starts an installed app with the key, since it has its own cookie jar', async () => {
  const r = await get('/manifest.webmanifest', { Cookie: 'frame_key=' + KEY });
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.start_url, '/?key=' + KEY);
  assert.equal(m.id, '/');
  assert.equal(m.name, 'Home HQ');
});
