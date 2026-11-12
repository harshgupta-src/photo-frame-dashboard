# Dog walk timer

The **Today** screen's walk tile (the dog's name comes from `VITE_DOG_NAME`) doubles as a walk timer.
Walks are kept in [Lifelog](#lifelog), a small event store with a REST API and an MCP server (for
example a Home Assistant app), one event per walk. The frame-data Worker is a stateless adapter in
front of it: the frame and the iPhone Shortcuts talk to the Worker's `/walk` and `/walks` API, the
Worker reads and writes the walks in Lifelog, mirrors them to a calendar so they show up on
everyone's phone, keeps the day's [walk plan](#walk-plan), tells [Home Assistant](#home-assistant)
when a walk starts or ends (it switches the empty house off and records the route), and renders the markdown log that Home Assistant copies into the
Obsidian vault. Agents read and log walks in Lifelog directly.

```
frame tile ──PUT/DELETE──▶ Worker /walk, /walks ──REST──▶ Lifelog (one event per walk) ◀── agents (MCP)
iPhone Shortcut ──POST /walks/start|stop──┘   │
                                              ├─CalDAV PUT/DELETE──▶ iCloud calendars (walks, plans) ──▶ iPhones
                                              ├─webhook ──▶ Home Assistant ──GET /walks/active, PUT /walks/:id/route
                                              ├─PUT /walks/plan/:date ◀── Home Assistant planner (HA Copilot Agent)
                                              └─GET /walks/log.md ◀── Home Assistant (5 min) ──▶ vault note
```

## On the frame

- When there's a [plan](#walk-plan), the tile shows the next planned walk ("Next 4:00 PM · 40m",
  "Due now") with the planned walkers' avatars; tap an avatar to add or drop someone. Those are the
  walkers the walk starts with (and the stop sheet's default), and a walk started within 90 minutes
  of a planned one is tied to it.
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

Everything is saved in the browser first and queued, so a reload, a reboot, a Wi-Fi drop or Lifelog
being unreachable (the Worker answers 502) loses nothing; a small dot after the label means changes are waiting to be sent. The frame refreshes from
the Worker every minute while a walk is out (every 5 otherwise), so a walk started or stopped from
a phone shows up. Only one walk can be active: if one was started elsewhere, the frame adopts it.
Walk times use the real clock, and a walk can't be started while the frame's clock still reads 1970
after a reboot.

## Calendar

Each completed walk becomes an event, e.g. **Rex walk — Alex · 💧💩** from 7:02 to 7:31, with the
details in the notes, plus a 1-minute **pee** event (1 minute after the start) and **poop** event
(2 minutes after the pee) when they were ticked (UIDs `dog-walk-<id>-pee`/`-poop`; both are capped
at the walk's end). Edits update it and deletes remove it (CalDAV with the Worker's iCloud
credentials; event UID `dog-walk-<walk id>@frame-data`). The events are "free" (they don't block
time). The Worker writes the event right after each change and keeps the sync state in the walk's
Lifelog event (`data.calendar`: state, the event's address, a hash of what it shows, errors). Every
`GET /walk` (the frame asks every 1-5 minutes) re-checks the last 14 days and syncs any walk whose
event is missing or out of date, so walks that agents log or edit in Lifelog reach the calendar too,
and failed writes are retried with backoff (up to an hour, 10 tries). `GET /walk` shows the sync
state under `calendar`, and `POST /walks/resync` retries writes that gave up.

The calendar is the `WALK_CALENDAR` Worker variable, or by default the `CALENDARS` entry shared by
the most people (the family calendar). `WALK_CALENDAR=none` turns the mirror off. When it changes,
each walk's events move to the new calendar on its next sync (the walk's old `calendar.href` is
deleted); bumping `CAL_VERSION` in `walks.js` re-syncs every walk of the last 14 days.

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
| `GET /walks/active` | just the walk in progress, or `active: null` (Home Assistant polls it) |
| `PUT /walks/:id/route` | `{points: [{who, lat, lon, acc, t}]}` the route (404 if the walk is gone) |
| `GET /walks/plan?date=` | the day's plan (default today) with each walk's status |
| `PUT /walks/plan/:date` | replace it `{walks: [{start: "HH:MM", durationMin?\|end?, walkers: ["<id>"], note?, id?}], notes?, source?}` |
| `DELETE /walks/plan/:date` | drop it and its calendar events |

`PUT /walks/:id` and `POST /walks/start` also take `planId` (a plan item's id).

Keys go in a header, `Authorization: Bearer <key>` (or `X-Frame-Key`, `X-Walk-Key`): **READ_KEY**
(the frame's key) or **WALK_KEY**, both read and write. WALK_KEY is a Worker secret if set,
otherwise derived from PUSH_TOKEN, so it works without setup and changes when PUSH_TOKEN does. To
see it: `node worker/scripts/walk-keys.mjs` (from `dashboard/`) writes it to the gitignored
`worker/.dev.vars.walk-keys`; add `--print` to show it.

Walks are validated: no times before 2026 or in the future, at most 6 hours, end after start. When
the sender's clock is more than 2 minutes off (`clientNow` in the body), its times are corrected.

### iPhone Shortcut (optional)

Two Shortcuts with **Get Contents of URL**, method POST, header `Authorization: Bearer <WALK_KEY>`,
JSON body: `…/walks/start` with `by` = a person id from `VITE_PEOPLE`, and `…/walks/stop` with `pee`/`poop` from a menu.
The frame picks the walk up within a minute.

## Lifelog

The Worker needs two secrets: `LIFELOG_URL`, Lifelog's base URL as the Worker can reach it (e.g.
`https://<your host>/lifelog` behind a reverse proxy), and `LIFELOG_TOKEN`, a read/write Lifelog
token used only by the Worker. `LIFELOG_WALK_TYPE` is the event type (default `dog_walk`, e.g.
`rex_walk`). Put them in `.env.local` without the `VITE_` prefix and `npm run deploy` uploads them
(or `npx wrangler secret put LIFELOG_TOKEN`). The Worker uses Lifelog's `GET /events?type=…`,
`GET|PUT|PATCH|DELETE /events/:id`.

Each walk is one event with the walk's id: `started_at`, `ended_at` (null while out), `person` (the
walker when there is one), `source` (`frame`, `shortcut`, …) and `data`:

```json
{"dog": "Rex", "pee": true, "poop": false, "walkers": ["Alex"], "walker_ids": ["alex"],
 "notes": null, "tz": "America/New_York", "max_open_s": 21600, "calendar": {"state": "synced", "href": "…", "rev": "…"}}
```

A ticked pee or poop is also its own instant event, `<walk id>-pee` / `<walk id>-poop`, type
`<dog>_pee` / `<dog>_poop` when the walk type ends in `_walk` (e.g. `rex_pee`; else `<type>_pee`), at
1 minute after the start and 2 minutes after that, with `data` `{walk_id, dog, walkers, walker_ids}`.
The Worker writes them with the walk and soft-deletes them when unticked; edit the walk, not them.

The route is `<walk id>-route`, type `<dog>_walk_route` (start to end of the walk), with `data`
`{walk_id, dog, walkers, walker_ids, paths: {"<who>": [[lat, lon, accuracy m, unix s], ...]},
distances: {"<who>": m}, distance_m, points}`. Distances skip fixes worse than 50 m and jumps faster
than 4 m/s.

A deleted walk is soft-deleted in Lifelog. To log a missed
walk, an agent logs one event of that type with `data.pee`/`data.poop`/`data.walkers` (names); the
frame and the calendar pick it up within a few minutes.

`worker/scripts/import-walks.mjs` copied the walks from the Worker's old Durable Object log
(`WalkLog`) into Lifelog, keeping their ids so their calendar events were updated in place. The
Durable Object and its stored data were then deleted (wrangler migration `v2`).

## Walk plan

`PUT /walks/plan/<date>` sets a day's planned walks (at most 8; 5–180 minutes; times local). Each
becomes an event **🐕 Rex walk — Alex** (UID `walk-plan-<id>`) in the walkers' calendar:
`WALK_PLAN_CALENDARS` (`{"alex": "Alex's Calendar", "alex+jordan": "Family"}`, ids sorted and joined
by `+`), else the `CALENDARS` entry with exactly those people. The frame shows them in its schedule
too. When a walk is logged it is matched to the plan (its `planId`, else the nearest planned walk
within 90 minutes, but never one planned after the walk ended) and that planned event is deleted; a
planned walk whose time has passed shows as `missed`. A new PUT moves changed events, deletes dropped
ones and keeps the rest. Plans are kept for 90 days in the Worker's KV; `GET /walk` includes today's and tomorrow's.

Home Assistant writes the plan at 04:30 and replans the rest of the day 2 minutes after each walk of
the day is logged, edited or deleted (`ha/walk-plan.yaml`). It asks the HA Copilot Agent to pick times,
lengths and walkers from the dog's pee/poop rhythm (the last 14 days of walks with the gaps between
pees and between poops, and the time since the last ones), both people's calendars, the forecast and
the dog's vault note. A replan keeps the walks already done or under way and replaces the rest; the
agent's one-line reading of the rhythm is the plan's `notes`.

## Home Assistant

`ha/walk-house.yaml`. The Worker POSTs `{event: start|stop|logged|change|delete, walk}` to
`HA_WALK_WEBHOOK_URL` on every change; HA then (and every minute) reads `GET /walks/active`:

- **Start:** it records the walkers' phone locations (and asks the phones for updates every minute;
  iOS may throttle them). One minute after the start, if no one but the walkers is home, it snapshots
  the lights, fans and TVs that are on and turns them off.
- **End:** it turns those back on (the snapshot keeps brightness and colour) and PUTs the route to
  `/walks/<id>/route`.

## For agents

- **Lifelog** (MCP or REST): the source of truth, e.g. `select * from v_events where type = 'rex_walk'`.
- **Vault note** `Areas/Household/<Dog> Walk Log.md`: regenerated from `GET /walks/log.md` by Home
  Assistant every 5 minutes when something changed (`ha/walk-log.sh`, `ha/walk-log.yaml`; frontmatter
  `generated: true`, so don't edit it by hand). It has a "Now" section (last walk, last pee and
  poop), the last 30 days by day, and monthly totals.

## Development

`npx wrangler dev --config worker/wrangler.jsonc --var WALK_CALENDAR:none --var LIFELOG_WALK_TYPE:test_walk`
runs the Worker against the Lifelog in `worker/.dev.vars` (`LIFELOG_URL`, `LIFELOG_TOKEN`) with a
separate event type (use the calendar's name instead of `none` to test the mirror against iCloud).
Tests: `node --test worker/test/*.test.js`.
