import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodos } from '../js/todo.js';

// shopping.js is a view: give it a to-do store and just enough of the app to open the edit sheet.
const sent = [], toasts = [];
let sheet = null;
const T = createTodos({ send: (op) => { sent.push(op); return Promise.resolve(); }, holdMs: 0 });
T.online = true;
T.status = () => 'ok';
T.can = () => true;
globalThis.window = { ICONS: {}, CONFIG: { pinnedList: 'Reminders' }, DATA: { groceries: [], usuals: [], catalog: [], catOrder: { all: [] }, stores: [], people: [] } };
globalThis.document = { addEventListener: () => {} };
globalThis.App = {
  todo: T, on: () => {}, register: () => {}, categorize: () => 'Other', esc: (s) => String(s), icon: () => '',
  onScreen: () => false, toast: (h) => toasts.push(h), phone: true,
  sheet: (html, o) => { sheet = o; },
};
await import('../js/views/shopping.js');

// A fake sheet: the inputs as the user left them, and the handlers shopping.js attached.
function openSheet(id, values) {
  App.todoEditSheet('grocery', id);
  const h = {}, form = { addEventListener: (e, fn) => { h.submit = fn; } }, del = { addEventListener: (e, fn) => { h.del = fn; } };
  const el = {
    addEventListener: () => {},
    querySelector: (q) => q === '.te' ? form : q === '.te-del' ? del : q === '.te-title' ? { value: values.title, focus() {} }
      : q === '.te-notes' ? { value: values.notes } : null,
  };
  sheet.onMount(el, () => {});
  return h;
}
const base = (items) => T.setBase('grocery', items, Date.now() + 1);

test('saving the edit sheet sends only the fields changed in it, not stale ones', async () => {
  base([{ uid: 'u1', title: 'Milk', notes: '', assignee: '', done: false }]);
  const h = openSheet('uu1', { title: 'Oat milk', notes: '' });
  // Meanwhile a phone adds a note.
  base([{ uid: 'u1', title: 'Milk', notes: '2 litres', assignee: '', done: false }]);
  sent.length = 0;
  h.submit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].patch, { title: 'Oat milk' });
});

test('saving or deleting an item removed on another device says so instead of failing silently', async () => {
  base([{ uid: 'u2', title: 'Eggs', notes: '', assignee: '', done: false }]);
  const h = openSheet('uu2', { title: 'Eggs', notes: 'dozen' });
  base([]);
  sent.length = 0; toasts.length = 0;
  h.submit({ preventDefault() {} });
  h.del();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 0);
  assert.equal(toasts.length, 2);
  assert.match(toasts[0], /removed on another device/);
});
