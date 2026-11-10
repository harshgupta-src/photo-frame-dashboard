// One-off: copies walks exported from the old Durable Object walk log (the JSON of
// GET /walks?days=3650 from the Worker before the move to Lifelog) into Lifelog, keeping their ids so
// their calendar events (UID dog-walk-<id>@frame-data) are updated in place, not duplicated. Walks
// already in Lifelog are left alone. The Worker rewrites each one's calendar event on the next GET /walk.
// Run from dashboard/: LIFELOG_URL=… LIFELOG_TOKEN=… LIFELOG_WALK_TYPE=rex_walk DOG=Rex \
//   node worker/scripts/import-walks.mjs walks-export.json
import { readFileSync } from 'node:fs';
import { toEvent, walkersOf } from '../src/walks.js';

const { LIFELOG_URL, LIFELOG_TOKEN, LIFELOG_WALK_TYPE = 'dog_walk', DOG } = process.env;
if (!LIFELOG_URL || !LIFELOG_TOKEN || !process.argv[2]) throw new Error('usage: LIFELOG_URL=… LIFELOG_TOKEN=… node worker/scripts/import-walks.mjs <export.json>');
const exp = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const api = (method, path, body) => fetch(LIFELOG_URL.replace(/\/+$/, '') + path, {
  method, headers: { Authorization: 'Bearer ' + LIFELOG_TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});
let added = 0, skipped = 0;
for (const j of exp.walks) {
  if ((await api('GET', '/events/' + encodeURIComponent(j.id))).ok) { skipped++; continue; }
  const w = {
    id: j.id, startedAt: Date.parse(j.startedAt), endedAt: j.endedAt ? Date.parse(j.endedAt) : null, pee: j.pee, poop: j.poop,
    walkers: walkersOf((j.walkerIds || []).map((id, i) => ({ id, name: j.walkers[i] }))), notes: j.notes || null,
    dog: DOG || null, tz: exp.tz, source: j.source, cal: j.endedAt ? { state: 'pending', href: null } : { state: 'none' },
  };
  const r = await api('PUT', '/events/' + encodeURIComponent(j.id), toEvent(w, LIFELOG_WALK_TYPE));
  if (!r.ok) throw new Error(j.id + ': Lifelog HTTP ' + r.status + ' ' + (await r.text()));
  added++;
}
console.log(`Imported ${added} walk(s), ${skipped} already in Lifelog, ${exp.walks.length} in the export.`);
