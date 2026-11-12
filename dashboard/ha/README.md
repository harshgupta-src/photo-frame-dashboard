# Home Assistant as the frame's calendar and Reminders hub

With this set up, Home Assistant holds the household's calendars and shared Reminders lists, so
automations can use them, and the frame reads them from HA over the LAN (through the kiosk's
`window.HomeHQ` bridge, see `../kiosk/README.md`). The frame-data Worker stays as the fallback
when HA can't be reached, and still hosts the dashboard and the photos.

```
iCloud calendars ──CalDAV──▶ HA calendar.*  ──▶ frame (Worker /events as fallback)
iPhone Shortcut ──POST──▶ HA webhook ──▶ HA todo.* ──▶ frame (Worker /reminders as fallback)
   (or POST Worker /reminders, which stores it and forwards it)   ▲ ticks from the frame
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
(or the same wrapped in `{"lists": {...}}`; items are newline text, strings or
`{title, notes, assignee, done}`).

1. Add two **Local To-do** lists (Settings → Devices & services → Add integration), named after the
   Reminders lists, e.g. "Grocery list" and "LOML" → `todo.grocery_list`, `todo.loml`.
2. `reminders-sync.yaml`: set `lists_map` (Reminders list name, lower case → to-do entity) and replace
   `WEBHOOK_ID` with a long random id (`echo "frame_reminders_$(openssl rand -hex 16)"`), then add
   it to `/config/automations.yaml` and reload automations. Anyone with the id can rewrite the
   lists, so keep it private.
3. Point the Shortcut's **Get Contents of URL** at `https://<ha external url>/api/webhook/<id>`:
   method POST, request body JSON with the lists as above (Content-Type `application/json`), no
   Authorization header. HA updates the lists within seconds.
4. In the dashboard's `.env.local`: `VITE_HA_GROCERY=todo.grocery_list`, `VITE_HA_PINNED=todo.loml`.

Each list is mirrored from the phone: new items are added, items done or deleted on the phone are
removed, and items ticked on the frame (or in HA) stay ticked until the phone drops them. Items may
carry `notes` and `assignee` (a person's name, shown in their colour on the frame); both go into
the to-do item's description, the assignee as an `Assigned: Name` last line. Lists missing from a
push are left alone. Ticks made on the frame don't reach Apple Reminders by themselves: a Shortcut
has to read the completed items from HA and complete them in Reminders.

**Through the Worker instead.** A Shortcut can also POST the same body to the Worker's
`/reminders` (header `Authorization: Bearer <PUSH_TOKEN>`). The Worker keeps the last push in KV,
which the frame reads when it can't reach HA, and forwards it to HA's webhook straight away when
the Worker secret `HA_REMINDERS_WEBHOOK_URL` is set (the webhook URL above; add
`HA_REMINDERS_WEBHOOK_URL=...` to `.env.local` and `npm run deploy` uploads it, or
`npx wrangler secret put HA_REMINDERS_WEBHOOK_URL`). The response says `"ha": "ok"`, `"failed"`
or `"off"`. With the Shortcut posting to HA directly, the Worker's copy stops updating, so the
frame's fallback shows the last list sent through the Worker.

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
- **walk-plan:** at 04:30 and after each logged walk, the HA Copilot Agent plans the day's (remaining)
  walks from the dog's pee/poop rhythm and both calendars; the Worker puts them in the walkers' calendars.

Secrets: `frame_walk_auth: "Bearer <WALK_KEY>"` and `frame_walk_webhook_id` (random). The Worker's
`HA_WALK_WEBHOOK_URL` is `https://<ha external url>/api/webhook/<that id>`.

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
   ```

   An ACL file denies every user it doesn't list. If the MQTT integration logs in with its own
   login (set up by hand rather than from the discovered app), add that user with
   `topic readwrite #` too. Restart the app after changing either file.
3. Save the broker and login on the frame (`../kiosk/README.md`). The device appears within a few
   seconds.

Ideas: turn the screen off at night or when nobody is home, and on when the room's lux rises
above a threshold (someone turned the lights on) or when the frame is touched.

To undo: on the frame, `--es mqtt_url ''` and `--ez screen_admin false`; delete the Photo Frame
device in the MQTT integration; remove the login (and `customize`) from the Mosquitto app, or
uninstall the app and delete the MQTT integration.
