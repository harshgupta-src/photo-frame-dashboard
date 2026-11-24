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
  of a planned one is tied to it. A pick follows its walk when a replan moves it (same id, else the
  next planned walk within 90 minutes). In the evening, a next walk that is tomorrow says "Tomorrow".
- After a walk is started, stopped, edited or deleted, the frame re-reads the plan every minute for
  8 minutes (and when HA's `sensor.maya_walk_plan` changes), so a replan shows up within a minute or
  so. The schedule's planned walks come from the plan itself, not the calendar copy, for the days the
  frame has a plan for.
- **Tap the tile** to start a walk. It turns teal and counts up (`0:42`, `1:05:10` after an hour);
  the ambient photo screen shows a small "Rex's out · 12 min" chip. ✕ cancels (with Undo).
- **Tap it again when you're back.** A sheet opens with the walk's length, pee, poop and who went,
  pre-filled with what the walk probably was, and a small line saying why ("Based on the 11:15 AM
  plan"). Who went: the people picked on the tile, else the planned walk's walkers (the one the walk
  is tied to, else the nearest within 90 minutes), else whoever started it. Pee/poop: the planned
  walk's [`expect`](#expected-pee-and-poop), else the last 14 days of walks around that time of day,
  else her routine. Tap to change anything (more than one person can be picked); nothing is saved
  until **Save**, so the common case is one tap. −/+ moves the start or end by
  5 minutes. ✕ or a tap outside means "not back yet" and the timer keeps going; if the sheet closes
  by itself (idle, ambient) the walk is saved as it stands.
- When nobody stopped the timer, after 2½ hours the tile says "Still out? Tap to fix" and the sheet
  proposes the usual walk length (the median of recent walks) as the end time.
- Once a walk is logged, the tile's last line reads "Walked 2h 15m ago · 💧💩"; tap it for the last
  14 days (tap a walk to edit or delete it).

### The dog tab

The rail's paw button (labelled with the dog's name) opens the dog's care dashboard (`js/dog.js`
for the data, `js/views/dog.js` for the screen). It keeps **what was planned** apart from **what
happened**:

- **Plan:** meal events in everyone's calendars ("Maya breakfast 1 cup", "Maya snack 1/2 cup",
  "Maya · Lunch" with `cups: 1` in the notes; a plain snack before 3 PM is the walk snack, later
  the night snack), the "Maya prep" event whose notes hold the kibble mix ("3 cups Purina Pro Plan +
  1/2 cup Royal Canin GI"), the [walk plan](#walk-plan), and any other "Maya …" event (training,
  vet, grooming). A meal's people come from the calendar it's on.
- **Happened:** the walks, and the Worker's `GET /dog` (below): meals logged in Lifelog (NFC tag
  taps), pee/poop, weigh-ins (`<dog>_weight`: `data.kg` or `lb`, or a range `kg_low`/`kg_high` or `lb_low`/`lb_high`, plotted at the middle; `estimate: true` marks a guess), walk distances, and the **Life Log**
  calendar, where done meals, walks and pee/poop end up. A planned meal moved to Life Log is still
  that meal (matched by day + meal), so it counts as fed, not missing; pee/poop are merged by walk
  id or within 3 minutes.

The screen is built to be read from across the room (portrait: tiles 2 × 2, meals beside the map,
the week across the bottom). Four big tiles: time since the last pee and poop against the usual
daytime gap (amber past it, red at 1½×), the next meal and the next walk (and whether the people on
it are busy then). Below them: today's meals as a checklist (who fed each and how late, or due /
late) with the kibble mix, today's walks, the **last walk's route** on an OpenStreetMap map (the
Worker's `/tile` proxy) with distance, time and who walked, and one bar chart of minutes walked per
day for the last 7 days with each day's pee and poop counts, beside a **weight** card: the latest
weigh-in, kg a week since one at least 5 days earlier, and every weigh-in on a line (estimates
hollow, ranges as a bar). The header has age and the next other "Maya …" event. Tap a walk or the map to edit that walk. Without the Worker it shows
demo data. Set `VITE_DOG_BIRTHDAY` (YYYY-MM-DD) for the age.

**Food bumps.** A banner under the header says when the daily food should go up by ¼ cup ("Bump
Maya's food · Today, 3½ → 3¾ cups a day", with a **Done** button), or the day a bump is coming; on a hold, a quiet line shows today's cups and the likely next bump. It
hides once the planned meals on that day already add up to the new amount. Home Assistant decides
(`ha/maya-food.yaml`): every morning it asks the Worker for the facts (age, the adult weight
projected from recent weigh-ins on a large-breed growth curve, growth pace, the food label's cups
for that weight and age, appetite from logged meals, and the plan's changes) and the HA Copilot
Agent reads her vault notes and decides. The Worker refuses a bump (422) unless she's healthy, it's
exactly +¼ cup from today's amount, stays within the label's range, and **one change at a time**:
no mixed food (a transition) that day and no other change (food mix, meal count, amount, an
earlier bump) within 7 days either side. 30 min before breakfast on the day, both phones get a
notification with a Done action. Set the Worker secret `DOG_BIRTHDAY` (YYYY-MM-DD).

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
| `DELETE /walks/:id` | delete a walk and its calendar event; saving that id again gets `410 Gone` for 30 days unless the body has `restore: true` (Undo) |
| `POST /walks/start` | start now `{by?: "<person id>"}` (409 if one is active) |
| `POST /walks/stop` | stop now `{pee?, poop?, by?}`; pee/poop left out default to the walk's [expected](#expected-pee-and-poop) ones (404 if none is active). A stop within a minute of the start discards the walk (`discarded: true`) |
| `POST /walks/resync` | retry calendar writes |
| `GET /walks/active` | just the walk in progress, or `active: null` (Home Assistant polls it) |
| `PUT /walks/:id/route` | `{points: [{who, lat, lon, acc, t}]}` the route (404 if the walk is gone) |
| `POST /walks/:id/route` | `{points?}` add late points to the stored route and [snap](#snapped-routes) it again |
| `POST /walks/routes/snap?days=14` | snap the routes of the last `days` days again (`dry=1`: only report; 503 without the walk graph) |
| `GET /walks/plan?date=` | the day's plan (default today) with each walk's status and `expect` |
| `PUT /walks/plan/:date` | replace it `{walks: [{start: "HH:MM", durationMin?\|end?, walkers: ["<id>"], expect?: {pee, poop}, note?, id?}], notes?, source?, lateUntil?: "HH:MM"}` |
| `DELETE /walks/plan/:date` | drop it and its calendar events |
| `GET /meals?date=` | the day's planned meal events (one per kind): `{kind, start, end, usual, calendar, people, cups, title, uid}` |
| `PUT /meals/plan/:date` | move or reassign meals `{meals: [{kind, start: "HH:MM", people: ["<id>"], note?}], reason?}` → `{changed, unchanged, skipped}` |
| `POST /meals/log` | a meal was given `{id, person, at, planned_at?, delta_min?, cups?, purina_pct?, fortiflora?, ate?, source?}`: writes it to the Life Log calendar and removes the planned event (re-POST merges, e.g. `{id, ate: "some"}`) |
| `DELETE /meals/log/:id` | undo: delete the Life Log entry and restore the planned event |
| `GET /dog?days=30` | the dog tab's data: Lifelog `<dog>_meal`, `_pee`, `_poop`, `_walk_route` (since `days`), all `_weight`, and `log`, the Life Log calendar's events (`LOG_CALENDAR`, default `WALK_CALENDAR`; `none` to skip; a calendar error only sets `logError`), and `lastRoute` {walkId, start, end, m, path: [[lat, lon]], snapped}, the newest walk's raw path (≤ 300 points) and its [snapped](#snapped-routes) line (≤ 600 points, or null; `m` is then the snapped distance, as in `routes`), and `food` (below) |
| `GET /dog/food` | the food advice `{advice, history}` |
| `POST /dog/food/facts` | `{plan: [{date, meals, cups, mixed}]}` → the facts the decision uses |
| `PUT /dog/food` | store advice `{decision: "bump"\|"hold", date?, fromCups?, toCups?, meal?, healthy, reason, projection?, nextCheck?}` (422 with `error` when the rules refuse it) |
| `POST /dog/food/done` | mark the bump done `{by?}` |
| `GET /tile?z=&x=&y=` | an OpenStreetMap tile for the route map, cached a week (needs READ_KEY, also as `?key=`) |

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

A walk stopped less than a minute after it started is treated as a mis-tap and isn't logged, on the frame ("I'm back" shows an Undo toast instead of the sheet) and on `/walks/stop`.

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
than 4 m/s. When the Worker has the walk graph it adds the [snapped](#snapped-routes) route:
`snapped: {"<who>": [[lat, lon], ...]}`, `snapped_distances`, `snapped_m` and `snap: {v, graph}`.

### Snapped routes

The phones report a fix every few minutes at best, so straight lines between them cut through
buildings. The Worker matches each walker's fixes to the footpaths and streets (`worker/src/snap.js`)
and stores that line next to the raw fixes. The dog tab draws it when it's there, else the raw fixes,
and shows its distance. It all runs on the Worker: **no walk coordinates go to any outside service.**

- **Matching:** a hidden Markov model. Fixes worse than 60 m, jumps nobody could walk (over 3 m/s
  beyond both fixes' accuracy) and fixes within 8 m of the last one are dropped. A dense track is
  thinned to 400 fixes. Each fix's candidates are the nearest points on paths within max(2 ×
  accuracy, 25 m). Viterbi weighs the distance to the path against how much the route between two
  candidates (bounded A*) differs from the straight line. Consecutive matches are joined by the
  shortest path, so long gaps follow the footpaths too, and out-and-back spurs under 30 m are dropped.
  A walk mostly off the graph (e.g. away from home) isn't snapped. It takes a few ms per walk, and the
  graph about 5 MB of memory.
- **The graph:** walkable OpenStreetMap ways in a square around home: footways, paths, steps,
  pedestrian streets, residential and service roads (not parking aisles or driveways), tertiary to
  primary roads unless they have no sidewalk, and trunk roads only with one. No motorways, and
  nothing tagged `foot=no` or private. It's a small binary file (about 550 KB for 6 km) that stays
  out of git because it says where home is. The Worker gets it as the `WALK_GRAPH` binding
  (`worker/vm/server.mjs`). Without it, routes simply aren't snapped (the Cloudflare fallback has none).
- **Rebuilding it** (new paths in OSM, a move, a bigger area), on the Mac from `dashboard/`:
  ```
  brew install osmium-tool
  node worker/scripts/walk-graph.mjs --center <home lat>,<home lon> --km 6
  npm run deploy
  ```
  The script downloads Geofabrik's Massachusetts extract into `worker/data/` (gitignored, refreshed
  after 30 days; `--pbf` uses another one) and writes `worker/data/walk-graph.bin`. Only the
  extract is downloaded; no location is sent. A deploy from the Mac ships the file, and the VM keeps
  it in `/var/lib/frame-data/walk-graph.bin`, so CI deploys keep using it. Then snap the recent
  routes again: `POST /walks/routes/snap?days=14` (add `dry=1` to only compare).
- **Late points:** `POST /walks/:id/route` with `{points}` adds them to the stored fixes and snaps the
  route again (without a body it just re-snaps). Other point sources join the phones' in
  `WalkStore.mergeSources` before snapping.

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
by `+`; keys match in any order or case), else the `CALENDARS` entry with exactly those people. The frame shows them in its schedule
too. When a walk is logged it is matched to the plan (its `planId`, else the nearest planned walk
within 90 minutes, but never one whose plan was written after the walk ended; around midnight the
previous and next day's plans are checked together so a walk counts for one planned walk only) and that planned event is deleted; a
planned walk whose time has passed shows as `missed`. A new PUT moves changed events (a walk that keeps its `id` keeps its event; a new walk whose generated id clashes with a kept one gets `-2`), deletes dropped
ones and keeps the rest. A walk already done stays in the plan even if the PUT leaves it out. Plans are kept for 90 days in the Worker's KV; `GET /walk` includes today's and tomorrow's.

Home Assistant writes the plan at 04:30 and replans the rest of the day 2 minutes after each walk of
the day is logged, edited or deleted (`ha/walk-plan.yaml`). It also reassesses when the calendars change:
`sensor.maya_calendar_watch` reads Harsh's, Ambuja's and the shared calendar (now to the end of tomorrow,
without the 🐕 walk events and Maya's meals) every 5 minutes, and 30 s after HA writes a calendar, so it catches events
added, moved or deleted anywhere (Apple Calendar, HA, agents). For each day with an upcoming change it
replans: the rest of today (from 04:30), or tomorrow if it already has a plan. The agent sees the
change and the current plan, and moves only what needs to move. It asks the HA Copilot Agent to pick times,
lengths and walkers from the dog's pee/poop rhythm (the last 14 days of walks with the gaps between
pees and between poops, and the time since the last ones), both people's calendars, the forecast and
the dog's vault note, and to say what each walk will likely bring (`expect`). A replan keeps the walks already done or under way and replaces the rest; the agent is given each upcoming
walk's id and returns it for walks it keeps or moves. A walk-triggered replan is skipped if the day has
rolled over or it's before 04:30 by the time it runs. The
agent's one-line reading of the rhythm is the plan's `notes`. 15 minutes before each planned walk that
hasn't started, HA sends its walkers a time-sensitive "get ready" notification (`sensor.maya_walk_plan`
caches today's plan; refreshed every 10 min, after a walk and after each plan).

### Bedtime

Nobody is up after 22:00 on a normal day, so her last walk is around 21:00. The Worker drops planned
walks that start after 22:00 (they come back under `dropped` in the answer) unless the PUT's
`lateUntil` allows them, or they were already walked. Home Assistant sets `lateUntil` to 30 minutes after
the latest event on Harsh's, Ambuja's or the A&H Life calendar that starts that day and ends after 22:00
(timed events only; Maya's own 🐕 walk and meal events don't count, so they can't keep anyone up, but her
training or vet visits do), at most
23:59, filters the agent's walks the same way and tells the agent.

### Expected pee and poop

Each planned walk in `GET /walk` and `GET /walks/plan` has `expect: {pee, poop, from, n?}`, the end-of-walk
sheet's defaults (`worker/src/walkexpect.js`, shared by the Worker and the frame):

1. `plan`: the agent's `expect` for that walk (it says what she'll most likely do when it plans).
2. `history`: walks of the last 14 days that started within ±90 minutes of that time of day (at least
   3); yes when 60% or more of them had it.
3. `usual`: her routine: always a pee; a poop on the first morning walk (05:00–08:30), the late-morning
   walk (10:00–12:30) and the walk after dinner (19:00–23:30).

It's worked out from the walks the Worker already reads for the plan, so it costs no extra Lifelog call,
and the frame keeps it with the plan, so opening the sheet fetches nothing. A walk not tied to a plan
uses 2 and 3 on the frame's own 14 days of walks.

### Meals

The same plan run also reassesses the dog's meals that aren't fed yet and are at least 10 minutes
away. The agent keeps each meal at its usual time and moves it only when nobody who could feed it is
free then: to the nearest free time (ideally within 30 minutes, never more than 90 from the usual
time), keeping about 3 hours between main meals. It reassigns the meal to whoever is free, and keeps
the current feeder when they are. HA sends the agent's `meals` to `PUT /meals/plan/<date>`. The Worker
moves the event, and puts it in the new feeder's calendar (`WALK_PLAN_CALENDARS`). It records the
usual time (`X-MAYA-USUAL`) and adds a "⏰ Moved from the usual 12:30: reason" line, which is dropped
when the meal goes back to its usual time. The Worker enforces the 90-minute limit: a start more than
90 minutes from the usual time on that date (in the plan's time zone) is skipped (`skipped`: "more than
90 min from the usual 18:30") and the event stays put, except that a meal already further away (e.g.
moved by hand) can always be brought back toward or to its usual time. A moved occurrence of a recurring meal series is split
off: the series gets an `EXDATE` and the occurrence becomes a standalone event. The calendar watcher
ignores Maya's 🐕 walks and meals ("Maya … breakfast/lunch/dinner/snack") so the planner's own moves don't
trigger replans; her other events (training, vet) and sitter stays do. Edits people make to
meal events are picked up by the next 04:30 plan.

When a meal is logged (NFC tag or notification, `maya_meal.yaml`), HA POSTs `/meals/log`. The Worker
writes **Maya lunch 🍽️ 1 cup — Ambuja** to the Life Log calendar, with who fed her, when, how late,
the food, whether she ate it all and the calendar it was planned on. It then removes the planned
event (or adds an `EXDATE` to the series). Undo (`DELETE /meals/log/<id>`) puts the planned event
back. The meal sensor reads the Life Log too, so a second tap is still caught as a double feed. A meal
move, log or undo clears the frame's cached `GET /events` (KV key `events`), so the frame shows the
new time on its next refresh instead of up to 5 minutes later.

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

## OwnTracks

The Home Assistant app reports only sparse, coarse fixes in the background. For an accurate route, both
iPhones also run the free [OwnTracks](https://owntracks.org) app in HTTP mode, posting straight to the
Worker's `POST /owntracks` (`worker/src/owntracks.js`). Nothing goes to a third party.

**Setup (once per phone).** Open the person's setup page in Safari on their iPhone:
`https://frame-data.<account>.workers.dev/owntracks/setup/harsh?key=<READ_KEY>` (or `/setup/ambuja`).
1. Install OwnTracks from the App Store (27.1.2 or later; earlier versions can't switch modes
   remotely). Allow location **Always** with Precise Location, and Motion & Fitness.
2. In OwnTracks Settings, turn on configuration by URL/file (it asks you to confirm).
3. Tap **Install in OwnTracks** on the page and accept the changes.

The link is `owntracks:///config?inline=<base64 JSON, URL-encoded>`. It sets HTTP mode with this Worker's
URL and the person's username and password, device `iphone`, significant-changes monitoring,
`locatorDisplacement`/`locatorInterval` 10, remote commands and remote configuration on (`cmd`,
`remoteConfiguration`), no beacon ranging, downgrade or adapt, and a 120 m **Home** region at Home
Assistant's `zone.home`. The page holds that person's password, so it needs READ_KEY and isn't cached.

Worker secrets (in `/etc/frame-data/secrets.env` on the VM and `worker/.dev.vars`; see
`worker/vm/README.md`): `OWNTRACKS_USERS` = `{"harsh": {"password": "…", "walker": "harsh"}, "ambuja": {…}}`
(`walker` is the person id used in walks), `OWNTRACKS_HOME` = `"lat,lon"` (4 decimals), and optionally
`OWNTRACKS_URL`, the public URL of `POST /owntracks` (by default the `workers.dev` host the proxy
forwards for).

**Mode switching.** OwnTracks over HTTP can't be pushed to, so the Worker answers each post with a
`setConfiguration` command when needed:
- **move** (2: continuous GPS, a post every 10 m or 10 s) while a walk with that person is out;
- **significant changes** (1: low power, a post every few hundred metres) otherwise.

The command is sent only when the wanted mode differs from the one last sent to that phone (KV
`ot:mode:<user>:<device>`), or when a location post's `m` shows the phone is in the other mode. Otherwise
the answer is `[]`. Leaving the Home region makes the phone post at once, so a walk started on the frame
before leaving switches it to move mode within ~120 m. A walk started after leaving waits for the next
significant-change post. Once the walk is stopped, the next post (at most 10 s later) switches it back.
Walk writes through the Worker clear its cached walk list (`ot:walks`, otherwise 2 minutes), so changes
apply right away.

**Privacy.** A fix is stored only if its person is on a walk at the fix's time (from 1 minute before the
start to 1 minute after the end; queued fixes the phone sends late count by their own time). Stored under
`ot:pts:<walk id>:<walker>` (at most 2000 fixes, accuracy ≤ 100 m), they expire after 3 days. All other
fixes and messages (transitions, waypoints, status) are dropped, so there is no all-day location history.

**Into the route.** `owntracksPoints(env, walkId)` returns `{walker: [[lat, lon, acc, unix s], ...]}`.
`mergePaths(haPaths, otPaths)` combines them with Home Assistant's points per walker. With 5 or more
OwnTracks fixes it keeps those plus the HA points outside their time span; with fewer it uses the union.
Either way the result is sorted by time, one fix per second. `withOwntracks(env, walkId, body)` applies
this to a `PUT /walks/:id/route` body. The Worker keeps HA's own route body (`ot:ha:<walk id>`, 3 days).
When fixes arrive for a walk that has already ended, it waits 20 s for the rest of the queue, then saves
the route again: HA's points (or the stored route's, if HA's body wasn't kept) merged with the OwnTracks
fixes, via `putRoute`.
