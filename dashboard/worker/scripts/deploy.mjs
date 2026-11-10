// Deploys the frame-data Worker (run by `npm run deploy` from dashboard/, after the dashboard build).
// Any KEY=value in .env.local that isn't VITE_* is uploaded as a Worker secret with the deploy
// (e.g. HA_REMINDERS_WEBHOOK_URL), so CI can set Worker secrets through the DASHBOARD_ENV secret.
// Vite only bakes VITE_* into the dashboard. Secrets not listed are kept, never deleted.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';

const args = ['wrangler', 'deploy', '--config', 'worker/wrangler.jsonc'];
const env = existsSync('.env.local') ? parseEnv(readFileSync('.env.local', 'utf8')) : {};
const secrets = Object.fromEntries(Object.entries(env).filter(([k, v]) => !k.startsWith('VITE_') && v));
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
