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
| `bus/test` | hub | test pushes |

`network/*` and `system/*` push at high priority.

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

## Files

- `hub.js` — the whole hub (~180 lines). `index.html` — the human page.
- `bus.jsonl` — the source of truth. `bus-config.json` — ntfy + forward map.
- `hub.log` — hub stdout/err when run via LaunchAgent.

## Connected apps

1. **NetworkDashboard** (`~/elianAI/elianLLMIdeas/NetworkDashboard`) — publishes
   via its `bus-pub.sh` from the presence/intruder/automation hooks.
2. **ElianCronBeta** — round 2: WS subscriber in the Electron main process maps
   `cron/*` topics to engine calls and publishes `job/completed` / `job/failed`.
