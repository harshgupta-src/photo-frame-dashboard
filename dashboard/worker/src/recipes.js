// Recipes for the dashboard's Recipes tab (../../RECIPES.md): the notes in one Obsidian vault folder,
// read through the Home Brain MCP gateway with a token that can only list and read that folder.
//   GET /recipes  ?key=READ_KEY  {updated, recipes: [{id, title, summary, updated, body}]}, newest first.
//                                Cached RECIPES_TTL seconds in KV; &refresh=1 reads the vault now.
// Secrets: VAULT_MCP_URL (the gateway's /mcp URL), VAULT_MCP_TOKEN (its read-only frame-recipes token).
// Optional: RECIPES_PATH (vault folder, default Areas/Hobbies/Recipes).

const RECIPES_TTL = 600;
const REFRESH_MIN = 15; // seconds between forced refreshes, so a pull-to-refresh loop can't hammer the gateway
const DEFAULT_PATH = 'Areas/Hobbies/Recipes';

export class VaultError extends Error {}

// One stateless MCP tools/call. The gateway answers with JSON, or an SSE stream when it prefers.
async function mcpCall(env, name, args) {
  const r = await fetch(env.VAULT_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.VAULT_MCP_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new VaultError(`vault gateway answered ${r.status}`);
  const text = await r.text();
  const raw = /^\s*\{/.test(text) ? text : (text.match(/^data:\s*(\{.*\})\s*$/m) || [])[1];
  if (!raw) throw new VaultError('unexpected answer from the vault gateway');
  const msg = JSON.parse(raw);
  if (msg.error) throw new VaultError(msg.error.message || 'vault gateway error');
  const out = (msg.result && msg.result.content || []).map((c) => c.text || '').join('');
  if (msg.result && msg.result.isError) throw new VaultError(out || `${name} failed`);
  return out;
}

const stripLinks = (s) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');

// A recipe note: frontmatter, "# Title", "> one-line summary", then ## sections. The body keeps the
// sections as markdown; the dashboard renders them.
export function parseRecipe(file, note) {
  let md = String(note.content || '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  let title = file.replace(/\.md$/i, '');
  const h1 = md.match(/^\s*# +(.+)\n?/);
  if (h1) { title = h1[1].trim(); md = md.slice(h1.index + h1[0].length); }
  let summary = '';
  const quote = md.match(/^\s*((?:> ?.*(?:\n|$))+)/);
  if (quote) {
    summary = stripLinks(quote[1].replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim());
    md = md.slice(quote.index + quote[0].length);
  }
  const fm = note.frontmatter || {};
  const updated = String(fm.updated || note.mtime || '').slice(0, 10);
  return { id: title, title, summary, updated, body: md.trim() };
}

export async function readRecipes(env) {
  const folder = String(env.RECIPES_PATH || DEFAULT_PATH).replace(/\/+$/, '');
  const files = JSON.parse(await mcpCall(env, 'vault_list', { path: folder })).filter((f) => /\.md$/i.test(f) && !f.includes('/'));
  const recipes = [];
  for (let i = 0; i < files.length; i += 6) {
    const batch = await Promise.all(files.slice(i, i + 6).map(async (f) =>
      parseRecipe(f, JSON.parse(await mcpCall(env, 'vault_read', { path: folder + '/' + f })))));
    recipes.push(...batch);
  }
  recipes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.title.localeCompare(b.title)));
  return { updated: new Date().toISOString(), recipes };
}

export async function recipesRoute(url, env, ctx) {
  if (!env.VAULT_MCP_URL || !env.VAULT_MCP_TOKEN) {
    return { status: 503, body: { error: 'recipes are not configured (VAULT_MCP_URL, VAULT_MCP_TOKEN)' } };
  }
  const cached = await env.DATA.get('recipes', 'json');
  const age = cached ? (Date.now() - Date.parse(cached.updated)) / 1000 : Infinity;
  const force = url.searchParams.get('refresh') === '1' && age > REFRESH_MIN;
  if (cached && !force && age < RECIPES_TTL) return { status: 200, body: cached };
  try {
    const fresh = await readRecipes(env);
    ctx.waitUntil(env.DATA.put('recipes', JSON.stringify(fresh)));
    return { status: 200, body: fresh };
  } catch (e) {
    if (cached) return { status: 200, body: { ...cached, stale: true, error: e.message } };
    return { status: 502, body: { error: e.message } };
  }
}
