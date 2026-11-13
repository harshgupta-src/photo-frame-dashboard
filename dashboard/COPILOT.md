# Copilot on the Agents tab

The **Agents** tab shows GitHub Copilot activity on the account: the plan quota, today's and this
month's credits, a 7-day chart, and every session. Tap a session to read the whole chat. Sessions are
tagged **Development** (the Mac's Copilot CLI and GitHub cloud sessions) or **Automation** (the Home
Assistant Copilot Agent add-on), and the list filters by tag.

The Worker can't read Copilot history itself, so the machines that run Copilot push it:

```
Mac: ~/.copilot/session-state/*/events.jsonl ─┐  copilot-push.mjs (LaunchAgent, every 10 min)
     gh api /agents/tasks, /copilot_internal/user┤
HA add-on: /data/agent/copilot/session-state ─┴─POST /copilot/push──▶ Worker (KV) ◀──GET /copilot── frame
                (after each job, and every 30 min)                                   GET /copilot/session?id=
```

## What gets sent

`worker/src/copilotlog.js` (and its Python port, `ha_copilot_agent/sessions.py` in the add-on, which
must stay in step) compacts each `events.jsonl` into:

- a **summary**: id, title, preview, cwd, model, status, start/update times, counts of prompts,
  replies, tool calls and errors, credits (`totalNanoAiu / 1e9`), tokens and credits per hour;
- a **transcript**: your messages, Copilot's replies, tool calls (name, short argument, short
  result) and errors. Long text is clipped.

Cloud-only sessions (from `gh api /agents/tasks`, no local events) have a summary but no transcript.
The plan quota comes from `gh api /copilot_internal/user`. Its "used" figure is GitHub's and doesn't
always match the summed session credits, so the tab shows both.

## Worker API

| Route | Auth | |
| --- | --- | --- |
| `POST /copilot/push` | `Authorization: Bearer COPILOT_KEY` | `{source: "mac"\|"ha", sessions, transcripts?: {id: transcript}, usage?}` |
| `GET /copilot` | frame `READ_KEY` | `{usage, sources: {mac, ha}, sessions}`, newest first |
| `GET /copilot/session?id=` | frame `READ_KEY` | one transcript `{v, id, items}` |

A push replaces that source's whole session list, stores the transcripts it includes (kept 400 days)
and keeps the usage snapshot only if it's newer. KV keys: `copilot:src:<source>`,
`copilot:t:<id>`, `copilot:usage`.

`COPILOT_KEY` is a Worker secret if set, otherwise derived from `PUSH_TOKEN` like `WALK_KEY`;
`node worker/scripts/walk-keys.mjs` writes it to `worker/.dev.vars.walk-keys`.

## Mac pusher

```sh
node worker/scripts/copilot-push.mjs --dry-run   # show what would be sent
node worker/scripts/copilot-push.mjs             # push changes now (--force: everything)
node worker/scripts/copilot-push.mjs --install   # LaunchAgent com.homehq.copilot-push, every 10 min
node worker/scripts/copilot-push.mjs --uninstall
```

It needs `gh` logged in and `worker/.dev.vars` (`PUSH_TOKEN`). It only sends transcripts that changed
since the last run (state: `~/.config/homehq/copilot-push-state.json`; log:
`~/Library/Logs/homehq-copilot-push.log`).

## Home Assistant add-on

Set the HA Copilot Agent add-on options `frame_push_url` (the Worker's https URL) and
`frame_push_key` (`COPILOT_KEY`). The add-on pushes its sessions a few seconds after each job starts
or finishes, and every 30 minutes; the log shows "Pushed N sessions…".
