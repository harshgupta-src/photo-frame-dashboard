// Deploys the frame-data Worker (run by `npm run deploy` from dashboard/, after the dashboard build).
// Any KEY=value in .env.local that isn't VITE_* is uploaded as a Worker secret with the deploy
// (e.g. HA_REMINDERS_WEBHOOK_URL), so CI can set Worker secrets through the DASHBOARD_ENV secret.
// Vite only bakes VITE_* into the dashboard. Secrets not listed are kept, never deleted.
// HA_DEPLOY_WEBHOOK_URL stays local: after the deploy it tells Home Assistant, which pushes the news
// to the frames over MQTT (ha/dashboard-update.yaml), so they update without waiting for a poll.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { assetKey } from '../../js/update.js';

const LOCAL_ONLY = ['HA_DEPLOY_WEBHOOK_URL'];

const args = ['wrangler', 'deploy', '--config', 'worker/wrangler.jsonc'];
const env = existsSync('.env.local') ? parseEnv(readFileSync('.env.local', 'utf8')) : {};
const secrets = Object.fromEntries(Object.entries(env).filter(([k, v]) => !k.startsWith('VITE_') && !LOCAL_ONLY.includes(k) && v));
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

if (env.HA_DEPLOY_WEBHOOK_URL) {
  const build = existsSync('dist/index.html') ? assetKey(readFileSync('dist/index.html', 'utf8')) : '';
  try {
    const r = await fetch(env.HA_DEPLOY_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ build }), signal: AbortSignal.timeout(10000),
    });
    console.log(r.ok ? 'Frames notified through Home Assistant' : `HA deploy webhook answered ${r.status}; frames will pick the build up on their next poll`);
  } catch (e) {
    console.warn(`Couldn't reach the HA deploy webhook (${e.message}); frames will pick the build up on their next poll`);
  }
}
