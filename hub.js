#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  ElianBus — ONE local message hub connecting all apps on this Mac.
//  Apps never talk to each other directly; everything flows through here and
//  is appended to bus.jsonl BEFORE fan-out: if it's not in the log, it didn't
//  happen. Localhost-only (127.0.0.1:9900), no auth, no external services —
//  except the OPTIONAL ntfy forwarder below, which pushes user-selected
//  topics to the user's phone.
//
//  In:   POST /pub              {"from":"app","topic":"a/b/c","data":{...}}
//        WS   /ws               {"type":"sub","topics":["presence/*"]}
//                               {"type":"pub","from":..,"topic":..,"data":..}
//  Out:  GET  /replay?topic=X&since=<ISO>&limit=N
//        GET  /topics           distinct topics ever seen
//        GET  /config  POST /config      bus-config.json (ntfy + forward map)
//        POST /test-push        send a test message to the phone
//        GET  /                 the human page (index.html)
// ─────────────────────────────────────────────────────────────────────────────
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const HERE = __dirname;
const HOST = "127.0.0.1", PORT = 9900;
const LOG = path.join(HERE, "bus.jsonl");
const CFG = path.join(HERE, "bus-config.json");

const DEFAULT_CFG = {
  ntfy: { enabled: false, server: "https://ntfy.sh", topic: "" },
  forward: { "network/intruder": true, "system/warning": true },
};
function loadCfg() {
  const c = JSON.parse(JSON.stringify(DEFAULT_CFG));
  try {
    const j = JSON.parse(fs.readFileSync(CFG, "utf8"));
    if (j.ntfy) c.ntfy = { ...c.ntfy, ...j.ntfy };
    if (j.forward) c.forward = j.forward;
  } catch {}
  return c;
}
function saveCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); }
if (!fs.existsSync(CFG)) saveCfg(DEFAULT_CFG);

// distinct topics ever seen — seeds the web page's push picker
const topicsSeen = new Set();
try {
  for (const l of fs.readFileSync(LOG, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { topicsSeen.add(JSON.parse(l).topic); } catch {}
  }
} catch {}

// trailing-wildcard match: "presence/*" covers presence/arrival and deeper;
// "#" or "*" alone covers everything; otherwise exact.
function matches(pattern, topic) {
  if (pattern === "#" || pattern === "*") return true;
  if (pattern.endsWith("/*")) return topic.startsWith(pattern.slice(0, -1));
  return topic === pattern;
}

const subs = new Set(); // connected WS clients, each with .topics = [patterns]

function publish(env) {
  if (!env || typeof env.from !== "string" || !env.from.trim()
           || typeof env.topic !== "string" || !env.topic.trim()) return false;
  const rec = { ts: env.ts || new Date().toISOString(),
                from: env.from, topic: env.topic, data: env.data ?? {} };
  const line = JSON.stringify(rec);
  fs.appendFileSync(LOG, line + "\n");          // LOG-FIRST, before any fan-out
  topicsSeen.add(rec.topic);
  for (const c of subs) {
    if (c.readyState === 1 && (c.topics || []).some(p => matches(p, rec.topic))) {
      try { c.send(line); } catch {}
    }
  }
  forwardToPhone(rec, false);
  return true;
}

// ntfy forwarder — fire-and-forget, must NEVER delay the log or the fan-out.
// Uses ntfy's JSON publish endpoint (POST to the server root) so titles and
// messages can carry full UTF-8 (HTTP headers can't).
function forwardToPhone(rec, force) {
  const cfg = loadCfg();
  if (!cfg.ntfy.enabled || !cfg.ntfy.topic) return;
  if (!force && !Object.entries(cfg.forward)
        .some(([p, on]) => on && matches(p, rec.topic))) return;
  const urgent = /^(network|system)\//.test(rec.topic);
  const body = JSON.stringify({
    topic: cfg.ntfy.topic,
    title: String((rec.data && rec.data.title) || rec.topic),
    message: (rec.data && rec.data.msg) ? String(rec.data.msg) : JSON.stringify(rec.data),
    priority: urgent ? 4 : 3,
    tags: [urgent ? "warning" : "incoming_envelope"],
  });
  try {
    const url = new URL(cfg.ntfy.server);
    const req = (url.protocol === "http:" ? http : https).request(url, {
      method: "POST", timeout: 8000,
      headers: { "Content-Type": "application/json" },
    }, r => r.resume());
    req.on("error", e => console.error("ntfy:", e.message));
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch (e) { console.error("ntfy:", e.message); }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
    res.end(body);
  };
  if (req.method === "POST") {
    let raw = "";
    req.on("data", d => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let j; try { j = JSON.parse(raw || "{}"); } catch { return send(400, '{"err":"bad json"}'); }
      if (u.pathname === "/pub")
        return publish(j) ? send(200, '{"ok":true}') : send(400, '{"err":"need from + topic"}');
      if (u.pathname === "/config") {
        const c = loadCfg();
        if (j.ntfy) c.ntfy = { ...c.ntfy, ...j.ntfy };
        if (j.forward) c.forward = { ...c.forward, ...j.forward }; // partial update; false disables
        saveCfg(c);
        return send(200, JSON.stringify(c));
      }
      if (u.pathname === "/test-push") {
        const cfg = loadCfg();
        if (!cfg.ntfy.enabled || !cfg.ntfy.topic)
          return send(400, '{"err":"enable push and set a topic first"}');
        forwardToPhone({ topic: "bus/test", from: "hub",
                         data: { title: "ElianBus", msg: "Test push — it works! 🎉" } }, true);
        return send(200, '{"ok":true}');
      }
      return send(404, '{"err":"not found"}');
    });
    return;
  }
  if (u.pathname === "/" || u.pathname === "/manual") {
    const page = u.pathname === "/" ? "index.html" : "manual.html";
    try { return send(200, fs.readFileSync(path.join(HERE, page)), "text/html; charset=utf-8"); }
    catch { return send(500, page + " missing", "text/plain"); }
  }
  if (u.pathname === "/config") return send(200, JSON.stringify(loadCfg()));
  if (u.pathname === "/topics") return send(200, JSON.stringify([...topicsSeen].sort()));
  if (u.pathname === "/replay") {
    const topic = u.searchParams.get("topic") || "#";
    const since = u.searchParams.get("since") || "";
    const limit = parseInt(u.searchParams.get("limit") || "0", 10);
    let out = [];
    try {
      for (const l of fs.readFileSync(LOG, "utf8").split("\n")) {
        if (!l.trim()) continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (matches(topic, e.topic) && (!since || e.ts >= since)) out.push(e);
      }
    } catch {}
    if (limit > 0) out = out.slice(-limit);
    return send(200, JSON.stringify(out));
  }
  send(404, '{"err":"not found"}');
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", ws => {
  ws.topics = ["#"];                    // until it sends a sub frame: everything
  subs.add(ws);
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "sub" && Array.isArray(m.topics)) ws.topics = m.topics.map(String);
    else if (m.type === "pub") publish({ ts: m.ts, from: m.from, topic: m.topic, data: m.data });
  });
  ws.on("close", () => subs.delete(ws));
  ws.on("error", () => subs.delete(ws));
});

server.on("error", e => {
  console.error(e.code === "EADDRINUSE"
    ? `FATAL: port ${PORT} is already in use — is another hub running?`
    : "FATAL: " + e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () =>
  console.log(`ElianBus hub on http://${HOST}:${PORT}  (log: bus.jsonl)`));
