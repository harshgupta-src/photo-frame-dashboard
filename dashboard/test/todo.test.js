import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodos, scriptData, splitDesc, joinDesc, bumpHistory, topHistory } from '../js/todo.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
function setup(over = {}) {
  let t = 1000;
  const sent = [], calls = [];
  const s = createTodos({
    now: () => t, holdMs: 20, settleMs: 50,
    send: (op) => { sent.push(scriptData(op, 'todo.g')); return over.fail ? Promise.reject(new Error('down')) : Promise.resolve(); },
    onError: (op) => calls.push('error:' + op.kind),
    onMismatch: (op) => calls.push('mismatch:' + op.kind),
    onChange: () => calls.push('change'),
  });
  s.setBase('g', [{ uid: 'a', title: 'Milk', done: false }, { uid: 'b', title: 'Eggs', done: true }], 0);
  return { s, sent, calls, at: (v) => { t = v; } };
}
const view = (s) => s.items('g').map((i) => i.title + (i.done ? '✓' : ''));

test('a tick shows at once and stays until a reload started after HA confirmed agrees', async () => {
  const { s, sent, at } = setup();
  at(2000);
  const p = s.toggle('g', 'ua', true);
  assert.deepEqual(view(s), ['Milk✓', 'Eggs✓']);
  assert.equal(await p, true);
  assert.deepEqual(sent, [{ entity_id: 'todo.g', op: 'complete', uid: 'a' }]);
  // A reload that was already in flight (started before the confirmation) still shows it open: no flicker.
  s.setBase('g', [{ uid: 'a', title: 'Milk', done: false }, { uid: 'b', title: 'Eggs', done: true }], 1500);
  assert.deepEqual(view(s), ['Milk✓', 'Eggs✓']);
  s.setBase('g', [{ uid: 'a', title: 'Milk', done: true }, { uid: 'b', title: 'Eggs', done: true }], 2500);
  assert.deepEqual(view(s), ['Milk✓', 'Eggs✓']);
  assert.equal(s.pending(), 0);
});

test('a failed call rolls back and reports; a confirmed change HA did not take is reported too', async () => {
  const f = setup({ fail: true });
  assert.equal(await f.s.toggle('g', 'ua', true), false);
  assert.deepEqual(view(f.s), ['Milk', 'Eggs✓']);
  assert.ok(f.calls.includes('error:set'));
  const { s, calls, at } = setup();
  at(3000);
  await s.edit('g', 'ua', { title: 'Oat milk' });
  assert.deepEqual(view(s), ['Oat milk', 'Eggs✓']);
  s.setBase('g', [{ uid: 'a', title: 'Milk', done: false }, { uid: 'b', title: 'Eggs', done: true }], 3100);
  assert.deepEqual(view(s), ['Milk', 'Eggs✓']);
  assert.ok(calls.includes('mismatch:set'));
});

test('an add keeps its row id once HA has the item, and duplicates are not sent', async () => {
  const { s, sent } = setup();
  assert.deepEqual(await s.add('g', ' milk '), { dup: s.items('g')[0] });
  const p = s.add('g', 'Bread', 'sourdough');
  const tmp = s.items('g').find((i) => i.title === 'Bread');
  assert.equal(tmp.pending, true);
  await p;
  assert.deepEqual(sent.at(-1), { entity_id: 'todo.g', op: 'add', title: 'Bread', description: 'sourdough' });
  s.setBase('g', [{ uid: 'a', title: 'Milk' }, { uid: 'b', title: 'Eggs', done: true }, { uid: 'c', title: 'Bread' }], 5000);
  assert.equal(s.items('g').find((i) => i.title === 'Bread').id, tmp.id);
  // Adding a ticked item reopens it (the script does the same).
  s.add('g', 'eggs');
  assert.deepEqual(view(s), ['Milk', 'Eggs', 'Bread']);
});

test('delete and clear completed wait for undo before anything is sent', async () => {
  const { s, sent } = setup();
  const undo = s.remove('g', 'ua');
  assert.deepEqual(view(s), ['Eggs✓']);
  assert.equal(undo(), true);
  assert.deepEqual(view(s), ['Milk', 'Eggs✓']);
  s.clearDone('g');
  assert.deepEqual(view(s), ['Milk']);
  await new Promise((r) => setTimeout(r, 40));
  await tick();
  assert.deepEqual(sent, [{ entity_id: 'todo.g', op: 'clear_completed' }]);
});

test('edits keep the assignee line; nothing is sent while offline', async () => {
  assert.deepEqual(splitDesc('Call first\nAssigned: Ambuja'), { notes: 'Call first', assignee: 'Ambuja' });
  assert.equal(joinDesc('', 'Harsh'), 'Assigned: Harsh');
  const { s, sent } = setup();
  s.setBase('g', [{ uid: 'a', title: 'Milk', notes: 'old', assignee: 'Ambuja' }], 0);
  await s.edit('g', 'ua', { notes: '2 litres' });
  assert.deepEqual(sent.at(-1), { entity_id: 'todo.g', op: 'edit', uid: 'a', description: '2 litres\nAssigned: Ambuja' });
  s.online = false;
  assert.equal(await s.toggle('g', 'ua', true), false);
  assert.equal(s.remove('g', 'ua'), null);
  assert.equal(sent.length, 1);
});

test('quick-add history ranks most bought, then most recent', () => {
  const h = {};
  bumpHistory(h, 'Milk', 1, true); bumpHistory(h, 'milk', 2, true); bumpHistory(h, 'Eggs', 5, true); bumpHistory(h, 'Rosemary', 9, false);
  assert.deepEqual(topHistory(h, 2), ['milk', 'Eggs']);
  assert.deepEqual(topHistory(h, 5), ['milk', 'Eggs', 'Rosemary']);
});
