import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSitterEvent, awayState, toggleMode, nextStay } from '../js/awaystate.js';

var H = 3600e3, T0 = Date.parse('2026-11-21T15:00:00Z');
var stay = { title: '🐕 Maya at the sitter (Andreas)', start: new Date(T0), end: new Date(T0 + 54 * H) };
var meal = { title: 'Maya lunch 1 cup', start: new Date(T0 + 2 * H), end: new Date(T0 + 2.25 * H) };

test('matches stays that name the dog, not other sitters or dog events', () => {
  assert.ok(isSitterEvent(stay, 'Maya'));
  assert.ok(isSitterEvent({ title: 'Maya boarding' }, 'Maya'));
  assert.ok(!isSitterEvent({ title: 'Babysitter for Krasi dinner' }, 'Maya'));
  assert.ok(!isSitterEvent(meal, 'Maya'));
});

test('follows the calendar in auto', () => {
  assert.equal(awayState([stay, meal], null, T0 - 1, 'Maya').away, false);
  var s = awayState([stay, meal], { state: 'auto', changed: 0 }, T0 + H, 'Maya');
  assert.equal(s.away, true);
  assert.equal(s.source, 'calendar');
  assert.equal(+s.until, +stay.end);
  assert.equal(awayState([stay], null, +stay.end, 'Maya').away, false);
});

test('"home" cancels the stay in progress but not a later one', () => {
  var home = { state: 'home', changed: T0 + 3 * H };
  var s = awayState([stay], home, T0 + 4 * H, 'Maya');
  assert.equal(s.away, false);
  assert.equal(s.cancelled, true);
  var later = { title: 'Maya boarding', start: new Date(T0 + 100 * H), end: new Date(T0 + 120 * H) };
  assert.equal(awayState([later], home, T0 + 101 * H, 'Maya').away, true);
});

test('"away" holds with no calendar event', () => {
  var s = awayState([], { state: 'away', changed: T0 }, T0 + 9 * H, 'Maya');
  assert.equal(s.away, true);
  assert.equal(s.source, 'manual');
  assert.equal(s.until, null);
});

test('toggle picks the override that flips the state', () => {
  assert.equal(toggleMode(awayState([stay], null, T0 + H, 'Maya')), 'home');
  assert.equal(toggleMode(awayState([], { state: 'away', changed: T0 }, T0 + H, 'Maya')), 'auto');
  assert.equal(toggleMode(awayState([stay], { state: 'home', changed: T0 + H }, T0 + 2 * H, 'Maya')), 'auto');
  assert.equal(toggleMode(awayState([], null, T0, 'Maya')), 'away');
});

test('nextStay finds an upcoming drop-off', () => {
  assert.equal(nextStay([stay], T0 - 2 * H, 'Maya', 24 * H), stay);
  assert.equal(nextStay([stay], T0 - 30 * H, 'Maya', 24 * H), null);
});
