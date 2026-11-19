import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGraph, decodeGraph, loadGraph, snapPath, snapRoute, cleanFixes } from '../worker/src/snap.js';

// A synthetic 5 × 5 street grid, 100 m blocks, somewhere in the ocean (lat 10, lon 20).
const LAT0 = 10, LON0 = 20, KY = 110600, KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const ll = (x, y) => [LAT0 + y / KY, LON0 + x / KX];
const xy = (p) => [(p[1] - LON0) * KX, (p[0] - LAT0) * KY];
function grid() {
  const nodes = [], edges = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) nodes.push(ll(i * 100, j * 100));
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    if (i < 4) edges.push([j * 5 + i, j * 5 + i + 1]);
    if (j < 4) edges.push([j * 5 + i, (j + 1) * 5 + i]);
  }
  return encodeGraph(nodes, edges, 7);
}
const G = decodeGraph(grid());
const fix = (x, y, acc, t) => [...ll(x, y), acc, t];
// Distance from a point to the nearest street line (x or y a multiple of 100).
const offStreet = ([x, y]) => Math.min(Math.abs(x - Math.round(x / 100) * 100), Math.abs(y - Math.round(y / 100) * 100));

test('noisy fixes along a street snap onto it', () => {
  const r = snapPath(G, [fix(10, 108, 10, 0), fix(60, 93, 10, 40), fix(110, 105, 10, 80), fix(190, 96, 10, 140)]);
  assert.ok(r);
  for (const p of r.line) assert.ok(Math.abs(xy(p)[1] - 100) < 0.5, 'on y=100: ' + xy(p));
  assert.ok(Math.abs(r.m - 180) < 5, String(r.m));
});

test('a long gap is filled with the shortest footpath route, not a line through the block', () => {
  // (0, 0) then 20 minutes later at (100, 100): the straight line crosses the block.
  const r = snapPath(G, [fix(2, 3, 8, 0), fix(98, 103, 8, 1200)]);
  assert.ok(r);
  for (const p of r.line) assert.ok(offStreet(xy(p)) < 0.5, 'on a street: ' + xy(p));
  assert.ok(Math.abs(r.m - 200) < 6, String(r.m));
  assert.ok(r.line.length >= 3, 'turns a corner');
});

test('junk fixes (bad accuracy, impossible jumps) are dropped', () => {
  const path = [fix(0, 102, 8, 0), fix(250, 350, 90, 30), fix(100, 98, 8, 60), fix(390, 400, 10, 70), fix(200, 101, 8, 120)];
  const kept = cleanFixes(path);
  assert.deepEqual(kept.map((p) => Math.round(xy(p)[0])), [0, 100, 200]);
  const r = snapPath(G, path);
  for (const p of r.line) assert.ok(offStreet(xy(p)) < 0.5 && xy(p)[1] > 95 && xy(p)[1] < 105, String(xy(p)));
  assert.ok(Math.abs(r.m - 200) < 5, String(r.m));
});

test('the HMM prefers the connected street over a closer wrong one', () => {
  // Walking along y=0, one fix drifts 30 m north toward x=150 (between streets): candidates on
  // x=100 / x=200 and y=0; the route-vs-straight-line transition keeps it on y=0.
  const r = snapPath(G, [fix(0, 5, 20, 0), fix(80, 4, 20, 60), fix(150, 30, 25, 110), fix(220, 4, 20, 160), fix(300, 3, 20, 220)]);
  for (const p of r.line) assert.ok(Math.abs(xy(p)[1]) < 0.5, 'stays on y=0: ' + xy(p));
});

test('no graph, a walk off the graph, or a bad blob: no snapping', () => {
  assert.equal(snapRoute(null, { harsh: [fix(0, 0, 5, 0), fix(100, 0, 5, 60)] }), null);
  assert.equal(snapPath(G, [fix(5000, 5000, 5, 0), fix(5100, 5000, 5, 60)]), null);
  assert.equal(decodeGraph(new Uint8Array(40)), null);
  assert.equal(loadGraph({}), null);
  const g = loadGraph({ WALK_GRAPH: grid().buffer });
  assert.equal(g.n, 25);
  assert.equal(loadGraph({ WALK_GRAPH: grid().buffer }), g, 'decoded once');
});

test('snapRoute snaps each walker and reports the distance', () => {
  const s = snapRoute(G, {
    harsh: [fix(0, 3, 8, 0), fix(97, 2, 8, 70), fix(102, 95, 8, 140)],
    ambuja: [fix(400, 400, 8, 0)], // one fix: left out
  });
  assert.deepEqual(Object.keys(s.snapped), ['harsh']);
  assert.ok(Math.abs(s.snapped_m - 195) < 6, String(s.snapped_m));
  assert.equal(s.snap.graph, 7);
});

test('dense input (a fix every few metres) is thinned and fast', () => {
  const path = [];
  // Around the whole grid's outer ring and across the middle: 1800 m, a fix every 2 m.
  const legs = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 200], [400, 200]];
  let t = 0;
  for (let k = 1; k < legs.length; k++) {
    const [ax, ay] = legs[k - 1], [bx, by] = legs[k], n = Math.hypot(bx - ax, by - ay) / 2;
    for (let i = 0; i < n; i++) path.push(fix(ax + (bx - ax) * i / n + Math.sin(i) * 6, ay + (by - ay) * i / n + Math.cos(i) * 6, 10, t += 2));
  }
  assert.ok(path.length > 700);
  const t0 = performance.now(), r = snapPath(G, path), ms = performance.now() - t0;
  assert.ok(r.fixes <= 400, String(r.fixes));
  for (const p of r.line) assert.ok(offStreet(xy(p)) < 0.5);
  assert.ok(Math.abs(r.m - 1800) < 60, String(r.m));
  assert.ok(ms < 200, ms + ' ms');
});
