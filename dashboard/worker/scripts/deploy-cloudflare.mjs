// Fallback: deploys the full frame-data Worker to Cloudflare (`npm run deploy:cloudflare` from dashboard/).
// Normally the Worker runs on the Azure VM (`npm run deploy`, worker/scripts/deploy-vm.mjs) and the
// Cloudflare Worker is only a proxy to it (`npm run deploy:proxy`); this puts the whole Worker back on
// Cloudflare, e.g. if the VM is down. It reads Cloudflare KV, which goes stale while the VM is primary,
// and is held to the free plan's 10 ms CPU limit (worker/vm/README.md).
// Any KEY=value in .env.local that isn't VITE_* is uploaded as a Worker secret with the deploy
// (e.g. HA_REMINDERS_WEBHOOK_URL). Secrets not listed are kept, never deleted.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { notifyFrames, workerSecrets } from './notify.mjs';

const args = ['wrangler', 'deploy', '--config', 'worker/wrangler.jsonc'];
const env = existsSync('.env.local') ? parseEnv(readFileSync('.env.local', 'utf8')) : {};
const secrets = workerSecrets(env);
const file = 'worker/.deploy-secrets.json';
try {
  if (Object.keys(secrets).length) {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    args.push('--secrets-file', file);
    console.log('Worker secrets from .env.local:', Object.keys(secrets).join(', '));
  }
  execFileSync('npx', args, { stdio: 'inherit' });
} finally {
  rmSync(file, { force: true });
}

await notifyFrames(env);
