import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { assetsInHtml, assetKey, decide, markApplied, readApplied, APPLY_KEY, RETRY_MS } from '../js/update.js';

const JS = '/assets/index-ByMPnB_y.js', CSS = '/assets/index-BYvSMPBU.css';
const page = (head, body = '') => `<!doctype html><html><head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo&display=swap">
  ${head}
</head><body>${body}
  <script>setTimeout(function () { if (!window.App) location.reload(); }, 10000);</script>
</body></html>`;
const BUILT = page(`<script type="module" crossorigin src="${JS}"></script>\n  <link rel="stylesheet" crossorigin href="${CSS}">`);
// What app.js reads on the running page: outerHTML of each script[src]/link[href] node, as Chromium
// serializes them (lower-case, double quotes, boolean attributes as ="").
const domSide = (srcs, hrefs) => [
  ...srcs.map((s) => `<script type="module" crossorigin="" src="${s}"></script>`),
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo&amp;display=swap">',
  ...hrefs.map((h) => `<link rel="stylesheet" crossorigin="" href="${h}">`),
].join('\n');
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('same deployment through both paths (fetched index.html vs the page\'s own tags) is not an update', () => {
  assert.deepEqual(assetsInHtml(BUILT), [CSS, JS].sort());
  assert.equal(assetKey(BUILT), assetKey(domSide([JS], [CSS])));
  assert.equal(decide({}, assetKey(domSide([JS], [CSS])), assetKey(BUILT), mem(), 0), 'none');
});

test('the real dist/index.html agrees with its own DOM-side serialization', { skip: !existsSync(new URL('../dist/index.html', import.meta.url)) }, () => {
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const list = assetsInHtml(html);
  assert.ok(list.length >= 2, 'built page references its hashed bundle');
  const dom = domSide(list.filter((a) => a.endsWith('.js')), list.filter((a) => a.endsWith('.css')));
  assert.equal(decide({}, assetKey(dom), assetKey(html), mem(), 0), 'none');
});

test('duplicate and non-tag references in the HTML do not count as an update', () => {
  const dup = page(
    `<link rel="modulepreload" crossorigin href="${JS}">\n  <script type="module" crossorigin src='${JS}'></script>\n  <LINK REL=stylesheet HREF=${CSS}>\n  <link rel="stylesheet" href="${CSS}?v=1">`,
    `<!-- old: <script src="/assets/index-OLD.js"></script> -->
     <script>var tpl = '<link rel="stylesheet" href="/assets/injected-X.css">'; // "${JS}"</script>
     <p>see /assets/readme-Z.js</p>`);
  assert.deepEqual(assetsInHtml(dup), [CSS, JS].sort());
  assert.equal(decide({}, assetKey(domSide([JS], [CSS])), assetKey(dup), mem(), 0), 'none');
  // The old check (regex over raw text vs DOM list) called this an update, every 5 minutes, forever.
  const legacy = (html) => html.match(/\/assets\/[^"']+\.(?:js|css)/g).slice().sort().join(' ');
  assert.notEqual(legacy(dup), [JS, CSS].sort().join(' '));
});

test('a new asset hash is an update, applied after two consecutive sightings, once', () => {
  const store = mem(), state = {}, mine = assetKey(BUILT);
  const live = assetKey(BUILT.replace(JS, '/assets/index-NEWHASH1.js'));
  assert.notEqual(live, mine);
  assert.equal(decide(state, mine, live, store, 1000), 'seen');
  assert.equal(decide(state, mine, live, store, 2000), 'apply');
  assert.equal(markApplied(store, live, 2000), true);
  assert.equal(readApplied(store).key, live);
  // Reload landed on the old build again (stale cache, rolling deploy): no second reload.
  assert.equal(markApplied(store, live, 3000), false);
});

test('a flapping or failed check resets the confirmation', () => {
  const state = {}, mine = assetKey(BUILT);
  const a = assetKey(BUILT.replace(JS, '/assets/index-A.js')), b = assetKey(BUILT.replace(JS, '/assets/index-B.js'));
  assert.equal(decide(state, mine, a, mem(), 0), 'seen');
  assert.equal(decide(state, mine, '', mem(), 0), 'none'); // portal / 401 / offline
  assert.equal(decide(state, mine, a, mem(), 0), 'seen');
  assert.equal(decide(state, mine, b, mem(), 0), 'seen');
  assert.equal(decide(state, mine, mine, mem(), 0), 'none');
});

test('the persisted guard blocks re-applying the same build for 6 hours, not other builds', () => {
  const store = mem(), mine = assetKey(BUILT), t = Date.UTC(2026, 10, 10);
  const live = assetKey(BUILT.replace(CSS, '/assets/index-NEW.css'));
  store.setItem(APPLY_KEY, JSON.stringify({ key: live, at: t }));
  const state = {};
  assert.equal(decide(state, mine, live, store, t + 60e3), 'seen');
  assert.equal(decide(state, mine, live, store, t + 6 * 60e3), 'blocked');
  assert.equal(decide(state, mine, live, store, t + RETRY_MS + 1), 'apply');
  const other = assetKey(BUILT.replace(CSS, '/assets/index-NEWER.css'));
  const s2 = {};
  decide(s2, mine, other, store, t + 60e3);
  assert.equal(decide(s2, mine, other, store, t + 6 * 60e3), 'apply');
});

test('a pushed deploy applies on the first sighting, but still not twice in 6 hours', () => {
  const store = mem(), mine = assetKey(BUILT), t = Date.UTC(2026, 10, 12);
  const live = assetKey(BUILT.replace(JS, '/assets/index-PUSHED.js'));
  assert.equal(decide({}, mine, mine, store, t, 1), 'none'); // deploy not propagated yet
  assert.equal(decide({}, mine, live, store, t, 1), 'apply');
  markApplied(store, live, t);
  assert.equal(decide({}, mine, live, store, t + 60e3, 1), 'blocked');
});
