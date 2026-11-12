// Self-update detection, kept free of DOM/browser APIs so node --test can run it (test/update.test.js).
// Both sides of the comparison go through the same function: the running page's own <script>/<link>
// tags (serialized at boot, before anything is added at runtime) and the freshly fetched index.html.
// UPDATE-FREEZE.md explains why.

// <!-- comments --> | <script|style ...>raw text</script|style> | <link ...>. Attribute values may
// hold '>' inside quotes. Script/style bodies are skipped so markup-looking text in them never counts.
var ATTRS = '((?:[^>"\']|"[^"]*"|\'[^\']*\')*)';
var TAG_RE = new RegExp('<!--[\\s\\S]*?-->|<(script|style)\\b' + ATTRS + '>[\\s\\S]*?<\\/\\1\\s*>|<(link)\\b' + ATTRS + '>', 'gi');
var ATTR_RE = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
var ASSET_RE = /^(?:https?:\/\/[^\/]+)?(\/assets\/[^?#\s]+\.(?:js|css))(?:[?#].*)?$/i;

function attr(attrs, name) {
  ATTR_RE.lastIndex = 0;
  var m;
  while ((m = ATTR_RE.exec(attrs))) {
    if (m[1].toLowerCase() === name) {
      var v = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      return v == null ? '' : v.replace(/&amp;/g, '&');
    }
  }
  return null;
}

// Sorted, de-duplicated /assets/*.js|css paths referenced by script src / link href in the markup.
export function assetsInHtml(html) {
  var seen = {};
  var out = [];
  var m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(String(html || '')))) {
    var tag = (m[1] || m[3] || '').toLowerCase();
    var v = tag === 'script' ? attr(m[2], 'src') : tag === 'link' ? attr(m[4], 'href') : null;
    var a = v && ASSET_RE.exec(v.trim());
    if (a && !seen[a[1]]) { seen[a[1]] = true; out.push(a[1]); }
  }
  return out.sort();
}

export function assetKey(html) { return assetsInHtml(html).join(' '); }

export var APPLY_KEY = 'update-applied-v1';
export var RETRY_MS = 6 * 3600e3;

// Decides what one check means. state = { candidate, seen } (in memory; a reload starts over).
// `need` is how many consecutive checks must see the new build: 2 for a timed poll, 1 when a deploy
// pushed the news (the push itself is the first sighting).
//   'none'     same build (or nothing usable fetched): nothing to do
//   'seen'     a different build, seen fewer than `need` times: wait for the next check to confirm it
//   'apply'    seen in `need` consecutive checks and not tried in the last RETRY_MS: reload when idle
//   'blocked'  already tried for this build within RETRY_MS (the reload didn't take): don't loop
export function decide(state, mine, live, storage, now, need) {
  if (!mine || !live || mine === live) { state.candidate = null; state.seen = 0; return 'none'; }
  if (state.candidate !== live) { state.candidate = live; state.seen = 0; }
  state.seen++;
  if (state.seen < (need || 2)) return 'seen';
  var last = readApplied(storage);
  if (last && last.key === live && now - last.at >= 0 && now - last.at < RETRY_MS) return 'blocked';
  return 'apply';
}

export function readApplied(storage) {
  try { return JSON.parse(storage.getItem(APPLY_KEY) || 'null'); } catch (e) { return null; }
}

// Call right before reloading for build `key`. Returns false if this build was already tried within
// RETRY_MS, so a caller that skipped decide() still can't loop.
export function markApplied(storage, key, now) {
  var last = readApplied(storage);
  if (last && last.key === key && now - last.at >= 0 && now - last.at < RETRY_MS) return false;
  try { storage.setItem(APPLY_KEY, JSON.stringify({ key: key, at: now })); } catch (e) { return false; }
  return true;
}
