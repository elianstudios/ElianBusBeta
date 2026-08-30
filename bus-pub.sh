#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  bus-pub.sh — publish ONE envelope to the ElianBus hub from anything that can
#  run a shell command (grokbot, cron jobs, other scripts). It just POSTs to the
#  hub's /pub endpoint; the hub logs it to bus.jsonl and forwards it to your
#  phone if the topic is enabled on the web page.
#
#  Usage:
#     bus-pub.sh <from> <topic> <msg> [title]
#
#  Examples:
#     bus-pub.sh grokbot grok/reply  "done: summarized the inbox"      "Grok"
#     bus-pub.sh grokbot grok/status "job failed: rate limited"        "Grok"
#     echo "long body" | bus-pub.sh grokbot grok/reply -               "Grok"
#
#  Notes:
#   - <msg> of "-" reads the message body from stdin (handy for long output).
#   - grok/reply and grok/status forward to the phone out of the box (see the
#     hub's default forward map); grok/prompt is the INBOUND topic grokbot
#     listens on and is intentionally NOT forwarded.
#   - Override the hub location with ELIANBUS_URL (default http://127.0.0.1:9900).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HUB="${ELIANBUS_URL:-http://127.0.0.1:9900}"

if [ "$#" -lt 3 ]; then
  echo "usage: bus-pub.sh <from> <topic> <msg|-> [title]" >&2
  exit 2
fi

FROM="$1"
TOPIC="$2"
MSG="$3"
TITLE="${4:-}"

if [ "$MSG" = "-" ]; then
  MSG="$(cat)"
fi

# JSON-escape an arbitrary string (backslash, quote, control chars, newlines).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

FROM_J="$(json_escape "$FROM")"
TOPIC_J="$(json_escape "$TOPIC")"
MSG_J="$(json_escape "$MSG")"

if [ -n "$TITLE" ]; then
  TITLE_J="$(json_escape "$TITLE")"
  DATA="{\"msg\":\"$MSG_J\",\"title\":\"$TITLE_J\"}"
else
  DATA="{\"msg\":\"$MSG_J\"}"
fi

BODY="{\"from\":\"$FROM_J\",\"topic\":\"$TOPIC_J\",\"data\":$DATA}"

curl -sS --max-time 5 -X POST "$HUB/pub" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
