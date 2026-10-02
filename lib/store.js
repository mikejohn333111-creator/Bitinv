// Event storage. Uses Upstash Redis (add it from the Vercel Marketplace; it sets
// KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / _TOKEN).
// Without those variables it falls back to memory, which is fine for local
// testing but is wiped whenever Vercel starts a new instance.

const MAX_EVENTS = 300;
const EVENTS_KEY = "tbot:events";
const STATUS_KEY = "tbot:status";

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const mem = (globalThis.__tbotMem ??= { events: [], status: {} });

export const storageKind = () => (REDIS_URL && REDIS_TOKEN ? "redis" : "memory");

async function redis(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  const out = await res.json();
  const failed = out.find((r) => r.error);
  if (failed) throw new Error(`Redis error: ${failed.error}`);
  return out.map((r) => r.result);
}

const statusField = (ev) => `${ev.bot}|${ev.symbol}`;

export async function saveEvent(ev) {
  const json = JSON.stringify(ev);
  if (storageKind() === "memory") {
    if (ev.type === "status") mem.status[statusField(ev)] = ev;
    else {
      mem.events.unshift(ev);
      mem.events.length = Math.min(mem.events.length, MAX_EVENTS);
    }
    return;
  }
  // Heartbeats only update the latest status; everything else goes on the feed.
  if (ev.type === "status") await redis([["HSET", STATUS_KEY, statusField(ev), json]]);
  else await redis([["LPUSH", EVENTS_KEY, json], ["LTRIM", EVENTS_KEY, 0, MAX_EVENTS - 1]]);
}

export async function loadFeed(limit = 100) {
  if (storageKind() === "memory") {
    return { events: mem.events.slice(0, limit), bots: Object.values(mem.status) };
  }
  const [events, status] = await redis([["LRANGE", EVENTS_KEY, 0, limit - 1], ["HGETALL", STATUS_KEY]]);
  const bots = [];
  for (let i = 1; i < (status || []).length; i += 2) bots.push(JSON.parse(status[i]));
  return { events: (events || []).map((e) => JSON.parse(e)), bots };
}
