import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipe, recipesRoute } from '../src/recipes.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function kv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}
const ctx = { waitUntil: (p) => p };
const NOTE = (title, updated) => ({
  content: `---\ntype: topic\nupdated: ${updated}\n---\n# ${title}\n\n> Spicy, with [[Toum]] and [[Preferences|heat]].\n> Two lines.\n\n## Recipe\n- 1 kg chicken\n`,
  frontmatter: { updated: updated + 'T00:00:00.000Z' }, mtime: '2026-11-14T14:22:36.864Z',
});

// A fake gateway: answers tools/call for vault_list/vault_read, as JSON or as an SSE event.
function gateway(notes, { sse = false, fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const { params } = JSON.parse(init.body);
    calls.push([params.name, params.arguments.path, init.headers.Authorization]);
    if (fail) return new Response('down', { status: 502 });
    const text = params.name === 'vault_list'
      ? JSON.stringify([...Object.keys(notes), 'Photos/'])
      : JSON.stringify(notes[params.arguments.path.split('/').pop()]);
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
    return new Response(sse ? `event: message\ndata: ${msg}\n\n` : msg, { headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json' } });
  };
  return calls;
}
const env = () => ({ DATA: kv(), VAULT_MCP_URL: 'https://gw/mcp', VAULT_MCP_TOKEN: 'tok' });
const get = (e, q = '') => recipesRoute(new URL('https://w/recipes' + q), e, ctx);

test('parseRecipe takes the title and summary out of the body', () => {
  const r = parseRecipe("General Tso's Chicken.md", NOTE("General Tso's Chicken", '2026-11-14'));
  assert.equal(r.title, "General Tso's Chicken");
  assert.equal(r.summary, 'Spicy, with Toum and heat. Two lines.');
  assert.equal(r.updated, '2026-11-14');
  assert.equal(r.body, '## Recipe\n- 1 kg chicken');
  assert.equal(parseRecipe('Plain.md', { content: 'Just text', mtime: '2026-10-01T00:00:00Z' }).title, 'Plain');
});

test('GET /recipes reads the folder through the gateway, newest first, and caches it', async () => {
  const e = env();
  const calls = gateway({ 'Toum.md': NOTE('Toum', '2026-11-08'), 'Noodles.md': NOTE('Noodles', '2026-11-14') }, { sse: true });
  const r = await get(e);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.recipes.map((x) => x.title), ['Noodles', 'Toum']);
  assert.deepEqual(calls.map((c) => c.slice(0, 2)).sort(), [['vault_list', 'Areas/Hobbies/Recipes'], ['vault_read', 'Areas/Hobbies/Recipes/Noodles.md'], ['vault_read', 'Areas/Hobbies/Recipes/Toum.md']]);
  assert.equal(calls[0][2], 'Bearer tok');
  calls.length = 0;
  assert.equal((await get(e)).body.recipes.length, 2);
  assert.equal((await get(e, '?refresh=1')).body.recipes.length, 2, 'a refresh right after a read uses the cache');
  assert.equal(calls.length, 0);
});

test('GET /recipes serves the last copy when the gateway is down', async () => {
  const e = env();
  gateway({}, { fail: true });
  assert.equal((await get(e)).status, 502);
  e.DATA.m.set('recipes', JSON.stringify({ updated: '2026-01-01T00:00:00Z', recipes: [{ title: 'Toum' }] }));
  const r = await get(e);
  assert.equal(r.status, 200);
  assert.equal(r.body.stale, true);
  assert.equal(r.body.recipes[0].title, 'Toum');
  assert.equal((await recipesRoute(new URL('https://w/recipes'), { DATA: kv() }, ctx)).status, 503);
});
