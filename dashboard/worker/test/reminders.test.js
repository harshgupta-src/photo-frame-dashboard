import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReminders, forwardToHA, cleanOps, opsForPhone } from '../src/reminders.js';
import worker from '../src/index.js';
import { walkKey } from '../src/walkapi.js';

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
  assert.deepEqual(sent.lists['Grocery list'].map((i) => i.title), ['milk', 'eggs']);
  assert.equal(sent.lists.LOML[0].assignee, 'Ambuja');
  assert.equal('ack' in sent, false);
});

test('reports a failed or skipped forward without throwing', async () => {
  const env = { HA_REMINDERS_WEBHOOK_URL: 'https://ha.example/api/webhook/x' };
  assert.equal(await forwardToHA(env, {}, async () => new Response('', { status: 502 })), 'failed');
  assert.equal(await forwardToHA(env, {}, async () => { throw new Error('down'); }), 'failed');
  assert.equal(await forwardToHA({}, {}, async () => assert.fail('should not fetch')), 'off');
});

test('passes the Shortcut\'s ack through to HA, wrapped or flat', async () => {
  const wrapped = parseReminders({ lists: { LOML: 'a' }, ack: '12' });
  assert.equal(wrapped.ack, 12);
  const flat = parseReminders({ 'Grocery list': 'milk', ack: 7 });
  assert.deepEqual(Object.keys(flat.lists), ['Grocery list']);
  assert.equal(flat.ack, 7);
  assert.equal(parseReminders({ LOML: 'a', ack: -3 }).ack, 0);
  let body;
  await forwardToHA({ HA_REMINDERS_WEBHOOK_URL: 'https://ha.example/x' }, flat.lists,
    async (_u, init) => { body = JSON.parse(init.body); return new Response(''); }, flat.ack);
  assert.equal(body.ack, 7);
  assert.equal(body.lists['Grocery list'][0].title, 'milk');
});

test('cleans HA\'s ledger and gives the phone the ack for what it lists', () => {
  const stored = cleanOps({ seq: 9, ops: [
    { seq: 8, op: 'delete', list: 'LOML', title: 'Old', entity: 'todo.loml', ts: 1 },
    { seq: 5, op: 'add', list: 'Grocery list', title: ' Milk ', notes: 'x'.repeat(900) },
    { seq: 6, op: 'explode', title: 'x' }, { seq: 0, op: 'add', title: 'no seq' }, { seq: 7, op: 'add', title: '' },
  ] }, new Date('2026-11-19T12:00:00Z'));
  assert.equal(stored.seq, 9);
  assert.deepEqual(stored.ops.map((o) => [o.seq, o.op, o.title]), [[5, 'add', 'Milk'], [8, 'delete', 'Old']]);
  assert.equal(stored.ops[0].notes.length, 500);
  assert.equal('entity' in stored.ops[1], false);
  assert.equal(opsForPhone(stored).ack, 8);
  assert.deepEqual(opsForPhone(null), { updated: null, ack: 0, count: 0, ops: [] });
  assert.equal(opsForPhone({ updated: 'x', seq: 4, ops: [] }).ack, 4);
  assert.equal(cleanOps({ ops: 'nope' }), null);
});

function kv() {
  const m = new Map();
  return { get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}

test('/reminders/ops: HA posts with the walk key, the Shortcut reads with PUSH_TOKEN', async () => {
  const env = { PUSH_TOKEN: 'push-secret', READ_KEY: 'read', DATA: kv() };
  const wk = await walkKey(env, 'WALK_KEY');
  const call = (method, token, body) => worker.fetch(new Request('https://w.example/reminders/ops', {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }), env, { waitUntil() {} });
  const ledger = { seq: 3, ops: [{ seq: 3, op: 'complete', list: 'Grocery list', title: 'Eggs' }] };
  assert.equal((await call('POST', 'read', ledger)).status, 401);
  assert.equal((await call('POST', wk, { nope: 1 })).status, 400);
  assert.equal((await call('POST', wk, ledger)).status, 200);
  assert.equal((await call('GET', wk)).status, 401);
  const got = await (await call('GET', 'push-secret')).json();
  assert.equal(got.ack, 3);
  assert.deepEqual(got.ops.map((o) => [o.op, o.list, o.title]), [['complete', 'Grocery list', 'Eggs']]);
});
