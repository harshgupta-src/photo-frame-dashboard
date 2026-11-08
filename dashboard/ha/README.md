# Home Assistant as the frame's calendar and Reminders hub

With this set up, Home Assistant holds the household's calendars and shared Reminders lists, so
automations can use them, and the frame reads them from HA over the LAN (through the kiosk's
`window.HomeHQ` bridge, see `../kiosk/README.md`). The frame-data Worker stays as the fallback
when HA can't be reached, and still hosts the dashboard and the photos.

```
iCloud calendars ──CalDAV──▶ HA calendar.*  ──▶ frame (Worker /events as fallback)
iPhone Shortcut ──POST──▶ Worker /reminders ──HA pulls every 2 min──▶ HA todo.* ──▶ frame
                     (or straight to HA's webhook)                      ▲ ticks from the frame
```

## Calendars

Add the **CalDAV** integration: URL `https://caldav.icloud.com/`, the Apple ID, and an
[app-specific password](https://support.apple.com/en-us/102654). Each iCloud calendar becomes a
`calendar.*` entity that automations can trigger on. CalDAV can add events but not edit or delete
them. Map calendars to people in the dashboard's `.env.local`, for example a personal calendar each
and a shared one:

```
VITE_HA_CALENDARS=calendar.alexs_calendar:alex,calendar.jordans_calendar:jordan,calendar.family:alex+jordan
```

## Reminders

Apple Reminders lists aren't reachable over CalDAV, so the iPhone Shortcut still sends them.

1. Add two **Local To-do** lists (Settings → Devices & services → Add integration), named after the
   Reminders lists, e.g. "Grocery list" and "LOML" → `todo.grocery_list`, `todo.loml`.
2. `reminders-sync.yaml`: set `lists_map` (Reminders list name, lower case → to-do entity) and replace
   `WEBHOOK_ID` with a long random id (`echo "frame_reminders_$(openssl rand -hex 16)"`), then add
   it to `/config/automations.yaml`.
3. `configuration.yaml`: add it to HA's `/config/configuration.yaml`, with `frame_read_key` (the
   Worker's READ_KEY) and `frame_reminders_webhook` (`http://127.0.0.1:8123/api/webhook/<id>`) in
   `secrets.yaml`. `reminders-pull.yaml` goes in `automations.yaml`. Restart HA.
4. In the dashboard's `.env.local`: `VITE_HA_GROCERY=todo.grocery_list`, `VITE_HA_PINNED=todo.loml`.

Each list is mirrored from the phone: new items are added, items done or deleted on the phone are
removed, and items ticked on the frame (or in HA) stay ticked until the phone drops them. Items may
carry `notes` and `assignee` (a person's name, shown in their colour on the frame); both go into
the to-do item's description, the assignee as an `Assigned: Name` last line.

To skip the Worker, point the Shortcut at `https://<ha external url>/api/webhook/<id>` (POST, JSON,
same body; no Authorization header) and remove `reminders-pull.yaml`. Ticks made on the frame don't
reach Apple Reminders by themselves: a Shortcut has to read the completed items from HA and
complete them in Reminders.
