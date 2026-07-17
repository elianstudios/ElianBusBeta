#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  claude-bridge — phone ⇄ ElianBus ⇄ headless Claude Code.
//
//  Two loops in one process:
//
//  LOOP 1  (ntfy inbound + router)
//    Streams the hub's OWN ntfy topic (read live from GET <hub>/config), so the
//    phone's ntfy thread becomes two-way: pushes go out, typed messages come
//    back. Hub-sent events carry the "elianbus" tag and are ignored (no echo
//    loops). Each phone message is ROUTED by its first word:
//        "claude <passphrase> <text>"  → bus topic claude/prompt
//        "cron   <passphrase> <text>"  → bus topic cron/run
//        anything else                 → bus topic phone/message
//    Protected routes require the passphrase; failures are published to
//    claude/rejected (visible in the log, never executed). EVERY phone message
//    lands on the bus — routing only picks the topic.
//
//  LOOP 2  (claude runner)
//    Subscribes to claude/prompt on the bus. One prompt at a time (FIFO):
//    spawns `claude -p <text> --output-format json` (+ --resume <session>),
//    keeps the session id in a file so the conversation has FULL CONTEXT for
//    days — no chat-platform time limits. Replies go to claude/reply in
//    ≤3800-char chunks; tick 📲 on claude/reply and they reach the phone.
//    Runs with DEFAULT permissions on purpose: a hijacked channel can chat,
//    not drive privileged tools.
//
//  Commands (as claude messages): "!new" fresh session · "!status" info.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const HERE = __dirname;
const HUB = process.env.ELIANBUS_URL || "http://127.0.0.1:9900";
const CFG_F = path.join(HERE, "claude-bridge-config.json");

const DEFAULT_CFG = {
  passphrase: "changeme",
  token: "",                                  // ntfy auth token (self-hosted servers)
  routes: {
    claude: { topic: "claude/prompt", protected: true },
    cron:   { topic: "cron/run",      protected: true },
  },
  defaultTopic: "phone/message",
  sessionFile: ".claude-session.json",
  cwd: process.env.HOME || HERE,              // where claude sessions run
  timeoutMin: 15,
};
function loadCfg() {
  let c = JSON.parse(JSON.stringify(DEFAULT_CFG));
  try { c = { ...c, ...JSON.parse(fs.readFileSync(CFG_F, "utf8")) }; } catch {}
  return c;
}
if (!fs.existsSync(CFG_F)) fs.writeFileSync(CFG_F, JSON.stringify(DEFAULT_CFG, null, 2));

const log = (...a) => console.log(new Date().toISOString().slice(5, 19), ...a);

// ── bus publish (fire-and-forget; a down hub must never crash the bridge) ────
async function pub(topic, msg, extra) {
  try {
    await fetch(HUB + "/pub", { method: "POST", signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ from: "claude-bridge", topic, data: { msg, ...(extra || {}) } }) });
  } catch (e) { log("pub failed:", topic, e.message); }
}

// ═════════════════════════════════════════════════════ LOOP 1: ntfy inbound ═
async function ntfySettings() {
  // the hub's bus-config.json is the ONE place ntfy server/topic live —
  // ask the hub instead of duplicating config.
  const r = await fetch(HUB + "/config", { signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  return { server: (j.ntfy.server || "https://ntfy.sh").replace(/\/$/, ""), topic: j.ntfy.topic || "" };
}

function route(text) {
  const cfg = loadCfg();
  const words = text.trim().split(/\s+/);
  const r = cfg.routes[(words[0] || "").toLowerCase()];
  if (!r) return { topic: cfg.defaultTopic, msg: text.trim() };            // unrouted note
  if (r.protected) {
    if (words[1] !== cfg.passphrase)
      return { topic: "claude/rejected", msg: "bad/missing passphrase: " + text.slice(0, 80) };
    return { topic: r.topic, msg: words.slice(2).join(" ") };
  }
  return { topic: r.topic, msg: words.slice(1).join(" ") };
}

async function inboundLoop() {
  for (;;) {
    let topic = "";
    try {
      const s = await ntfySettings();
      topic = s.topic;
      if (!topic) { log("inbound: no ntfy topic configured yet — retry in 30s"); await sleep(30000); continue; }
      const cfg = loadCfg();
      const headers = { };
      if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
      log("inbound: streaming", s.server + "/" + topic.slice(0, 8) + "…");
      // since=all is wrong here (would replay history every reconnect); the bus
      // log is the memory — the stream only needs NEW messages.
      // Watchdog: ntfy sends keepalive events ~45s apart. A silently-dead TCP
      // connection would hang this stream forever (and phone messages would
      // just stop) — so abort if NOTHING arrives for 120s and reconnect.
      const ac = new AbortController();
      let lastData = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastData > 120000) ac.abort();
      }, 15000);
      let res;
      try {
        res = await fetch(`${s.server}/${topic}/json`, { headers, signal: ac.signal });
      } catch (e) { clearInterval(watchdog); throw e; }
      let buf = "";
      try {
      for await (const chunk of res.body) {
        lastData = Date.now();
        buf += Buffer.from(chunk).toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event !== "message") continue;
          if ((ev.tags || []).includes("elianbus")) continue;   // our own push — never re-ingest
          const text = String(ev.message || "");
          if (!text.trim()) continue;
          const { topic: busTopic, msg } = route(text);
          log("inbound:", busTopic, "←", text.slice(0, 60));
          await pub(busTopic, msg);
        }
      }
      } finally { clearInterval(watchdog); }
      log("inbound: stream ended, reconnecting");
    } catch (e) { log("inbound error:", e.message); }
    await sleep(2000);
  }
}

// ═════════════════════════════════════════════════════ LOOP 2: claude runner ═
const CHUNK = 3800;                       // ntfy message size headroom
const queue = [];
let busy = false;

function session() {
  const cfg = loadCfg();
  try { return JSON.parse(fs.readFileSync(path.join(HERE, cfg.sessionFile), "utf8")); }
  catch { return {}; }
}
function saveSession(s) {
  const cfg = loadCfg();
  fs.writeFileSync(path.join(HERE, cfg.sessionFile), JSON.stringify(s, null, 2));
}

function runClaude(prompt) {
  const cfg = loadCfg();
  const s = session();
  const args = ["-p", prompt, "--output-format", "json"];
  if (s.id) args.push("--resume", s.id);
  return new Promise(resolve => {
    const child = spawn("claude", args, { cwd: cfg.cwd, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, cfg.timeoutMin * 60000);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("error", e => { clearTimeout(timer); resolve({ error: "spawn failed: " + e.message }); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.session_id) saveSession({ id: j.session_id, updated: new Date().toISOString() });
        resolve({ text: j.result || "(empty reply)", isError: !!j.is_error });
      } catch {
        resolve({ error: `claude exited ${code}${err ? ": " + err.slice(0, 300) : ""}${out ? " | " + out.slice(0, 200) : ""}` });
      }
    });
  });
}

async function reply(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  for (let i = 0; i < parts.length; i++)
    await pub("claude/reply", parts[i], parts.length > 1 ? { part: `${i + 1}/${parts.length}` } : {});
}

async function handlePrompt(msg) {
  const text = String(msg || "").trim();
  if (!text) return;
  if (text === "!new")   { saveSession({}); return reply("🆕 fresh session — context cleared."); }
  if (text === "!status") {
    const s = session();
    return reply(`session: ${s.id || "(none yet)"} · updated ${s.updated || "—"} · queue ${queue.length}`);
  }
  log("claude ←", text.slice(0, 60));
  const t0 = Date.now();
  const r = await runClaude(text);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.error) return reply("⚠️ " + r.error);
  log("claude →", `${secs}s,`, r.text.slice(0, 60));
  return reply(r.text);
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) await handlePrompt(queue.shift());
  busy = false;
}

function runnerLoop() {
  const ws = new WebSocket(HUB.replace(/^http/, "ws") + "/ws");
  ws.on("open", () => { log("runner: subscribed claude/prompt"); ws.send(JSON.stringify({ type: "sub", topics: ["claude/prompt"] })); });
  ws.on("message", line => {
    try { const e = JSON.parse(line); queue.push(e.data && e.data.msg); drain(); } catch {}
  });
  ws.on("close", () => { log("runner: bus connection lost, retrying"); setTimeout(runnerLoop, 2000); });
  ws.on("error", () => {});
}

// ═════════════════════════════════════════════════════════════════ startup ═
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  log("claude-bridge starting — hub:", HUB);
  const cfg = loadCfg();
  if (cfg.passphrase === "changeme")
    log("⚠️  passphrase is still 'changeme' — edit claude-bridge-config.json");
  const probe = spawn("claude", ["--version"]);
  probe.on("error", () => { log("FATAL: claude CLI not found on PATH"); pub("system/warning", "claude-bridge: claude CLI not found"); });
  runnerLoop();
  inboundLoop();
})();
