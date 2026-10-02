// Turns whatever the EA posted into a clean, bounded event object.
import { timingSafeEqual } from "node:crypto";

const TYPES = new Set(["signal", "open", "close", "status"]);
const SIDES = new Set(["BUY", "SELL"]);
const MODES = new Set(["signals", "auto"]);

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function checkSecret(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cleanEvent(body) {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const type = body.type;
  if (!TYPES.has(type)) return { error: "type must be signal, open, close or status" };
  const bot = str(body.bot, 32);
  const symbol = str(body.symbol, 40);
  if (!bot || !symbol) return { error: "bot and symbol are required" };

  const ev = {
    type,
    bot,
    symbol,
    mode: MODES.has(body.mode) ? body.mode : undefined,
    time: num(body.time) ? new Date(body.time * 1000).toISOString() : new Date().toISOString(),
    received: new Date().toISOString(),
  };
  if (type !== "status") {
    if (!SIDES.has(body.side)) return { error: "side must be BUY or SELL" };
    ev.side = body.side;
  }
  for (const k of ["entry", "sl", "tp", "lots", "confidence", "profit", "price",
                   "balance", "equity", "day_pl_pct", "open_positions", "trades_today"]) {
    const v = num(body[k]);
    if (v !== undefined) ev[k] = v;
  }
  for (const [k, max] of [["reason", 160], ["state", 40], ["regime", 20], ["currency", 8]]) {
    const v = str(body[k], max);
    if (v) ev[k] = v;
  }
  return { event: ev };
}
