import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReminders, forwardToHA } from '../src/reminders.js';

test('forwards the cleaned lists to the HA webhook as JSON', async () => {
  const out = parseReminders({ 'Grocery list': 'milk\r\neggs\n', LOML: [{ title: 'Call', assignee: 'Ambuja' }] });
  let call;
  const ha = await forwardToHA({ HA_REMINDERS_WEBHOOK_URL: 'https://ha.example/api/webhook/x' }, out.lists,
    async (url, init) => { call = { url, init }; return new Response('', { status: 200 }); });
  assert.equal(ha, 'ok');
  assert.equal(call.url, 'https://ha.example/api/webhook/x');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent['Grocery list'].map((i) => i.title), ['milk', 'eggs']);
  assert.equal(sent.LOML[0].assignee, 'Ambuja');
});

test('reports a failed or skipped forward without throwing', async () => {
  const env = { HA_REMINDERS_WEBHOOK_URL: 'https://ha.example/api/webhook/x' };
  assert.equal(await forwardToHA(env, {}, async () => new Response('', { status: 502 })), 'failed');
  assert.equal(await forwardToHA(env, {}, async () => { throw new Error('down'); }), 'failed');
  assert.equal(await forwardToHA({}, {}, async () => assert.fail('should not fetch')), 'off');
});
