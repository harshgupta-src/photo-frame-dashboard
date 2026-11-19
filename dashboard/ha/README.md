# Home Assistant as the frame's calendar and Reminders hub

With this set up, Home Assistant holds the household's calendars and shared Reminders lists, so
automations can use them, and the frame reads them from HA over the LAN (through the kiosk's
`window.HomeHQ` bridge, see `../kiosk/README.md`; from kiosk 1.4 device states arrive live over
HA's WebSocket API, "Live state" there). The frame-data Worker stays as the fallback
when HA can't be reached, and still hosts the dashboard and the photos. Phones running the
dashboard (`../IPHONE.md`) reach HA over its public URL instead, each signed in as its owner.

```
iCloud calendars ──CalDAV──▶ HA calendar.*  ──▶ frame (Worker /events as fallback)
iPhone Shortcut ──POST──▶ Worker /reminders ──▶ HA webhook ──▶ HA todo.* ◀──▶ frame (edits via script.frame_todo)
               ◀──GET /reminders/ops── frame's edits, to make in Reminders
```

## Calendars

Add the **CalDAV** integration: URL `https://caldav.icloud.com/`, the Apple ID, and an
[app-specific password](https://support.apple.com/en-us/102654). Each iCloud calendar becomes a
`calendar.*` entity that automations can trigger on. CalDAV can add events but not edit or delete
them.

The frame keeps reading calendars from the Worker: HA's CalDAV asks iCloud live on every request
(about 10 seconds per calendar over the frame's 52-day window), which is too slow for a 5-minute
refresh through the kiosk bridge. To read them from HA anyway, map calendars to people in the
dashboard's `.env.local`, for example a personal calendar each and a shared one:

```
VITE_HA_CALENDARS=calendar.alexs_calendar:alex,calendar.jordans_calendar:jordan,calendar.family:alex+jordan
```

## Reminders

Apple Reminders lists aren't reachable over CalDAV, so an iPhone Shortcut sends them, as JSON:
`{"Grocery list": "milk\neggs", "LOML": [{"title": "...", "notes": "...", "assignee": "Name"}]}`
(or the same wrapped in `{"lists": {...}}`, optionally with `"ack": N`; items are newline text,
strings or `{title, notes, assignee, done}`). The frame and the phones edit the same lists in HA
(add, rename, notes, tick, untick, delete, clear ticked), and the Shortcut copies those edits back
into Reminders.

```
iPhone Shortcut ──POST /reminders {lists, ack}──▶ Worker ──webhook──▶ automation frame_reminders_sync ──▶ todo.*
frame / phones ──script.frame_todo──▶ todo.* + sensor.frame_reminders_ledger ──rest_command──▶ Worker /reminders/ops
iPhone Shortcut ──GET /reminders/ops──▶ makes those changes in Reminders, then pushes with "ack"
```

### Install (`reminders-sync.yaml`, a package)

1. Add two **Local To-do** lists (Settings → Devices & services → Add integration), named after the
   Reminders lists, e.g. "Grocery list" and "LOML" → `todo.grocery_list`, `todo.loml`.
2. Make sure `configuration.yaml` has `homeassistant: packages: !include_dir_named packages`, then
   copy `reminders-sync.yaml` to `/config/packages/reminders_sync.yaml`. Edit `lists_map` (Reminders
   list name, lower case → to-do entity, in the script (reversed) and the sync automation) and
   the Worker URL in `rest_command.frame_reminders_ops`.
3. `/config/secrets.yaml`:
   - `frame_reminders_webhook_id: "frame_reminders_<random>"` (`openssl rand -hex 16`). Anyone with
     the id can rewrite the lists, so keep it private.
   - `frame_walk_auth: "Bearer <WALK_KEY>"` (already there for the walk packages; the Worker accepts
     it on `POST /reminders/ops`).
4. Remove any older "Reminders sync from iPhone" automation from `automations.yaml`, run
   `ha core check`, then restart HA (new script, sensor and rest_command need a restart the first
   time; later edits only need YAML reloads).
5. Worker secret `HA_REMINDERS_WEBHOOK_URL` = `https://<ha external url>/api/webhook/<id>` (add it to
   `.env.local`, `npm run deploy` uploads it).
6. In the dashboard's `.env.local`: `VITE_HA_GROCERY=todo.grocery_list`, `VITE_HA_PINNED=todo.loml`.

What you get:

- **`script.frame_todo`** — fields `op` (`add`, `rename`, `edit`, `complete`, `reopen`, `delete`,
  `clear_completed`), `entity_id`, `uid` (all but add and clear_completed), `title` (add),
  `rename`, `description` (notes, with an `Assigned: Name` last line for the assignee). It makes the
  change and notes it in the ledger. The frame calls it as `POST /api/services/script/frame_todo`
  (allowed by the kiosk bridge; the "Photo Frame" HA user isn't an admin and doesn't need to be).
  Adding a title that's already open is a no-op, as is changing an item that's gone.
- **`sensor.frame_reminders_ledger`** — state: the last op number; attributes `seq` and `ops`
  (`{seq, op, list, title, old_title, notes, assignee, at}`): the changes the phone hasn't made yet.
  Restored across restarts, compacted (add then delete cancels out, untick cancels tick, …), capped
  at 300 ops, and ops expire after 14 days.
- **Automation `frame_reminders_sync`** ("Reminders sync from iPhone") — mirrors each pushed list by
  title (case-insensitive), except where a pending op says otherwise: titles added or renamed-to on
  the frame aren't removed, titles deleted or renamed-from aren't re-added, ticked items stay ticked
  (and aren't re-added after "clear ticked"), and notes edited on the frame aren't reverted. A push
  with `"ack": N` drops ops up to N first; after that the phone wins again (e.g. an item ticked on
  the frame that the phone still lists open is reopened: it was re-added there). Lists missing from
  a push are left alone. Items done on the phone simply drop out of the push and are removed.
  A pushed item without notes or without an assignee keeps the ones HA has; only a value in the
  push replaces them (see "Assignees" below).
- **Automation `frame_reminders_ops_publish`** ("Reminders ops to the Worker") — sends the ledger
  to the Worker's `/reminders/ops` on every change, so the Shortcut can read it with the token it
  already has. Until the Worker has that route, HA logs a warning per change and nothing else breaks.

### Assignees

Apple Shortcuts can't read or set Reminders' own "assigned to" on a shared list, so HA and the frame
keep the assignee themselves, as an `Assigned: Name` last line of the item's description (notes
above it). On the frame, an item on the pinned list (LOML) is assigned in its edit sheet, or when it's
added, with the **Assigned to** choice (None or one of `VITE_PEOPLE`); the tile and the list show
the person's initial or name in their colour. The grocery list has no assignee choice.

- An assignment made on the frame is an `edit` op (`{seq, op: "edit", list, title, old_title,
  notes, assignee}`: `notes` without the line, `assignee` the name, `""` once unassigned). The
  Worker's `/reminders/ops` adds `apple_notes`, the two joined (`notes` + `Assigned: Name`), for
  the Shortcut's **Set Notes**, so the assignee shows in the reminder's notes on the phones too.
- Pushes keep it: the Shortcut pushes bare titles, and a pushed item with no notes or no assignee
  leaves HA's as they are. Only a value in the push replaces them: `"assignee": "Name"`, or notes
  whose last line is `Assigned: Name`. A side effect: notes or an assignee removed on the phone
  aren't removed in HA by a push (remove them on the frame).

Without the Shortcut changes below, the frame's edits still stick in HA (the ledger keeps them from
being undone for 14 days), but they don't reach Apple Reminders.

### The iPhone Shortcut (once, on the iPhone that pushes)

The Shortcut already gets the "Grocery list" and "LOML" reminders and posts them to the Worker's
`/reminders` with `Authorization: Bearer <PUSH_TOKEN>`. Add these steps **before** it gathers the
reminders, so the push that follows already reflects the frame's edits:

1. **Get Contents of URL** `https://frame-data.<subdomain>.workers.dev/reminders/ops`, method GET,
   header `Authorization` = `Bearer <PUSH_TOKEN>` (same as the push). Name the result `Ops`.
   It looks like `{"ack": 17, "count": 2, "ops": [{"seq": 16, "op": "add", "list": "Grocery list",
   "title": "Oat milk", "old_title": "", "notes": "", "assignee": ""}, …]}`, oldest first.
2. **Get Dictionary Value** `ack` from `Ops` → set variable `Ack`.
3. **Get Dictionary Value** `ops` from `Ops` → **Repeat with Each** item. Inside, read `op`, `list`,
   `title`, `old_title` and `notes` from **Repeat Item**, then **If** `op` is:
   - `add` → **Add New Reminder** `title` to the list named `list` (notes = `apple_notes` if any).
   - `rename` → **Find Reminders** where List is `list`, Title is `old_title`, Is Not Completed,
     limit 1 → **Set** Title of the reminder to `title`.
   - `edit` → **Find Reminders** (List `list`, Title `title`, limit 1) → **Set** Notes to
     `apple_notes` (`notes` plus an `Assigned: Name` line when the item is assigned; see "Assignees").
   - `complete` → **Find Reminders** (List `list`, Title `title`, Is Not Completed, limit 1) →
     **Set** Is Completed to on.
   - `reopen` → **Find Reminders** (List `list`, Title `title`, Is Completed, limit 1) → **Set** Is
     Completed to off. If none is found (it was cleared), **Add New Reminder** `title` instead.
   - `delete` → **Find Reminders** (List `list`, Title `title`, limit 1) → **Remove Reminders**
     (turn off "Confirm Before Deleting").

   An op whose reminder isn't found (already changed on the phone) is simply skipped.
4. Gather and push the lists as before, but make the body `{"lists": {…the lists as now…},
   "ack": Ack}` (a Dictionary with keys `lists` and `ack`, Number). The Worker forwards `ack` to HA,
   which forgets those ops.

Run it as an automation (e.g. hourly and when leaving/arriving home) as now. If the Shortcut stops
part-way, it doesn't send `ack`, and the same ops come back next time; each step is safe to repeat
(a second `add` of the same title is the only thing to watch, so check **Find Reminders** first if
you want to be strict).

**Through the Worker, or straight to HA.** The Shortcut can also POST the push straight to HA's
webhook (`https://<ha external url>/api/webhook/<id>`, no Authorization header). Through the Worker
(`POST /reminders`, `Authorization: Bearer <PUSH_TOKEN>`), the Worker also keeps the last push in
KV, which the frame reads when it can't reach HA, and forwards it (with `ack`) to the webhook; the
response says `"ha": "ok"`, `"failed"` or `"off"` (no `HA_REMINDERS_WEBHOOK_URL`).

## Dog walk log in the Obsidian vault

`walk-log.sh` copies the Worker's walk log (`GET /walks/log.md`, rendered from the walks in
Lifelog, see `../WALKS.md`) into a vault note, for agents that read the vault. Copy it to
`/config/frame-walk-log.sh`, put the Worker's WALK_KEY (`node worker/scripts/walk-keys.mjs`) in
`/config/.frame_agent_key` with `chmod 600`, and add the two parts of `walk-log.yaml` to
`configuration.yaml` and `automations.yaml`. Restart HA. The note is rewritten only when a walk changes.

## Dog walks: the empty house, the route and the daily plan

`walk-house.yaml` and `walk-plan.yaml` are packages (copy to `/config/packages/` as `walk_house.yaml`
and `walk_plan.yaml`, with your Worker subdomain and entity ids; see `../WALKS.md`):

- **walk-house:** when a walk starts on the frame, HA tracks the walkers' phones; after a minute, if
  nobody else is home, it turns off the lights, fans and TVs that are on (a scene snapshot) and turns
  them back on when the walk ends, then sends the route to the Worker.
- **walk-plan:** at 04:30, after each logged walk and when a calendar event is added, moved or removed, the HA Copilot Agent plans the day's (remaining)
  walks from the dog's pee/poop rhythm and both calendars; the Worker puts them in the walkers' calendars. Walkers get a heads-up 15 min before each. The same run keeps the
  meals at their usual times unless there's a conflict, then moves them (at most 90 min) and
  assigns them to whoever is free. Logged meals move from the planning calendars to Life Log
  (`maya_meal.yaml` calls the Worker's `/meals/log`; see `../WALKS.md`). Run
  `script.maya_walk_plan` as an admin, since the agent call needs one.

Secrets: `frame_walk_auth: "Bearer <WALK_KEY>"` and `frame_walk_webhook_id` (random). The Worker's
`HA_WALK_WEBHOOK_URL` is `https://<ha external url>/api/webhook/<that id>`.

## Dog food bumps

`maya-food.yaml` (copy to `/config/packages/maya_food.yaml` with your Worker subdomain; it uses
`frame_walk_auth` and the meal package's `script.maya_meal_notify`): at 04:40 it reads the meal
plan from the calendars, the Worker's facts and the dog's vault notes, asks the HA Copilot Agent
whether to raise the daily food by ¼ cup (one change at a time; see `../WALKS.md`) and stores the
answer on the Worker. On the bump day both phones are notified 30 min before breakfast, with a Done
action. Run `script.maya_food_check` as an admin (the agent call needs one) to check now.

## The frame as a device (MQTT)

The kiosk can register the frame as a Home Assistant device over MQTT discovery: screen on/off,
screen brightness, ambient light, "moved", "touched" and a reload button. The entities and the
frame's side are in `../kiosk/README.md` ("Home Assistant device (MQTT)").

MQTT was chosen over the frame pushing states through the REST API: `POST /api/states` needs an
admin token and makes no device, and commands back to the frame would need it to open a port.
With MQTT the frame only connects out, gets commands on that connection, and the broker marks it
unavailable when it drops (a retained last will).

1. Install the **Mosquitto broker** app (Settings → Apps). In its configuration add a login for the
   frame, with a long random password kept in a private file on your computer:

   ```sh
   umask 077; openssl rand -hex 24 > ~/.config/homehq/mqtt-pass
   ```

   ```yaml
   logins:
     - username: photo-frame
       password: <the password>
   ```

   Start it, then add the **MQTT** integration (Home Assistant offers it as discovered).
2. Optional: limit the frame's login to its own topics. Turn on the app's `customize` option
   (folder `mosquitto`) and create `/share/mosquitto/acl.conf`:

   ```
   acl_file /share/mosquitto/accesscontrollist
   ```

   and `/share/mosquitto/accesscontrollist` (`chmod 0700`), with the frame's id from
   `adb shell settings get secure android_id`:

   ```
   user homeassistant
   topic readwrite #

   user addons
   topic readwrite #

   user photo-frame
   topic readwrite homehq/homehq_<android_id>/#
   topic write homeassistant/device/homehq_<android_id>/config
   topic read homeassistant/status
   topic read homehq/dashboard/update
   ```

   An ACL file denies every user it doesn't list. If the MQTT integration logs in with its own
   login (set up by hand rather than from the discovered app), add that user with
   `topic readwrite #` too. Restart the app after changing either file.
3. Save the broker and login on the frame (`../kiosk/README.md`). The device appears within a few
   seconds.

Ideas: turn the screen off at night or when nobody is home, and on when the room's lux rises
above a threshold (someone turned the lights on) or when the frame is touched.

## Dashboard deploys (push to the frames)

`npm run deploy` can tell the frames a new dashboard is live, so they don't wait for their next
poll: it POSTs the build to an HA webhook, `dashboard-update.yaml` publishes it (retained) on
`homehq/dashboard/update`, and every kiosk on MQTT hands it to the page, which applies it once the
frame is idle, behind an "Updating…" screen.

1. Add `frame_deploy_webhook_id: "<long random id>"` to `secrets.yaml`
   (`echo "frame_deploy_$(openssl rand -hex 16)"`), copy `dashboard-update.yaml` to
   `/config/packages/dashboard_update.yaml` and restart HA.
2. In the dashboard's `.env.local`: `HA_DEPLOY_WEBHOOK_URL=https://<ha external url>/api/webhook/<id>`
   (or the LAN URL if you only deploy from home). It stays on your computer; it isn't uploaded as a
   Worker secret. If HA can't be reached, the deploy still succeeds and the frames find the build on
   their next poll (hourly while MQTT is up, else every 5 minutes).
3. With the ACL above, the frame's login needs `topic read homehq/dashboard/update`.

Needs kiosk 1.3 or later on the frame (one USB install).

To undo: on the frame, `--es mqtt_url ''` and `--ez screen_admin false`; delete the Photo Frame
device in the MQTT integration; remove the login (and `customize`) from the Mosquitto app, or
uninstall the app and delete the MQTT integration.
