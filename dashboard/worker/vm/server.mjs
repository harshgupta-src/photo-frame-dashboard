// Runs the frame-data Worker on the Azure VM under Miniflare (workerd, the open-source Workers runtime),
// so it isn't held to Cloudflare's 10 ms CPU limit. KV and the Cache API persist on disk, the dashboard is
// served from dist/ like the Workers assets binding, and the secrets come from an env file.
// The Cloudflare Worker (vm/proxy.js) forwards to it. See vm/README.md.
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';

const APP = process.env.FRAME_DATA_APP || '/opt/frame-data/current';
const STATE = process.env.FRAME_DATA_STATE || '/var/lib/frame-data';
const SECRETS = process.env.FRAME_DATA_SECRETS || '/etc/frame-data/secrets.env';
const PORT = +(process.env.FRAME_DATA_PORT || 8791);

// Base secrets live on the VM; each release can add or override some (from the deploy's .env.local),
// the same way Cloudflare keeps Worker secrets that a deploy doesn't mention.
const envFile = (f) => (existsSync(f) ? parseEnv(readFileSync(f, 'utf8')) : {});
const bindings = { ...envFile(SECRETS), ...envFile(APP + '/secrets.env') };

const mf = new Miniflare({
  host: '127.0.0.1',
  port: PORT,
  log: new Log(LogLevel.WARN),
  modules: true,
  scriptPath: APP + '/worker/index.js',
  modulesRoot: APP + '/worker',
  compatibilityDate: '2026-07-30',
  kvNamespaces: ['DATA'],
  kvPersist: STATE + '/kv',
  cachePersist: STATE + '/cache',
  assets: {
    directory: APP + '/dist',
    binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
  },
  bindings,
});

const url = await mf.ready;
console.log('frame-data listening on ' + url.href);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await mf.dispose();
    process.exit(0);
  });
}
