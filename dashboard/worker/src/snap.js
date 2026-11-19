// Self-hosted map matching for walk routes: snaps the phones' sparse, noisy fixes onto the footpaths
// and streets they were walked on, so the dog tab's map doesn't draw lines through buildings. No
// coordinates leave the Worker. The pedestrian graph (worker/scripts/walk-graph.mjs builds it from an
// OpenStreetMap extract) arrives as the WALK_GRAPH binding (an ArrayBuffer; vm/server.mjs binds it);
// without it routes simply aren't snapped. See ../../WALKS.md "Snapped routes".
//
// The matcher is a hidden Markov model (Newson & Krumm 2009): each fix's candidates are the nearest
// points on graph edges within max(2 × accuracy, 25 m); emission is Gaussian in the fix-to-candidate
// distance; a transition costs |route distance − great-circle distance|, with route distances from a
// bounded A* over the graph; Viterbi picks the most likely sequence and the output follows the
// shortest path between consecutive matches (so long gaps follow the footpaths too).
//
// Graph format (little endian): "WGR1", u32 nodes N, u32 edges E, u32 build id, then i32 lat[N],
// i32 lon[N] (microdegrees), u32 from[E], u32 to[E]. Edges are undirected straight segments.

const MAGIC = 0x31524757; // "WGR1"
export const SNAP_VERSION = 1;
const CELL = 50; // m, spatial grid for candidate lookup
const MAX_ACC = 60; // m, worse fixes are dropped
const MAX_SPEED = 3; // m/s, a fix that needs more (beyond both fixes' accuracy) is junk
const MIN_STEP = 8; // m, fixes closer than this to the last one add nothing
const MAX_FIXES = 400; // per walker; denser input is thinned
const K = 5; // candidates per fix

// ---------------------------------------------------------------- graph
export function encodeGraph(nodes, edges, buildId = 0) {
  const n = nodes.length, e = edges.length, buf = new ArrayBuffer(16 + 8 * n + 8 * e), dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, n, true); dv.setUint32(8, e, true); dv.setUint32(12, buildId >>> 0, true);
  const lat = new Int32Array(buf, 16, n), lon = new Int32Array(buf, 16 + 4 * n, n);
  nodes.forEach((p, i) => { lat[i] = Math.round(p[0] * 1e6); lon[i] = Math.round(p[1] * 1e6); });
  const a = new Uint32Array(buf, 16 + 8 * n, e), b = new Uint32Array(buf, 16 + 8 * n + 4 * e, e);
  edges.forEach((x, i) => { a[i] = x[0]; b[i] = x[1]; });
  return new Uint8Array(buf);
}

// → the graph with its projection, adjacency and grid index, or null when buf isn't one.
export function decodeGraph(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < 16) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const n = dv.getUint32(4, true), e = dv.getUint32(8, true);
  if (u8.byteLength !== 16 + 8 * n + 8 * e || !n) return null;
  // Copy so the arrays are aligned whatever the binding's offset.
  const body = u8.buffer.slice(u8.byteOffset + 16, u8.byteOffset + u8.byteLength);
  const lat = new Int32Array(body, 0, n), lon = new Int32Array(body, 4 * n, n);
  const eu = new Uint32Array(body, 8 * n, e), ev = new Uint32Array(body, 8 * n + 4 * e, e);
  let s = 0;
  for (let i = 0; i < n; i++) s += lat[i];
  const lat0 = s / n / 1e6, lon0 = lon[0] / 1e6, phi = lat0 * Math.PI / 180;
  // Metres per degree at lat0 (equirectangular is plenty for a few km).
  const ky = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const X = new Float64Array(n), Y = new Float64Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = X[i] = (lon[i] / 1e6 - lon0) * kx, y = Y[i] = (lat[i] / 1e6 - lat0) * ky;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const len = new Float64Array(e), deg = new Uint32Array(n + 1);
  for (let i = 0; i < e; i++) {
    if (eu[i] >= n || ev[i] >= n) return null;
    len[i] = Math.hypot(X[eu[i]] - X[ev[i]], Y[eu[i]] - Y[ev[i]]);
    deg[eu[i]]++; deg[ev[i]]++;
  }
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const adjN = new Uint32Array(2 * e), adjE = new Uint32Array(2 * e), fill = off.slice(0, n);
  for (let i = 0; i < e; i++) {
    let k = fill[eu[i]]++; adjN[k] = ev[i]; adjE[k] = i;
    k = fill[ev[i]]++; adjN[k] = eu[i]; adjE[k] = i;
  }
  // Grid of CELL-metre cells → the edges whose bounding box touches them.
  const gw = Math.floor((x1 - x0) / CELL) + 1, gh = Math.floor((y1 - y0) / CELL) + 1;
  const cellOf = (v, v0) => Math.floor((v - v0) / CELL);
  const cnt = new Uint32Array(gw * gh + 1);
  const eachCell = (i, fn) => {
    const a = eu[i], b = ev[i];
    const cx0 = cellOf(Math.min(X[a], X[b]), x0), cx1 = cellOf(Math.max(X[a], X[b]), x0);
    const cy0 = cellOf(Math.min(Y[a], Y[b]), y0), cy1 = cellOf(Math.max(Y[a], Y[b]), y0);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * gw + cx);
  };
  for (let i = 0; i < e; i++) eachCell(i, (c) => cnt[c + 1]++);
  for (let c = 0; c < gw * gh; c++) cnt[c + 1] += cnt[c];
  const cellEdges = new Uint32Array(cnt[gw * gh]), pos = cnt.slice(0, gw * gh);
  for (let i = 0; i < e; i++) eachCell(i, (c) => { cellEdges[pos[c]++] = i; });
  return {
    n, e, buildId: dv.getUint32(12, true), lat0, lon0, kx, ky, X, Y, eu, ev, len, off, adjN, adjE,
    x0, y0, gw, gh, cellStart: cnt, cellEdges,
    // search scratch, reused between calls (epoch stamps instead of clearing)
    epoch: 0, gs: new Float64Array(n), stamp: new Uint32Array(n), closed: new Uint32Array(n), tmark: new Uint32Array(n),
    pred: new Int32Array(n), seen: new Uint32Array(e), heapK: new Float64Array(1024), heapV: new Int32Array(1024),
  };
}

let cache = { key: null, graph: null };
// The WALK_GRAPH binding, decoded once per isolate. null when there is none (no snapping).
export function loadGraph(env) {
  const b = env && env.WALK_GRAPH;
  if (!b || typeof b.byteLength !== 'number') return null;
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  const key = u8.byteLength + ':' + (u8.byteLength >= 16 ? new DataView(u8.buffer, u8.byteOffset, 16).getUint32(12, true) : 0);
  if (cache.key !== key) {
    let g = null;
    try { g = decodeGraph(u8); } catch (e) { console.error('walk graph:', e.message || e); }
    cache = { key, graph: g };
  }
  return cache.graph;
}

const toXY = (g, lat, lon) => [(lon - g.lon0) * g.kx, (lat - g.lat0) * g.ky];
const toLL = (g, x, y) => [+(g.lat0 + y / g.ky).toFixed(6), +(g.lon0 + x / g.kx).toFixed(6)];

// Points on edges within r of (x, y), nearest first, at most K, at least 1 m apart.
function candidates(g, x, y, r) {
  const ep = nextEpoch(g), out = [];
  const cx0 = Math.max(0, Math.floor((x - r - g.x0) / CELL)), cx1 = Math.min(g.gw - 1, Math.floor((x + r - g.x0) / CELL));
  const cy0 = Math.max(0, Math.floor((y - r - g.y0) / CELL)), cy1 = Math.min(g.gh - 1, Math.floor((y + r - g.y0) / CELL));
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * g.gw + cx;
      for (let k = g.cellStart[c]; k < g.cellStart[c + 1]; k++) {
        const i = g.cellEdges[k];
        if (g.seen[i] === ep) continue;
        g.seen[i] = ep;
        const ax = g.X[g.eu[i]], ay = g.Y[g.eu[i]], dx = g.X[g.ev[i]] - ax, dy = g.Y[g.ev[i]] - ay, l2 = dx * dx + dy * dy;
        const f = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const px = ax + f * dx, py = ay + f * dy, d = Math.hypot(x - px, y - py);
        if (d <= r) out.push({ e: i, f, x: px, y: py, d });
      }
    }
  }
  out.sort((a, b) => a.d - b.d);
  const pick = [];
  for (const c of out) {
    if (pick.length >= K) break;
    if (!pick.some((p) => Math.abs(p.x - c.x) < 1 && Math.abs(p.y - c.y) < 1)) pick.push(c);
  }
  return pick;
}

function nextEpoch(g) {
  if (++g.epoch >= 0xffffffff) {
    g.epoch = 1;
    g.stamp.fill(0); g.closed.fill(0); g.tmark.fill(0); g.seen.fill(0);
  }
  return g.epoch;
}

// ---------------------------------------------------------------- bounded A*
function push(g, h, k, v) {
  if (h.n === g.heapK.length) {
    const K2 = new Float64Array(h.n * 2), V2 = new Int32Array(h.n * 2);
    K2.set(g.heapK); V2.set(g.heapV); g.heapK = K2; g.heapV = V2;
  }
  const HK = g.heapK, HV = g.heapV;
  let i = h.n++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (HK[p] <= k) break;
    HK[i] = HK[p]; HV[i] = HV[p]; i = p;
  }
  HK[i] = k; HV[i] = v;
}
function pop(g, h) {
  const HK = g.heapK, HV = g.heapV, top = HV[0], k = HK[--h.n], v = HV[h.n];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= h.n) break;
    if (c + 1 < h.n && HK[c + 1] < HK[c]) c++;
    if (HK[c] >= k) break;
    HK[i] = HK[c]; HV[i] = HV[c]; i = c;
  }
  HK[i] = k; HV[i] = v;
  return top;
}

// Shortest distances from candidate a to the nodes of `targets` (candidates), up to `bound` metres.
// Afterwards dist(g, node) is the exact distance for settled nodes (Infinity otherwise); g.pred links
// back to a's edge (-1). The heuristic (distance to the targets' bounding circle) keeps it consistent.
function search(g, a, targets, bound) {
  const ep = nextEpoch(g), h = { n: 0 };
  let cx = 0, cy = 0, m = 0, R = 0, left = 0;
  for (const t of targets) {
    for (const v of [g.eu[t.e], g.ev[t.e]]) {
      if (g.tmark[v] !== ep) { g.tmark[v] = ep; left++; cx += g.X[v]; cy += g.Y[v]; m++; }
    }
  }
  cx /= m; cy /= m;
  for (const t of targets) for (const v of [g.eu[t.e], g.ev[t.e]]) R = Math.max(R, Math.hypot(g.X[v] - cx, g.Y[v] - cy));
  const H = (v) => Math.max(0, Math.hypot(g.X[v] - cx, g.Y[v] - cy) - R);
  const start = (v, d) => {
    if (g.stamp[v] === ep && g.gs[v] <= d) return;
    g.stamp[v] = ep; g.gs[v] = d; g.pred[v] = -1; push(g, h, d + H(v), v);
  };
  const L = g.len[a.e];
  start(g.eu[a.e], a.f * L);
  start(g.ev[a.e], (1 - a.f) * L);
  while (h.n) {
    const f = g.heapK[0], v = pop(g, h);
    if (g.closed[v] === ep) continue;
    if (f > bound) break;
    g.closed[v] = ep;
    if (g.tmark[v] === ep && --left === 0) break;
    const gv = g.gs[v];
    for (let k = g.off[v], kn = g.off[v + 1]; k < kn; k++) {
      const w = g.adjN[k];
      if (g.closed[w] === ep) continue;
      const d = gv + g.len[g.adjE[k]];
      if (g.stamp[w] !== ep || d < g.gs[w]) { g.stamp[w] = ep; g.gs[w] = d; g.pred[w] = v; push(g, h, d + H(w), w); }
    }
  }
  return ep;
}
const dist = (g, ep, v) => (g.closed[v] === ep ? g.gs[v] : Infinity);

// Route length from a to b after search(a): along the shared edge, or via one of b's edge's ends.
function routeTo(g, ep, a, b) {
  const L = g.len[b.e];
  if (a.e === b.e) return { d: Math.abs(a.f - b.f) * L, via: -1 };
  const du = dist(g, ep, g.eu[b.e]) + b.f * L, dv = dist(g, ep, g.ev[b.e]) + (1 - b.f) * L;
  return du <= dv ? { d: du, via: g.eu[b.e] } : { d: dv, via: g.ev[b.e] };
}

// ---------------------------------------------------------------- matching
// Fixes worth matching: accurate enough, not a jump nobody could walk, not on top of the last one.
export function cleanFixes(path) {
  const ok = (path || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (p[2] == null || p[2] <= MAX_ACC));
  const geo = (a, b) => {
    const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r;
    return Math.hypot(x, y) * 6371e3;
  };
  const speed = (a, b) => Math.max(0, geo(a, b) - (a[2] || 0) - (b[2] || 0)) / Math.max(1, Math.abs(b[3] - a[3]));
  // A jump nobody could walk: the new fix is junk, unless it's the first fix that was (the next one
  // agrees with the new fix and not with it).
  const good = [];
  ok.forEach((p, i) => {
    const last = good[good.length - 1], next = ok[i + 1];
    if (!last || speed(last, p) <= MAX_SPEED) good.push(p);
    else if (good.length === 1 && next && speed(p, next) <= MAX_SPEED && speed(last, next) > MAX_SPEED) good[0] = p;
  });
  // Dense tracks (OwnTracks: a fix every few metres) are thinned to at most MAX_FIXES.
  let total = 0;
  for (let i = 1; i < good.length; i++) total += geo(good[i - 1], good[i]);
  const step = Math.max(MIN_STEP, total / MAX_FIXES), out = [];
  for (const p of good) {
    if (out.length && geo(out[out.length - 1], p) < step) continue;
    out.push(p);
  }
  // Keep where the walk ended even when it's close to the previous fix.
  const last = good[good.length - 1];
  if (last && out[out.length - 1] !== last && out.length > 1) out[out.length - 1] = last;
  return out;
}

// One walker's fixes [[lat, lon, acc, t], ...] → {line: [[lat, lon], ...], m, fixes, matched}, or null
// when there aren't enough fixes on the graph (e.g. a walk outside its area).
export function snapPath(g, path) {
  if (!g) return null;
  const fixes = cleanFixes(path);
  const steps = [];
  for (const p of fixes) {
    const [x, y] = toXY(g, p[0], p[1]), acc = p[2] == null ? 15 : p[2];
    const r = Math.max(acc * 2, 25), c = candidates(g, x, y, r);
    if (c.length) steps.push({ x, y, t: p[3], sigma: Math.min(30, Math.max(5, acc * 0.75)), c });
  }
  if (steps.length < 2 || steps.length < fixes.length / 2) return null;

  // Viterbi over log probabilities.
  for (const c of steps[0].c) { c.score = -0.5 * (c.d / steps[0].sigma) ** 2; c.back = -1; }
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1], cur = steps[i];
    const gc = Math.hypot(cur.x - prev.x, cur.y - prev.y), beta = 10 + 0.25 * gc;
    const bound = 2 * gc + 300 + 2 * Math.max(...prev.c.map((c) => c.d), ...cur.c.map((c) => c.d));
    for (const b of cur.c) { b.score = -Infinity; b.back = -1; }
    prev.c.forEach((a, j) => {
      if (a.score === -Infinity) return;
      const ep = search(g, a, cur.c, bound);
      for (const b of cur.c) {
        const { d } = routeTo(g, ep, a, b);
        if (d > bound) continue;
        const s = a.score - Math.abs(d - gc) / beta;
        if (s > b.score) { b.score = s; b.back = j; }
      }
    });
    cur.broken = cur.c.every((b) => b.back < 0);
    for (const b of cur.c) b.score = (cur.broken ? 0 : b.score) - 0.5 * (b.d / cur.sigma) ** 2;
  }

  // Back-track, then join consecutive matches by their shortest path.
  const pick = new Array(steps.length);
  for (let i = steps.length - 1, j = argmax(steps[i].c); i >= 0; i--) {
    pick[i] = steps[i].c[j];
    if (i) j = steps[i].broken ? argmax(steps[i - 1].c) : pick[i].back;
  }
  const xy = [[pick[0].x, pick[0].y]];
  const add = (x, y) => { const l = xy[xy.length - 1]; if (Math.abs(l[0] - x) > 0.05 || Math.abs(l[1] - y) > 0.05) xy.push([x, y]); };
  for (let i = 1; i < steps.length; i++) {
    const a = pick[i - 1], b = pick[i];
    if (!steps[i].broken && a.e !== b.e) {
      const gc = Math.hypot(steps[i].x - steps[i - 1].x, steps[i].y - steps[i - 1].y);
      const ep = search(g, a, [b], Infinity), { d, via } = routeTo(g, ep, a, b);
      if (Number.isFinite(d) && d <= 2 * gc + 1000) {
        const nodes = [];
        for (let v = via; v >= 0; v = g.pred[v]) nodes.push(v);
        for (let k = nodes.length - 1; k >= 0; k--) add(g.X[nodes[k]], g.Y[nodes[k]]);
      }
    }
    add(b.x, b.y);
  }
  dropSpurs(xy);
  let m = 0;
  for (let i = 1; i < xy.length; i++) m += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  const line = simplify(xy, 1.5).map((p) => toLL(g, p[0], p[1]));
  return { line, m: Math.round(m), fixes: fixes.length, matched: steps.length };
}
// Short out-and-back detours (a fix matched to a side path a few metres off the way, then back):
// the line goes A … B … A within SPUR metres. Longer ones are real (the end of a dead end and back).
const SPUR = 30;
function dropSpurs(xy) {
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
  for (let i = 1; i < xy.length - 1; i++) {
    if (!same(xy[i - 1], xy[i + 1])) continue;
    let k = 1, len = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    while (i - k - 1 >= 0 && i + k + 1 < xy.length && same(xy[i - k - 1], xy[i + k + 1])) {
      len += Math.hypot(xy[i - k][0] - xy[i - k - 1][0], xy[i - k][1] - xy[i - k - 1][1]);
      k++;
    }
    if (len <= SPUR) { xy.splice(i - k + 1, 2 * k); i = Math.max(0, i - k - 1); }
  }
}
const argmax = (cs) => cs.reduce((bi, c, j) => (c.score > cs[bi].score ? j : bi), 0);

// Douglas-Peucker in metres (iterative).
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
  keep[0] = keep[pts.length - 1] = 1;
  while (stack.length) {
    const [s, e] = stack.pop(), [ax, ay] = pts[s], [bx, by] = pts[e], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i], f = l2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(px - ax - f * dx, py - ay - f * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((p, i) => keep[i]);
}

// All walkers' paths ({who: [[lat, lon, acc, t]]}) → the route event's snapped fields, or null without
// a graph. Walkers that couldn't be matched are left out (the map draws their raw fixes).
export function snapRoute(g, paths) {
  if (!g || !paths) return null;
  const snapped = {}, distances = {};
  for (const [who, list] of Object.entries(paths)) {
    let r = null;
    try { r = snapPath(g, list); } catch (e) { console.error('snap ' + who + ':', e.message || e); }
    if (r && r.line.length > 1) { snapped[who] = r.line; distances[who] = r.m; }
  }
  return {
    snapped, snapped_distances: distances, snapped_m: Object.keys(distances).length ? Math.max(...Object.values(distances)) : null,
    snap: { v: SNAP_VERSION, graph: g.buildId },
  };
}
