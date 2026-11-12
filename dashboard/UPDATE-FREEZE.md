# Frame freezes with a stale clock around self-update

**Symptom.** On the AEEZO 10.1" frame (Allwinner A33, Android 6, WebView 106, kiosk loading
`https://home-dashboard.wesbos.workers.dev/`), a few times a day at most, the screen ignores touch
and the clock in the rail is a few minutes behind. Suspected: the dashboard's self-update.

## What the page did before this fix (`js/app.js`)

- `setInterval(checkUpdate, 5 min)`: fetch `/` (`cache: 'no-store'`), regex every
  `/assets/….js|css` out of the raw HTML, compare (sorted join) with the `src`/`href` of the live
  page's `script[src*="/assets/"], link[href*="/assets/"]` nodes. One mismatch set
  `updatePending = true`.
- `onIdleTick()` (every tick): `updatePending && idle >= 30 s && no takeover` → `location.reload()`.
  Nothing persisted, nothing confirmed, sheets and an active dog walk didn't block it.
- `tick()` on `setInterval(1000)`: re-rendered the clock when `getMinutes()` changed, and **reloaded
  the page** whenever two ticks were more than 10 minutes apart.
- `index.html` inline script: reload if `window.App` doesn't exist 10 s after the end of parsing,
  on every load, with no back-off.

## Findings, per hypothesis

1. **False-positive update loop — refuted for the current build, but the check was fragile.**
   `dist/index.html` has exactly one `<script type="module" src="/assets/index-….js">` and one
   `<link rel="stylesheet" href="/assets/index-….css">`. Extracted both ways from the built file
   (regex vs the script/link attributes) both give the same two paths, so the same deployment
   compared equal. No code adds `/assets/` nodes at runtime (no `createElement('link'|'script')`,
   no dynamic `import()`, so Vite adds no preload links; the two `/assets/` strings in the bundle
   are the selector itself). The Worker returns 401 (not `ok`) without the cookie, so that path
   is a no-op too. The comparison was still unlike-with-like: the regex counted any `/assets/…`
   text (comments, inline script, duplicates such as a `modulepreload` + `script` pair, unquoted
   attributes) while the DOM side counted tags only — `test/update.test.js` shows such a page made
   the old check report an update on every check, forever. A captive portal or error page that
   returns 200 HTML mentioning `/assets/` also triggered a reload.
2. **True-positive cost — confirmed as the trigger.** Every real `npm run deploy` that changes the
   dashboard (it is under active development) makes every frame reload. On the A33 that reload is
   long: index.html (`no-store` with `?key=`) plus a revalidation of a 132 kB JS / 64 kB CSS bundle
   (42 kB / 13 kB gzipped) that is new and uncached after a deploy, the render-blocking Google Fonts
   stylesheet (third-party, before the app CSS), then on the 4×Cortex-A7: V8 compile/run of the whole
   bundle, `App.go('home')`, weather/calendar/reminders/photos fetches each triggering a re-render,
   and `refreshStale` pre-building six hidden views 400 ms apart. Until the new document paints,
   Chromium-based WebView typically keeps the old page's last frame on screen (paint holding), and
   that frame no longer reacts to touch — matching "unresponsive, clock frozen at the minute the
   reload started". On a slow or flaky Wi-Fi moment the
   blocking stylesheet/bundle requests stretch that to minutes. (No browser on this machine, so this
   is an estimate from the code and bundle sizes, not an on-device measurement.)
3. **Reload-loop risk — confirmed (two independent loops).**
   - Update check: nothing remembered that a version had been applied. If a reload landed on the
     old assets again (deploy still propagating, a cached response), the next check mismatched
     again and the frame reloaded again ~5.5 min later, indefinitely.
   - Self-heal script: "no `window.App` 10 s after parsing → reload" on every load, no back-off.
     After a deploy the bundle is uncached; on the A33 over slow Wi-Fi, download + compile can take
     longer than 10 s, so the page reloads itself just before it would have started, repeatedly —
     each round is another frozen, stale frame.
   - Kiosk side (`MainActivity.java`): WebView uses the default cache mode (`LOAD_DEFAULT`), no
     AppCache, no service worker. The Worker serves index.html with `Cache-Control: no-store`
     (`?key=` URL) or Workers Assets' default `max-age=0, must-revalidate`, and assets are
     content-hashed, so WebView cannot pair a stale index.html with new assets or vice versa. No
     watchdog/reload logic in the kiosk or `NavigationService`; reloads only come from the
     two-finger menu and the Home Assistant MQTT "Reload dashboard" button (`HaDevice.java`) — worth
     checking no HA automation presses it. The bundled `127.0.0.1:8765` copy is used only if that URL
     is saved; `checkUpdate` skips it. **No APK change is needed.**
4. **Clock fragility — confirmed.** A gap of more than 10 minutes between ticks (e.g. screen
   locked with device admin, CPU asleep) reloaded the page — another long freeze — although only
   the 1970→NTP jump at boot needs it. The minute check used `getMinutes()`, so a stall of exactly
   N hours left the old time on screen for another minute; `setInterval` drift was uncorrected.

## Changes

- `js/update.js` (new, DOM-free): `assetsInHtml(html)` reads `src` of `<script>` and `href` of
  `<link>` tags only (comments and script/style bodies skipped; any quoting, case; `?query`
  stripped), keeps `/assets/*.js|css`, de-duplicated and sorted. `decide()` needs the same new key
  in **two consecutive checks**; `markApplied()` persists `{key, at}` in localStorage
  (`update-applied-v1`) right before reloading and refuses the same key again for **6 hours**.
- `js/app.js`:
  - Both sides go through `assetKey()`: the page's own `script[src], link[href]` nodes, serialized
    once at boot (so later DOM additions can't count), and the fetched index.html. A redirected or
    non-`text/html` answer counts as "nothing fetched".
  - Applied only at ≥ 30 s idle with no takeover, no open sheet, no demo drawer, and no dog walk in
    progress (`App.walk.active`, `js/walk.js`).
  - Clock: `setTimeout` chain aligned to the next whole second; minute compared as an absolute
    minute; a gap over 90 s re-renders (`'time'` event + current view) instead of reloading; the
    only remaining reload is the one-time jump from an unset clock (< 2026) to a set one; on
    `visibilitychange` back to visible the tick runs at once.
- `index.html`: the self-heal reload backs off 10 s → 20 s → 40 s … 5 min across reloads
  (sessionStorage), reset once `App.start` runs.
- `test/update.test.js` + `npm test` (runs the Worker tests and these).

## Why it stays fixed

A same-build check is provably "no update" (identical parser on both sides, tested on
`dist/index.html`). A real deploy reloads each frame once, never during a walk or with a sheet
open; a reload that doesn't take can't repeat for 6 h; a slow boot is no longer interrupted by the
self-heal; and a stalled or sleeping page shows the right time on its first tick.

## For the owner

- Deploy as usual: `npm run deploy` from `dashboard/` (owner-run). The first reload after it still
  costs one boot on the A33 — keep deploys to when nobody's using the frame.
- No APK rebuild needed.
- Optional follow-ups (not done here): self-host or make the Google Fonts stylesheet non-blocking so
  a slow fonts.googleapis.com can't hold the first paint; a reload during the sleep window boots in
  day mode and lights the screen for ~60 s before going back to night (pre-existing, `onIdleTick`).

## Follow-up: pushed deploys, an "Updating…" screen, fewer redraws

The reload itself is the slow part on the A33, and the old page's last frame (usually a slideshow
photo, since updates wait for 30 s of idle) stayed on screen ignoring touches until the new page
painted. With deploys several times a day, that was a frozen photo several times a day.

- **Push.** `npm run deploy` POSTs the build's asset key to an HA webhook (`HA_DEPLOY_WEBHOOK_URL`,
  `ha/dashboard-update.yaml`), which publishes it retained on `homehq/dashboard/update`. The kiosk
  (1.3+, `HaDevice.UPDATE_TOPIC`) calls `window.frameUpdate(build)`; the page ignores its own build,
  otherwise checks `/` once (`decide(..., need = 1)`) and retries at 20 s, 1 min and 3 min while the
  deploy propagates. Polling stays as the fallback: hourly while `HomeHQ.updatePush()` reports the
  MQTT link up, every 5 min otherwise, still needing two polls in a row.
- **"Updating…" screen.** `applyUpdate()` puts a plain full-screen "Updating…" layer up and reloads
  after it paints (1 s fallback when rAF is paused), so the frame held during the reload explains
  itself. Skipped in night mode, where the screen stays black.
- **Data redraws.** Calendar (every 5 min) and weather (every 15 min) refreshes emitted `'data'` and
  re-rendered the current view even when nothing changed, and `'data'` re-builds every hidden view
  400 ms apart — a few seconds of main-thread work on the A33 every 5 minutes. Both now compare with
  what's shown first; the Home card's HA status (every 15 s) only touches the DOM when it changed.
