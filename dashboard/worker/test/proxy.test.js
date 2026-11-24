import { test } from 'node:test';
import assert from 'node:assert/strict';
import proxy from '../vm/proxy.js';

test('proxy: an unset ORIGIN is a clear 503, not a crash', async () => {
  const r = await proxy.fetch(new Request('https://frame-data.example.workers.dev/events'), {});
  assert.equal(r.status, 503);
  assert.match(await r.text(), /ORIGIN/);
});
