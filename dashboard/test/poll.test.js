import { test } from 'node:test';
import assert from 'node:assert/strict';
import { every } from '../js/poll.js';

function fakeDoc() {
  const l = {};
  return { hidden: false, addEventListener: (t, f) => { l[t] = f; }, removeEventListener: (t) => { delete l[t]; }, fire: (t, e) => l[t] && l[t](e) };
}

test('catches up on return even if the interval was frozen while hidden (iOS)', async () => {
  let t = 0, runs = 0;
  const doc = fakeDoc(), win = fakeDoc();
  const stop = every(1000, () => runs++, { doc, win, now: () => t });
  doc.hidden = true; t = 60000; // backgrounded a minute, timers frozen: interval never fired
  doc.hidden = false; doc.fire('visibilitychange');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 1);
  doc.fire('visibilitychange'); // shown again right away: nothing due
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 1);
  t = 120000; win.fire('pageshow', { persisted: true }); // bfcache restore
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2);
  stop();
});
