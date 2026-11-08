#!/bin/sh
# Home Assistant shell_command (walk-log.yaml): copies the dog walk log from the frame-data Worker
# (GET /walks/log.md, read-only AGENT_KEY) into the Obsidian vault mirror, so agents that read the
# vault see it. Writes only when the note changed, by renaming a hidden .tmp file over it, so the
# vault's sync never sees a half-written note (LiveSync bridges skip .*.tmp files).
# Usage: frame-walk-log.sh <Worker URL> <note path> [key file, default /config/.frame_agent_key]
#   e.g. frame-walk-log.sh https://frame-data.<sub>.workers.dev "/share/obsidian/<vault>/Areas/Household/Rex Walk Log.md"
set -eu
URL="${1:?Worker URL}/walks/log.md"
NOTE="${2:?note path}"
KEY_FILE="${3:-/config/.frame_agent_key}"
TMP="$(dirname "$NOTE")/.walk-log.tmp"

[ -d "$(dirname "$NOTE")" ] || { echo "no folder for $NOTE" >&2; exit 1; }
KEY="$(cat "$KEY_FILE")"
trap 'rm -f "$TMP"' EXIT
curl -fsS --max-time 20 -H "Authorization: Bearer $KEY" -o "$TMP" "$URL"
head -c 4 "$TMP" | grep -q -- '---' || { echo "unexpected response" >&2; exit 1; }
cmp -s "$TMP" "$NOTE" || mv -f "$TMP" "$NOTE"
