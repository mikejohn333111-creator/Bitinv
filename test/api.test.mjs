// Runs the API handlers directly (memory storage). Usage: node test.mjs
import assert from "node:assert/strict";

process.env.TBOT_SECRET = "test-secret";
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
const { POST } = await import("../api/event.js");
const { GET } = await import("../api/feed.js");

const post = (body, secret = "test-secret") => POST(new Request("http://x/api/event", {
  method: "POST", headers: { "x-tbot-secret": secret, "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const now = Math.floor(Date.now() / 1000);

assert.equal((await post({ type: "signal" }, "wrong")).status, 401, "wrong secret rejected");
assert.equal((await post("{not json")).status, 400, "bad JSON rejected");
assert.equal((await post({ type: "hack", bot: "x", symbol: "y" })).status, 400, "unknown type rejected");
assert.equal((await post({ type: "signal", bot: "TbotAI", symbol: "EURUSD" })).status, 400, "missing side rejected");
assert.equal((await post("x".repeat(5000))).status, 413, "oversized body rejected");

let r = await post({ type: "signal", bot: "TbotAI", symbol: "Volatility 75 Index", mode: "signals", time: now,
                     side: "BUY", entry: 412345.67, sl: 411000.1, tp: 413700.2, lots: 0.005, confidence: 0.61,
                     reason: "<script>alert(1)</script>", extra: "dropped" });
assert.equal(r.status, 200, "signal accepted");
r = await post({ type: "close", bot: "TbotAdaptive", symbol: "EURUSD", mode: "auto", time: now, side: "SELL", profit: -12.5 });
assert.equal(r.status, 200, "close accepted");
r = await post({ type: "status", bot: "TbotAI", symbol: "Volatility 75 Index", mode: "signals", state: "ACTIVE",
                 equity: 10012.3, day_pl_pct: 0.12, open_positions: 0, currency: "USD" });
assert.equal(r.status, 200, "status accepted");

let feed = await (await GET(new Request("http://x/api/feed"))).json();
assert.equal(feed.storage, "memory");
assert.equal(feed.events.length, 2, "status heartbeats stay out of the activity list");
assert.equal(feed.events[0].type, "close", "newest first");
assert.equal(feed.events[1].extra, undefined, "unknown fields dropped");
assert.equal(feed.bots.length, 1);
assert.equal(feed.bots[0].equity, 10012.3);

process.env.TBOT_VIEW_KEY = "view-1";
assert.equal((await GET(new Request("http://x/api/feed"))).status, 401, "view key enforced");
assert.equal((await GET(new Request("http://x/api/feed?key=view-1"))).status, 200, "view key accepted");

console.log("all API tests passed");
