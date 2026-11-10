// Writes the walk log's WALK_KEY (read + write) and the agents' AGENT_CAL_KEY to .dev.vars.walk-keys
// (gitignored) without printing it. The Worker derives the same key from PUSH_TOKEN unless
// a WALK_KEY secret is set. Run from dashboard/: node worker/scripts/walk-keys.mjs
// Add --print to show it (only on a screen nobody else can see).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const dir = new URL('..', import.meta.url);
const vars = Object.fromEntries(readFileSync(new URL('.dev.vars', dir), 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
if (!vars.PUSH_TOKEN) throw new Error('PUSH_TOKEN missing from worker/.dev.vars');
const key = (name) => vars[name] || createHmac('sha256', vars.PUSH_TOKEN).update('frame-data/' + name + '/v1').digest('base64url');
const out = { WALK_KEY: key('WALK_KEY'), AGENT_CAL_KEY: key('AGENT_CAL_KEY') };
writeFileSync(new URL('.dev.vars.walk-keys', dir), Object.entries(out).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 });
console.log('Wrote worker/.dev.vars.walk-keys (' + Object.keys(out).join(', ') + ')');
if (process.argv.includes('--print')) for (const [k, v] of Object.entries(out)) console.log(k + '=' + v);
