// Deploys the frame-data Worker to the Azure VM (run by `npm run deploy` from dashboard/, after the
// dashboard build). The Worker runs there under Miniflare/workerd (worker/vm), because Cloudflare's
// free plan kept killing requests at its 10 ms CPU limit; the Cloudflare Worker is now a proxy to it.
//
// Bundles the Worker with wrangler (no Cloudflare upload), packs it with dist/ and the runner, and
// streams it over SSH to `frame-data-release` on the VM, which installs it, restarts the service,
// health-checks it and rolls back on failure.
// Secrets: the VM keeps a base set; this deploy adds/overrides the non-VITE_* entries of .env.local
// (and worker/.dev.vars when present), like Cloudflare keeps Worker secrets a deploy doesn't mention.
// Env: FRAME_DATA_VM (ssh target), FRAME_DATA_SSH_KEY (identity file; default ~/.ssh/ha_azure_vm if present).
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { notifyFrames, workerSecrets } from './notify.mjs';

const VM = process.env.FRAME_DATA_VM || 'framedeploy@harsh-ha.eastus.cloudapp.azure.com';
const defaultKey = join(homedir(), '.ssh/ha_azure_vm');
const KEY = process.env.FRAME_DATA_SSH_KEY || (existsSync(defaultKey) ? defaultKey : '');

const readEnv = (f) => (existsSync(f) ? parseEnv(readFileSync(f, 'utf8')) : {});
const env = readEnv('.env.local');
const secrets = { ...readEnv('worker/.dev.vars'), ...workerSecrets(env) };
const quote = (k, v) => {
  if (/['\n]/.test(v)) throw new Error(`${k} has a quote or newline, which the VM's env file can't hold`);
  return `${k}='${v}'`;
};

const stage = mkdtempSync(join(tmpdir(), 'frame-data-'));
try {
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', join(stage, 'worker'), '--config', 'worker/wrangler.jsonc'], { stdio: ['ignore', 'ignore', 'inherit'] });
  cpSync('dist', join(stage, 'dist'), { recursive: true });
  for (const f of ['server.mjs', 'package.json', 'package-lock.json']) cpSync(join('worker/vm', f), join(stage, f));
  // The walk graph (scripts/walk-graph.mjs) when this checkout has one; the VM keeps the last one it got.
  if (existsSync('worker/data/walk-graph.bin')) { cpSync('worker/data/walk-graph.bin', join(stage, 'walk-graph.bin')); console.log('Shipping the walk graph'); }
  writeFileSync(join(stage, 'secrets.env'), Object.entries(secrets).map(([k, v]) => quote(k, v)).join('\n') + '\n', { mode: 0o600 });
  console.log('Worker secrets from .env.local/.dev.vars:', Object.keys(secrets).join(', '));

  const tarball = join(stage, '..', `${stage.split('/').pop()}.tgz`);
  execFileSync('tar', ['-czf', tarball, '--no-xattrs', '--exclude', 'README.md', '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  try {
    const ssh = ['-o', 'BatchMode=yes', ...(KEY ? ['-i', KEY] : []), VM, 'frame-data-release'];
    execFileSync('ssh', ssh, { input: readFileSync(tarball), stdio: ['pipe', 'inherit', 'inherit'] });
  } finally {
    rmSync(tarball, { force: true });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

await notifyFrames(env);
