// Tells Home Assistant a new dashboard build is live (HA_DEPLOY_WEBHOOK_URL in .env.local, never uploaded).
// HA pushes the news to the frames over MQTT (ha/dashboard-update.yaml), so they don't wait for a poll.
import { readFileSync, existsSync } from 'node:fs';
import { assetKey } from '../../js/update.js';

export async function notifyFrames(env) {
  if (!env.HA_DEPLOY_WEBHOOK_URL) return;
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

// Worker secrets from .env.local: every non-empty KEY=value that isn't VITE_* (Vite bakes those into the
// dashboard) or local-only.
export function workerSecrets(env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => !k.startsWith('VITE_') && k !== 'HA_DEPLOY_WEBHOOK_URL' && v));
}
