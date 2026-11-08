# Dog walk timer

The **Today** screen's walk tile (the dog's name comes from `VITE_DOG_NAME`) doubles as a walk timer.
Walks are kept by the frame-data Worker, mirrored to the shared family calendar so they show up on
everyone's phone, copied into the Obsidian vault by Home Assistant, and readable by agents.

```
frame tile ──PUT/DELETE──▶ Worker /walks ──▶ WalkLog Durable Object (SQLite)
iPhone Shortcut ──POST /walks/start|stop──┘        │
                                                   ├─CalDAV PUT/DELETE──▶ iCloud "family" calendar ──▶ iPhones
                                                   ├─GET /walks/log.md ◀── Home Assistant (5 min) ──▶ vault note
                                                   └─GET /walks/summary, /mcp ◀── agents (AGENT_KEY, read-only)
```

## On the frame

- **Tap the tile** to start a walk. It turns teal and counts up (`0:42`, `1:05:10` after an hour);
  the ambient photo screen shows a small "Rex's out · 12 min" chip. ✕ cancels (with Undo).
- **Tap it again when you're back.** A sheet opens with the walk's length, pee ✓ (default on),
  poop (default off) and who went (default: the first person in `VITE_PEOPLE`; tap to add or swap,
  more than one can be picked). The common case is one tap: **Save**. −/+ moves the start or end by
  5 minutes. ✕ or a tap outside means "not back yet" and the timer keeps going; if the sheet closes
  by itself (idle, ambient) the walk is saved as it stands.
- When nobody stopped the timer, after 2½ hours the tile says "Still out? Tap to fix" and the sheet
  proposes the usual walk length (the median of recent walks) as the end time.
- Once a walk is logged, the tile's last line reads "Walked 2h 15m ago · 💧💩"; tap it for the last
  14 days (tap a walk to edit or delete it).

Everything is saved in the browser first and queued, so a reload, a reboot or a Wi-Fi drop loses
nothing; a small dot after the label means changes are waiting to be sent. The frame refreshes from
the Worker every minute while a walk is out (every 5 otherwise), so a walk started or stopped from
a phone shows up. Only one walk can be active: if one was started elsewhere, the frame adopts it.
Walk times use the real clock, and a walk can't be started while the frame's clock still reads 1970
after a reboot.

## Calendar

Each completed walk becomes an event, e.g. **Rex walk — Alex · 💧💩** from 7:02 to 7:31, with the
details in the notes. Edits update it and deletes remove it (CalDAV with the Worker's iCloud
credentials; event UID `dog-walk-<walk id>@frame-data`). The events are "free" (they don't block
time) and the Worker retries with backoff when iCloud is down; `GET /walk` shows the sync state
under `calendar`, and `POST /walks/resync` retries writes that gave up.

The calendar is the `WALK_CALENDAR` Worker variable, or by default the `CALENDARS` entry shared by
the most people (the family calendar). `WALK_CALENDAR=none` turns the mirror off.

The frame leaves walk events out of its own schedule (`js/live.js`): the tile already shows them,
and five events a day would crowd both people's lanes. Phones show them as normal events. Home
Assistant's CalDAV calendar entity for that calendar sees them too, so calendar automations should
ignore titles starting with the dog's name + " walk". iPhones may notify about changes to a shared
calendar; that is Settings → Calendar → Shared Calendar Changes.

## API

All on the frame-data Worker. Times are ISO 8601 (or epoch ms when sent); `localDate` and `tz` give
the home time zone (sent by the frame).

| | |
|---|---|
| `GET /walk` | active walk + last 14 days (what the frame uses) |
| `GET /walks?days=30` | walks, newest first |
| `GET /walks/summary` | active walk, last walk, last pee/poop and minutes since, today, last 7 days |
| `GET /walks/log.md` | the markdown log (the vault note) |
| `PUT /walks/:id` | create or replace `{startedAt, endedAt?, pee?, poop?, walkers?: ["<person id>"], notes?}` |
| `DELETE /walks/:id` | delete a walk and its calendar event |
| `POST /walks/start` | start now `{by?: "<person id>"}` (409 if one is active) |
| `POST /walks/stop` | stop now `{pee?: true, poop?: false, by?}` (404 if none is active) |
| `POST /walks/resync` | retry calendar writes |
| `POST /mcp` | MCP server (Streamable HTTP, stateless): `walk_summary`, `list_walks {days}`, `walk_log` |

Keys go in `Authorization: Bearer <key>` (or `X-Frame-Key`, `X-Walk-Key`, `X-Agent-Key`):

- **READ_KEY** (the frame's key) and **WALK_KEY**: read and write.
- **AGENT_KEY**: read only. GET requests also accept `?key=AGENT_KEY`; writes never take a key in the URL.

WALK_KEY and AGENT_KEY are Worker secrets if set (`wrangler secret put AGENT_KEY`), otherwise
derived from PUSH_TOKEN, so they work without setup and change when PUSH_TOKEN does. To see them:
`node worker/scripts/walk-keys.mjs` (from `dashboard/`) writes them to the gitignored
`worker/.dev.vars.walk-keys`; add `--print` to show them.

Walks are validated: no times before 2026 or in the future, at most 6 hours, end after start. When
the sender's clock is more than 2 minutes off (`clientNow` in the body), its times are corrected.

### iPhone Shortcut (optional)

Two Shortcuts with **Get Contents of URL**, method POST, header `Authorization: Bearer <WALK_KEY>`,
JSON body: `…/walks/start` with `by` = a person id from `VITE_PEOPLE`, and `…/walks/stop` with `pee`/`poop` from a menu.
The frame picks the walk up within a minute.

## For agents

- **Vault note** `Areas/Household/<Dog> Walk Log.md`: regenerated from `GET /walks/log.md` by Home
  Assistant every 5 minutes when something changed (`ha/walk-log.sh`, `ha/walk-log.yaml`; frontmatter
  `generated: true`, so don't edit it by hand). It has a "Now" section (last walk, last pee and
  poop), the last 30 days by day, and monthly totals. Any agent with the vault MCP can read it.
- **Live**, read-only with AGENT_KEY:
  - `GET https://frame-data.<your-subdomain>.workers.dev/walks/summary` with `Authorization: Bearer <AGENT_KEY>`
  - or as an MCP connector: URL `https://frame-data.<your-subdomain>.workers.dev/mcp`, header
    `Authorization: Bearer <AGENT_KEY>`; tools `walk_summary`, `list_walks`, `walk_log`.

## Development

`npx wrangler dev --config worker/wrangler.jsonc --var WALK_CALENDAR:none` runs the Worker with a
local Durable Object (use the calendar's name instead of `none` to test the mirror against iCloud).
Tests: `node --test worker/test/*.test.js`.
