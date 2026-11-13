// Pushes this Mac's Copilot CLI sessions, the account's other Copilot sessions (GitHub's cloud task
// list, without transcripts) and the plan quota to the Worker's /copilot routes (../../COPILOT.md).
// Run from anywhere: node worker/scripts/copilot-push.mjs [--dry-run] [--force] [--install | --uninstall]
//   --install    adds a LaunchAgent that runs this every 10 minutes (logs: ~/Library/Logs/homehq-copilot-push.log)
// Only transcripts that changed since the last run are sent; the session list goes up when it changes
// or hourly. Needs `gh` logged in to Harsh's account and worker/.dev.vars (PUSH_TOKEN) or COPILOT_KEY.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact, parseLines } from '../src/copilotlog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH = join(HERE, '..', '..');
const HOME = homedir();
const SESSIONS = join(process.env.COPILOT_HOME || join(HOME, '.copilot'), 'session-state');
const STATE = join(HOME, '.config', 'homehq', 'copilot-push-state.json');
const LABEL = 'com.homehq.copilot-push';
const PLIST = join(HOME, 'Library', 'LaunchAgents', LABEL + '.plist');
const LOG = join(HOME, 'Library', 'Logs', 'homehq-copilot-push.log');
const LIST_EVERY = 3600e3, BATCH_BYTES = 3 * 1024 * 1024;
const args = new Set(process.argv.slice(2));

const readVars = (file) => (existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]])) : {});
const hash = (s) => createHash('sha1').update(s).digest('base64url');
const log = (...a) => console.log(new Date().toISOString(), ...a);

function config() {
  const env = readVars(join(DASH, '.env.local'));
  const vars = { ...readVars(join(DASH, 'worker', '.dev.vars')), ...readVars(join(DASH, 'worker', '.dev.vars.walk-keys')) };
  const api = process.env.FRAME_API || env.VITE_FRAME_API;
  const key = process.env.COPILOT_KEY || vars.COPILOT_KEY
    || (vars.PUSH_TOKEN && createHmac('sha256', vars.PUSH_TOKEN).update('frame-data/COPILOT_KEY/v1').digest('base64url'));
  if (!api) throw new Error('VITE_FRAME_API missing from dashboard/.env.local');
  if (!key) throw new Error('PUSH_TOKEN missing from worker/.dev.vars');
  return { api: api.replace(/\/$/, ''), key };
}

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

function yamlField(raw, name) {
  const m = new RegExp('^' + name + ':\\s*(.*)$', 'm').exec(raw);
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

function localSessions() {
  const out = [];
  for (const id of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, id), file = join(dir, 'events.jsonl');
    if (!existsSync(file)) continue;
    let ws = '';
    try { ws = readFileSync(join(dir, 'workspace.yaml'), 'utf8'); } catch { /* older sessions */ }
    const { summary, transcript } = compact(parseLines(readFileSync(file, 'utf8')), {
      id, title: yamlField(ws, 'name') || yamlField(ws, 'summary'), updatedAt: statSync(file).mtime.toISOString(),
    });
    if (!summary.prompts) continue;
    summary.origin = 'mac';
    summary.taskId = yamlField(ws, 'mc_task_id') || null;
    summary.status = Date.now() - Date.parse(summary.updatedAt) < 10 * 60e3 ? 'active' : 'idle';
    out.push({ summary, transcript });
  }
  return out;
}

// The account's sessions from GitHub (Copilot CLI on other machines, cloud agent, …) that aren't on this
// Mac. GitHub doesn't expose their conversations, so these are listed without transcripts.
function cloudSessions(local, cache) {
  const known = new Set(local.flatMap((x) => [x.summary.id, x.summary.taskId]).filter(Boolean));
  const tasks = [];
  for (let page = 1; page < 50; page++) {
    const batch = gh(`/agents/tasks?per_page=100&page=${page}`).tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break;
  }
  const out = [], next = {};
  for (const t of tasks) {
    if (known.has(t.id) || t.archived_at) continue;
    let c = cache[t.id];
    if (!c || c.updated_at !== t.updated_at) {
      let full = { sessions: [] };
      try { full = gh('/agents/tasks/' + t.id); } catch { /* listed without its sessions' details */ }
      c = { updated_at: t.updated_at, sessions: (full.sessions || []).map((s) => ({ id: s.id, model: s.model, prompt: s.prompt, credits: ((s.usage && s.usage.amount) || 0) / 1e9 })) };
    }
    next[t.id] = c;
    if (c.sessions.some((s) => known.has(s.id))) continue;
    const credits = Math.round(c.sessions.reduce((a, s) => a + s.credits, 0) * 100) / 100;
    const hour = Math.floor(Date.parse(t.updated_at) / 3600e3);
    const models = {};
    for (const s of c.sessions) {
      const id = s.model || 'unknown', m = models[id] || (models[id] = { name: '', credits: 0, tokens: 0, calls: 0, hours: {} });
      m.credits = Math.round((m.credits + s.credits) * 100) / 100;
      if (m.credits) m.hours = { [hour]: m.credits };
    }
    const repo = t.repository && (t.repository.full_name || t.repository.name);
    out.push({
      id: (c.sessions[0] && c.sessions[0].id) || t.id, origin: 'cloud', transcript: false,
      title: t.name || 'Untitled session', preview: (c.sessions[0] && c.sessions[0].prompt) || '', cwd: repo || '',
      model: (c.sessions.find((s) => s.model) || {}).model || '', status: t.state || '',
      startedAt: t.created_at, updatedAt: t.updated_at, prompts: 0, replies: 0, tools: 0, errors: 0,
      credits, tokens: 0, hours: credits ? { [hour]: credits } : {}, models,
    });
  }
  return { sessions: out, cache: next };
}

async function post(cfg, body) {
  const res = await fetch(cfg.api + '/copilot/push', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`push failed ${res.status}: ${out.error || ''}`);
  return out;
}

async function run() {
  const cfg = config();
  let state = { transcripts: {}, cloud: {}, listHash: '', listAt: 0 };
  try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { /* first run */ }
  if (args.has('--force')) state.transcripts = {}, state.listAt = 0;

  const local = localSessions();
  let cloud = { sessions: [], cache: state.cloud };
  try { cloud = cloudSessions(local, state.cloud); } catch (e) { log('cloud sessions skipped:', e.message.split('\n')[0]); }
  let usage = null;
  try { usage = gh('/copilot_internal/user'); } catch (e) { log('usage skipped:', e.message.split('\n')[0]); }

  const sessions = [...local.map((x) => { const { taskId, ...s } = x.summary; return s; }), ...cloud.sessions];
  const changed = [], hashes = {};
  for (const { summary, transcript } of local) {
    const json = JSON.stringify(transcript);
    hashes[summary.id] = hash(json);
    if (state.transcripts[summary.id] !== hashes[summary.id]) changed.push([summary.id, transcript, json.length]);
  }
  const listHash = hash(JSON.stringify(sessions));
  const due = changed.length || listHash !== state.listHash || Date.now() - state.listAt > LIST_EVERY;
  log(`${local.length} local, ${cloud.sessions.length} cloud-only, ${changed.length} changed transcripts${due ? '' : ', nothing to push'}`);
  if (args.has('--dry-run') || !due) return;

  // Every batch carries the full list (the Worker replaces it) and some of the changed transcripts.
  const batches = [[]];
  let size = 0;
  for (const c of changed) {
    if (size + c[2] > BATCH_BYTES && batches[batches.length - 1].length) batches.push([]), size = 0;
    batches[batches.length - 1].push(c);
    size += c[2];
  }
  for (const b of batches) {
    const r = await post(cfg, { source: 'mac', sessions, usage, transcripts: Object.fromEntries(b.map(([id, t]) => [id, t])) });
    for (const [id] of b) if (!r.skipped.includes(id)) state.transcripts[id] = hashes[id];
    log(`pushed ${r.sessions} sessions, ${r.transcripts} transcripts${r.skipped.length ? ', skipped ' + r.skipped.join(' ') : ''}`);
  }
  for (const id of Object.keys(state.transcripts)) if (!hashes[id]) delete state.transcripts[id];
  Object.assign(state, { cloud: cloud.cache, listHash, listAt: Date.now() });
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
}

function install() {
  const ghDir = dirname(execFileSync('which', ['gh'], { encoding: 'utf8' }).trim());
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(fileURLToPath(import.meta.url))}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(ghDir)}:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict></plist>
`;
  uninstall(true);
  writeFileSync(PLIST, plist);
  execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), PLIST]);
  console.log('Installed ' + PLIST + ' (every 10 minutes, log ' + LOG + ')');
}

function uninstall(quiet) {
  try { execFileSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (quiet) return;
  rmSync(PLIST, { force: true });
  console.log('Removed the LaunchAgent ' + LABEL);
}

if (args.has('--install')) install();
else if (args.has('--uninstall')) uninstall();
else run().catch((e) => { log(e.message); process.exitCode = 1; });
