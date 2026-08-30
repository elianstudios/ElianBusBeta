# ElianBus

One local message hub connecting every app on this Mac. Apps never talk to each
other directly — everything flows through the hub at `127.0.0.1:9900`, and every
message is appended to `bus.jsonl` **before** fan-out: *if it's not in the log,
it didn't happen.* Selected topics are forwarded to the phone via
[ntfy](https://ntfy.sh) (built into the hub, configured from its web page).

## Message envelope (one shape, forever)

```json
{"ts": "2026-07-16T01:00:00.000Z", "from": "network-dashboard", "topic": "presence/arrival", "data": {"msg": "Phone is home"}}
```

- `ts` — stamped by the hub if the publisher omits it.
- `from` — app name (`human` for hand-injected messages). Required.
- `topic` — `a/b/c` path. Required.
- `data` — anything. Convention: `data.msg` = human-readable one-liner (used as
  the phone-push body), `data.title` = optional push title.

## Topic conventions

| Topic | Publisher | Meaning |
|---|---|---|
| `presence/arrival` | network-dashboard | trusted device came online |
| `presence/departure` | network-dashboard | trusted device left |
| `network/intruder` | network-dashboard | unknown device on the Wi-Fi |
| `automation/fired` | network-dashboard | an automation rule ran |
| `system/warning` | any | something is broken and needs a human |
| `job/completed`, `job/failed` | eliancron (round 2) | job results |
| `cron/run` | any (round 2) | ask ElianCron to run a job |
| `grok/prompt` | bridge / any | inbound request **to** grokbot (not pushed) |
| `grok/reply` | grokbot | grokbot's answer → phone |
| `grok/status` | grokbot | grokbot progress / errors → phone |
| `elian/prompt` | bridge / any | inbound request **to** elianbot (not pushed) |
| `elian/reply` | elianbot | elianbot's answer → phone |
| `elian/status` | elianbot | elianbot progress / errors → phone |
| `bus/test` | hub | test pushes |

`network/*` and `system/*` push at high priority. `grok/reply`, `grok/status`,
`elian/reply` and `elian/status` are forwarded to the phone by default (see the
`forward` map in `hub.js`); the matching `*/prompt` inbound topics are
deliberately NOT forwarded so you don't get an echo of what you just typed.

## Ways in

```bash
# fire-and-forget publish
curl -d '{"from":"human","topic":"test/ping","data":{"msg":"hi"}}' localhost:9900/pub

# watch everything live
tail -f bus.jsonl

# replay
curl 'localhost:9900/replay?topic=presence/*&since=2026-07-16T00:00:00&limit=50'
```

WebSocket `ws://127.0.0.1:9900/ws` — send
`{"type":"sub","topics":["presence/*","#"]}` to subscribe (trailing `/*`
wildcard; `#` = everything), `{"type":"pub", ...envelope}` to publish.
Subscribers receive raw envelope lines.

## Phone push (ntfy)

Open <http://localhost:9900> → **Generate** a secret topic → install the
**ntfy** app on the phone → *Subscribe to topic* with that name → enable the
switch → **Send test**. Then tick the 📲 checkbox next to each topic you want
on the phone. The phone does NOT need to be on the same network.

Privacy: messages transit the public ntfy.sh server, protected only by the
secrecy of the topic name (that's why it's long and random). For fully-private
operation, self-host ntfy and change the server field.

## Run

- Manual: double-click `Start.command` (installs `ws` on first run), or `npm install && node hub.js`.
- Always-on (macOS LaunchAgent) — the plist ships with placeholder paths; point them at your clone, then load it:

  ```bash
  sed "s|/Users/USERNAME/ElianBus|$(pwd)|g; s|/opt/homebrew/bin/node|$(command -v node)|g" \
      com.elian.elianbus.plist > ~/Library/LaunchAgents/com.elian.elianbus.plist
  launchctl load ~/Library/LaunchAgents/com.elian.elianbus.plist
  ```

## Claude bridge (talk to Claude Code from your phone)

`claude-bridge.js` turns the ntfy topic into a **two-way chat thread** and wires
it to a persistent headless [Claude Code](https://claude.com/claude-code)
session on this machine — long conversations from anywhere, no bot platform,
no session timeout.

- Type into the same ntfy topic your pushes arrive on. The bridge streams the
  topic, ignores the hub's own pushes (they carry an `elianbus` tag), and
  **routes** each message by its first word:

  | You type | Goes to bus topic | Then |
  |---|---|---|
  | `claude <passphrase> <text>` | `claude/prompt` | runs `claude -p --resume` → reply pushed back as `claude/reply` |
  | `cron <passphrase> <text>` | `cron/run` | (reserved — inert until the ElianCron adapter) |
  | `grok <passphrase> <text>` | `grok/prompt` | consumed by grokbot (a process you run) → reply on `grok/reply` |
  | `elian <passphrase> <text>` | `elian/prompt` | consumed by elianbot (a process you run) → reply on `elian/reply` |
  | anything else | `phone/message` | just lands on the bus + dashboard |

- Session state lives in `.claude-session.json` — full conversation context for
  days. `claude <passphrase> !new` starts fresh; `!status` reports.
- Protected routes require the passphrase from `claude-bridge-config.json`
  (auto-created on first run — **change it**). Claude runs with default
  permissions, so a hijacked topic can chat but not drive privileged tools.
- Run it: `node claude-bridge.js`, or always-on via
  `com.elian.elianbus.claude.plist` (same `sed` install as the hub plist above).
- Tick 📲 on `claude/reply` in the web page so answers reach your phone.

## Connecting a bot (e.g. grokbot)

ElianBus doesn't run your bot — it's the pipe your bot plugs into. A bot is any
process that (optionally) **listens** for requests on the bus and **publishes**
its outcomes back, which the hub then forwards to your phone. `grok/*` and
`elian/*` are wired up out of the box; copy the pattern for any other bot.

**Publish an outcome** (the easy path — one shell line via the helper):

```bash
# answer → phone
./bus-pub.sh grokbot grok/reply  "done: summarized 42 unread emails" "Grok"
# progress / error → phone
./bus-pub.sh grokbot grok/status "failed: upstream rate-limited, retrying" "Grok"
# long output from stdin
grok-run-something | ./bus-pub.sh grokbot grok/reply - "Grok"
```

or POST the envelope yourself from any language:

```bash
curl -d '{"from":"grokbot","topic":"grok/reply","data":{"title":"Grok","msg":"hi from grok"}}' localhost:9900/pub
```

`grok/reply` and `grok/status` are in the default forward map, so they reach the
phone with **no web-page setup** beyond enabling push once and subscribing to
your ntfy topic. (Everything is still logged to `bus.jsonl` regardless.)

**Listen for requests** (optional — only if you want to *ask* grokbot things
from the phone). Subscribe to `grok/prompt` over the WebSocket and reply on
`grok/reply`:

```js
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:9900/ws");
ws.on("open", () => ws.send(JSON.stringify({ type: "sub", topics: ["grok/prompt"] })));
ws.on("message", async (line) => {
  const env = JSON.parse(line);
  const answer = await runGrok(env.data.msg);      // your bot logic
  ws.send(JSON.stringify({ type: "pub", from: "grokbot", topic: "grok/reply",
                           data: { title: "Grok", msg: answer } }));
});
```

**Two-way from the phone.** The Claude bridge (below) already routes `grok` and
`elian` keywords: typing `grok <passphrase> <text>` (or `elian <passphrase>
<text>`) in your ntfy thread lands on `grok/prompt` (or `elian/prompt`) for the
listener above to pick up — so you get phone → bot → phone round-trips with
nothing else to build on the hub side.

## Files

- `hub.js` — the whole hub (~180 lines). `index.html` — the human page.
- `claude-bridge.js` — phone ⇄ bus router + headless Claude runner.
- `bus-pub.sh` — one-line publish helper for bots/scripts (`bus-pub.sh <from> <topic> <msg> [title]`).
- `bus.jsonl` — the source of truth. `bus-config.json` — ntfy + forward map.
- `claude-bridge-config.json` — passphrase, routes, session cwd (never commit).
- `hub.log` / `claude-bridge.log` — service output when run via LaunchAgents.

## Connected apps

1. **NetworkDashboard** (`~/elianAI/elianLLMIdeas/NetworkDashboard`) — publishes
   via its `bus-pub.sh` from the presence/intruder/automation hooks.
2. **ElianCronBeta** — round 2: WS subscriber in the Electron main process maps
   `cron/*` topics to engine calls and publishes `job/completed` / `job/failed`.
