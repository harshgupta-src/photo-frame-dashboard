// Saves the Apple ID + app-specific password to .dev.vars (gitignored) and lists the calendars
// that account can see. The password is typed here, never shown or logged.
// Run from dashboard/worker: node scripts/icloud-setup.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { listCalendars } from '../src/icloud.js';

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(q)) rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
const FILE = new URL('../.dev.vars', import.meta.url);
const vars = {};
if (existsSync(FILE)) for (const l of readFileSync(FILE, 'utf8').split('\n')) { const m = l.match(/^(\w+)=(.*)$/); if (m) vars[m[1]] = m[2]; }

vars.ICLOUD_APPLE_ID = (await ask('Apple ID email' + (vars.ICLOUD_APPLE_ID ? ' [' + vars.ICLOUD_APPLE_ID + ']' : '') + ': ')) || vars.ICLOUD_APPLE_ID;
const pw = await ask('App-specific password (xxxx-xxxx-xxxx-xxxx, hidden; Enter keeps the saved one): ', true);
if (pw) vars.ICLOUD_APP_PASSWORD = pw.replace(/\s+/g, '');
vars.READ_KEY ||= randomBytes(24).toString('base64url');
vars.PUSH_TOKEN ||= randomBytes(24).toString('base64url');
writeFileSync(FILE, Object.entries(vars).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 });
console.log('Saved to dashboard/worker/.dev.vars\n\nChecking iCloud…');
try {
  const cals = await listCalendars(vars);
  console.log('Calendars this Apple ID can see:');
  for (const c of cals) console.log('  - ' + c.name + (c.shared ? '  (shared)' : ''));
} catch (e) {
  console.error('iCloud check failed: ' + e.message);
  process.exitCode = 1;
}
