// Builds the pedestrian graph that snaps walk routes to footpaths (src/snap.js, ../../WALKS.md
// "Snapped routes"). Runs offline on a Mac: it reads an OpenStreetMap extract (Geofabrik's
// Massachusetts by default, downloaded once), cuts a square around home with osmium, keeps what
// people walk on, and writes worker/data/walk-graph.bin (gitignored: it would say where home is).
// No walk data is involved, and nothing about the walks is sent anywhere.
//
//   brew install osmium-tool
//   node worker/scripts/walk-graph.mjs --center <lat>,<lon> [--km 6] [--pbf file.osm.pbf] [--out file]
//
// The center can also come from WALK_GRAPH_CENTER. `npm run deploy` from the Mac ships the file; the
// VM keeps it across deploys (vm/server.mjs), so CI deploys don't need it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeGraph, decodeGraph } from '../src/snap.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? a.concat([[x.slice(2), all[i + 1]]]) : a), []));
const center = String(args.center || process.env.WALK_GRAPH_CENTER || '').split(',').map(Number);
if (center.length !== 2 || !center.every(Number.isFinite)) {
  console.error('usage: node worker/scripts/walk-graph.mjs --center <lat>,<lon> [--km 6] [--pbf file] [--out file]');
  process.exit(2);
}
const KM = Number(args.km || 6);
const DATA = 'worker/data';
const OUT = args.out || join(DATA, 'walk-graph.bin');
const URL_PBF = 'https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf';
mkdirSync(DATA, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

let pbf = args.pbf;
if (!pbf) {
  pbf = join(DATA, 'massachusetts-latest.osm.pbf');
  const old = existsSync(pbf) && Date.now() - statSync(pbf).mtimeMs > 30 * 864e5;
  if (!existsSync(pbf) || old) {
    console.log('downloading ' + URL_PBF);
    execFileSync('curl', ['-fsSL', '-o', pbf, URL_PBF], { stdio: 'inherit' });
  }
}

const [lat, lon] = center, dLat = KM / 2 / 111.1, dLon = KM / 2 / (111.3 * Math.cos(lat * Math.PI / 180));
const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(5)).join(',');
const area = join(DATA, 'walk-area.osm.pbf'), ways = join(DATA, 'walk-ways.osm.pbf');
const osmium = (...a) => execFileSync('osmium', a, { stdio: ['ignore', 'inherit', 'inherit'] });
const WALKABLE = ['footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'track',
  'cycleway', 'bridleway', 'corridor', 'road', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
  'trunk', 'trunk_link'];
osmium('extract', '-b', bbox, '-s', 'smart', pbf, '-o', area, '--overwrite');
osmium('tags-filter', area, 'w/highway=' + WALKABLE.join(','), '-o', ways, '--overwrite');
const opl = execFileSync('osmium', ['add-locations-to-ways', ways, '-f', 'opl', '-o', '-'], { maxBuffer: 1 << 30 }).toString();
rmSync(area, { force: true }); rmSync(ways, { force: true });

const unesc = (s) => s.replace(/%([0-9a-f]+)%/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const MAJOR = /^(tertiary|secondary|primary)(_link)?$/;
const YES = /^(yes|designated|permissive|destination)$/;
function walkable(t) {
  const h = t.highway;
  if (!WALKABLE.includes(h) || t.area === 'yes' && h !== 'pedestrian') return false;
  if (/^(no|private)$/.test(t.foot || '')) return false;
  // Parking aisles and driveways only pull noisy fixes near buildings into loops and spurs.
  if (h === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(t.service || '') && !YES.test(t.foot || '')) return false;
  if (/^(no|private)$/.test(t.access || '') && !YES.test(t.foot || '')) return false;
  const sidewalk = [t.sidewalk, t['sidewalk:both'], t['sidewalk:left'], t['sidewalk:right']].filter(Boolean);
  const hasSidewalk = sidewalk.some((s) => /^(both|left|right|yes|separate)$/.test(s));
  if (/^trunk/.test(h)) return hasSidewalk || YES.test(t.foot || '');
  if (MAJOR.test(h)) return !(t.sidewalk && /^(no|none)$/.test(t.sidewalk)) || YES.test(t.foot || '');
  return true;
}

// Ways → node runs; then a node is kept when it's a way end or shared (a junction), and the shape
// points in between are thinned (Douglas-Peucker, 1 m).
const runs = [], uses = new Map(), loc = new Map();
for (const line of opl.split('\n')) {
  if (line[0] !== 'w') continue;
  const f = Object.fromEntries(line.split(' ').slice(1).map((x) => [x[0], x.slice(1)]));
  const tags = {};
  for (const kv of (f.T || '').split(',')) { const i = kv.indexOf('='); if (i > 0) tags[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1)); }
  if (!walkable(tags)) continue;
  const ids = [];
  for (const n of (f.N || '').split(',')) {
    const m = /^n(\d+)x([-\d.]+)y([-\d.]+)$/.exec(n);
    if (!m) continue; // a node outside the extract
    loc.set(m[1], [+m[3], +m[2]]);
    ids.push(m[1]);
  }
  if (ids.length < 2) continue;
  runs.push(ids);
  ids.forEach((id, i) => uses.set(id, (uses.get(id) || 0) + (i === 0 || i === ids.length - 1 ? 2 : 1)));
}
const ky = 111132, kx = 111320 * Math.cos(lat * Math.PI / 180);
const xy = (id) => { const p = loc.get(id); return [(p[1] - lon) * kx, (p[0] - lat) * ky]; };
function dp(ids) {
  const keep = new Uint8Array(ids.length); keep[0] = keep[ids.length - 1] = 1;
  const st = [[0, ids.length - 1]];
  while (st.length) {
    const [s, e] = st.pop(), [ax, ay] = xy(ids[s]), [bx, by] = xy(ids[e]), dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy(ids[i]), t = l2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > 1) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
  }
  return ids.filter((_, i) => keep[i]);
}
const index = new Map(), nodes = [], edgeSet = new Set(), edges = [];
const idx = (id) => { if (!index.has(id)) { index.set(id, nodes.length); nodes.push(loc.get(id)); } return index.get(id); };
for (const ids of runs) {
  let piece = [ids[0]];
  const kept = [];
  for (let i = 1; i < ids.length; i++) {
    piece.push(ids[i]);
    if (uses.get(ids[i]) > 1 || i === ids.length - 1) { kept.push(...(kept.length ? dp(piece).slice(1) : dp(piece))); piece = [ids[i]]; }
  }
  for (let i = 1; i < kept.length; i++) {
    const a = idx(kept[i - 1]), b = idx(kept[i]), k = a < b ? a + ':' + b : b + ':' + a;
    if (a === b || edgeSet.has(k)) continue;
    edgeSet.add(k); edges.push([a, b]);
  }
}

// Drop islands shorter than 300 m (bits of path that don't connect to anything: they'd only trap matches).
const adj = nodes.map(() => []);
edges.forEach(([a, b], i) => { adj[a].push(i); adj[b].push(i); });
const comp = new Int32Array(nodes.length).fill(-1), compLen = [];
const elen = ([a, b]) => { const p = nodes[a], q = nodes[b]; return Math.hypot((p[1] - q[1]) * kx, (p[0] - q[0]) * ky); };
for (let s = 0; s < nodes.length; s++) {
  if (comp[s] >= 0) continue;
  const c = compLen.length, st = [s]; let L = 0; comp[s] = c;
  while (st.length) {
    const v = st.pop();
    for (const e of adj[v]) {
      const w = edges[e][0] === v ? edges[e][1] : edges[e][0];
      L += elen(edges[e]); // each edge is seen from both ends
      if (comp[w] < 0) { comp[w] = c; st.push(w); }
    }
  }
  compLen.push(L / 2);
}
const keepNode = nodes.map((_, i) => compLen[comp[i]] >= 300), remap = new Int32Array(nodes.length).fill(-1), outNodes = [];
nodes.forEach((p, i) => { if (keepNode[i]) { remap[i] = outNodes.length; outNodes.push(p); } });
const outEdges = edges.filter(([a]) => keepNode[a]).map(([a, b]) => [remap[a], remap[b]]);

const bin = encodeGraph(outNodes, outEdges, Math.floor(Date.now() / 1000));
const g = decodeGraph(bin);
if (!g) throw new Error('graph did not decode');
writeFileSync(OUT, bin);
const km = Array.from(g.len).reduce((s, v) => s + v, 0) / 1000;
console.log(`${OUT}: ${outNodes.length} nodes, ${outEdges.length} edges, ${km.toFixed(0)} km of ways, ${(bin.byteLength / 1024).toFixed(0)} KB ` +
  `(${KM} km square; dropped ${nodes.length - outNodes.length} island nodes)`);
