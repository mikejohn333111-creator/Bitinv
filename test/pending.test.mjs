// "Waiting for price" plans (public/js/pending.js), the strategies' pending setups, the
// strategy timeframe helpers and Deriv's market list (public/js/markets.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateICT, evaluateRules, ictMinBars, aggregate, historyCount, minBarsFor, rulesParamsFor, rulesMinBars,
         botTfOf, barSeconds, RULES_DEFAULTS, AI_MIN_BARS, PENDING_BARS } from "../public/js/strategy.js";
import { PendingPlan, makePending, pendingCheck, pendingEntry, describePending, firstTouch } from "../public/js/pending.js";
import { parseMarkets, groupMarkets, marketsOrFallback, isClosed, isSynthetic, marketName, FALLBACK_MARKETS,
         MARKETS_REQUEST } from "../public/js/markets.js";
import { drawable } from "../public/js/plan.js";

const T0 = 1767225600;
const mk = (rows, sec = 60) => rows.map(([o, h, l, c], k) => ({ epoch: T0 + k * sec, open: o, high: h, low: l, close: c }));
const flat = (n) => Array.from({ length: n }, () => [100, 100.5, 99.5, 100]);
const SETUP = [
  [100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2], [98.2, 98.4, 96.5, 97.5], [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6],     // displacement: breaks the 101 swing high
  [101.6, 102.5, 101.2, 102.2],   // the gap (99 to 101.2) is complete after this candle
  [102.2, 102.4, 101.6, 101.8],   // holds above the gap
];
const HOLD = [101.8, 102.0, 101.6, 101.8];
const mirror = (bars) => bars.map((b) => ({ epoch: b.epoch, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
const upTo = (n, extra = []) => mk([...flat(ictMinBars()), ...SETUP.slice(0, n), ...extra]);

// ------------------------------------------------------------ strategies
test("ICT: a setup whose gap has formed but not been revisited is a waiting plan, not a trade", () => {
  assert.equal(evaluateICT(upTo(11)).pending, undefined, "no gap yet");
  const r = evaluateICT(upTo(12));
  assert.equal(r.action, null);
  const p = r.pending;
  assert.equal(p.side, "BUY");
  assert.deepEqual(p.zone, [99, 101.2]);
  assert.equal(p.invalidateAt, 96.5, "beyond the sweep's low");
  assert.ok(p.sl < 96.5 && p.sl > 96.5 - 0.2 * r.atr, `stop just below the sweep: ${p.sl}`);
  assert.ok(Math.abs((p.tp - 101.2) - 2 * (101.2 - p.sl)) < 1e-9, "2R from the zone top");
  const bars = upTo(12), sec = barSeconds(bars);
  assert.equal(p.expiresAt, bars.at(-1).epoch + sec * (1 + PENDING_BARS), "30 candles after the gap's candle");
  assert.match(p.reason, /Waiting for price to come back to the fair value gap \(99\.000 to 101\.200\)/);
  assert.equal(evaluateICT(upTo(13)).pending.id, p.id, "still the same setup a candle later");
  // the touch candle is still the closed-candle entry the backtests use, with the same setup id
  const entry = evaluateICT(upTo(13, [[101.8, 101.9, 100.8, 101.0]]));
  assert.equal(entry.action, "BUY");
  assert.equal(entry.setupId, p.id);
});

test("ICT: the sell mirror waits too, and a broken setup does not", () => {
  const r = evaluateICT(mirror(upTo(12)));
  assert.equal(r.pending.side, "SELL");
  assert.deepEqual(r.pending.zone, [98.8, 101]);
  assert.equal(r.pending.invalidateAt, 103.5);
  assert.ok(r.pending.sl > 103.5 && r.pending.tp < 98.8);
  // a candle through the sweep's low ends the setup
  assert.equal(evaluateICT(upTo(13, [[101.8, 101.9, 96.0, 96.2]])).pending, undefined);
});

test("Rules: a trend without a pullback gives a waiting plan at the fast EMA band, with the rule's ATR distances", () => {
  // an uptrend that swings, so RSI stays below 70 and some candles stay above the fast EMA band
  const rows = [];
  let p = 1000;
  for (let i = 0; i < 1300; i++) { const o = p; p += Math.sin(i / 3) * 1.5 + 0.35; rows.push([o, Math.max(o, p) + 0.2, Math.min(o, p) - 0.05, p]); }
  const bars = mk(rows);
  let found = null;
  for (let n = rulesMinBars() + 10; n <= bars.length && !found; n += 7) {
    const r = evaluateRules(bars.slice(0, n));
    if (r.pending) found = r;
  }
  assert.ok(found, "a waiting plan in a steady trend");
  const q = found.pending, atr = found.atr;
  assert.equal(q.side, "BUY");
  assert.ok(Math.abs(q.zone[1] - q.zone[0] - RULES_DEFAULTS.pullbackATR * atr) < 1e-9);
  assert.ok(Math.abs(q.zone[1] - q.sl - RULES_DEFAULTS.trendSL * atr) < 1e-9);
  assert.ok(Math.abs(q.tp - q.zone[1] - RULES_DEFAULTS.trendTP * atr) < 1e-9);
  assert.equal(q.sticky, false, "follows the indicators");
});

// ------------------------------------------------------------ the plan
test("pending plan: entered on the first price inside the zone, with exactly the drawn stop loss and take profit", () => {
  const pp = new PendingPlan();
  const res = evaluateICT(upTo(12));
  const ev = pp.offer(res, { strategy: "ict", symbol: "R_75", barSec: 60 });
  assert.equal(ev.type, "new");
  const plan = ev.plan, now = upTo(12).at(-1).epoch + 60;
  assert.equal(firstTouch(plan), 101.2);
  assert.equal(pp.offer(evaluateICT(upTo(13)), { strategy: "ict" }), null, "the same setup a candle later changes nothing");
  assert.equal(pp.plan.sl, plan.sl, "an ICT plan keeps its levels");
  assert.equal(pp.price(101.6, now), null, "above the zone: keep waiting");
  const hit = pp.price(101.05, now + 5);
  assert.equal(hit.type, "enter");
  const sig = hit.signal;
  assert.equal(sig.action, "BUY");
  assert.equal(sig.entry, 101.05);
  assert.ok(Math.abs(sig.entry - sig.slDist - plan.sl) < 1e-9, "stop loss price = the drawn one");
  assert.ok(Math.abs(sig.entry + sig.tpDist - plan.tp) < 1e-9, "take profit price = the drawn one");
  assert.equal(sig.horizonBars, 30);
  assert.match(sig.reason, /Price came back to the fair value gap/);
  assert.equal(pp.plan, null);
  assert.ok(pp.used(res.pending.id), "the closed-candle signal of the same setup is not used again");
  assert.equal(pp.offer(evaluateICT(upTo(13)), { strategy: "ict" }), null, "an entered setup is not offered again");
});

test("pending plan: cancelled when it expires, when price breaks the sweep extreme, or jumps past the zone", () => {
  const offer = () => { const pp = new PendingPlan(); pp.offer(evaluateICT(upTo(12)), { strategy: "ict" }); return pp; };
  let pp = offer();
  const exp = pp.plan.expiresAt;
  assert.equal(pp.price(101.6, exp - 60), null);
  let ev = pp.price(101.6, exp);
  assert.equal(ev.type, "cancel"); assert.equal(ev.why, "expired"); assert.equal(pp.plan, null);
  assert.equal(pp.price(101.0, exp), null, "nothing left to enter");

  pp = offer();
  ev = pp.price(96.4, exp - 600);
  assert.equal(ev.why, "invalid");
  assert.match(ev.text, /below the low/);

  pp = offer();
  ev = pp.price(98.0, exp - 600);
  assert.equal(ev.why, "through");
  assert.ok(pp.used(ev.plan.id), "a cancelled setup is not offered again");

  pp = offer();
  ev = pp.cancel("stopped", "the bot was stopped");
  assert.equal(ev.type, "cancel");
  assert.equal(pp.cancel("stopped", "again"), null);
});

test("pending plan: a Rules plan follows the indicators, and goes when they no longer agree", () => {
  const pp = new PendingPlan();
  const mkRes = (lo) => ({ pending: { id: "rules:BUY", side: "BUY", zone: [lo, lo + 1], sl: lo - 4, tp: lo + 9, expiresAt: T0 + 9999, invalidateAt: lo - 4, sticky: false, reason: "r" } });
  assert.equal(pp.offer(mkRes(100), { strategy: "rules" }).type, "new");
  const up = pp.offer(mkRes(101), { strategy: "rules" });
  assert.equal(up.type, "update");
  assert.deepEqual(pp.plan.zone, [101, 102]);
  const gone = pp.offer({ action: null }, { strategy: "rules" });
  assert.equal(gone.type, "cancel"); assert.equal(gone.why, "gone");
  assert.equal(pp.offer(mkRes(100), { strategy: "rules" }).type, "new", "a later trend plan may come back");
  const other = pp.offer({ pending: { ...mkRes(100).pending, id: "rules:SELL", side: "SELL", zone: [100, 101], sl: 105, tp: 90, invalidateAt: 105 } }, { strategy: "rules" });
  assert.equal(other.type, "new");
  assert.equal(other.replaced.side, "BUY");
});

test("pending plan: odd setups are refused, and the text says what it waits for", () => {
  const base = { side: "BUY", zone: [99, 101], sl: 97, tp: 105, expiresAt: T0 + 600, invalidateAt: 97.5 };
  assert.ok(makePending(base));
  assert.equal(makePending({ ...base, sl: 100 }), null, "stop inside the zone");
  assert.equal(makePending({ ...base, tp: 100 }), null, "target inside the zone");
  assert.equal(makePending({ ...base, side: "UP" }), null);
  assert.equal(makePending({ ...base, expiresAt: NaN }), null);
  const plan = makePending(base);
  assert.equal(pendingCheck(plan, 102, T0).kind, "wait");
  assert.equal(pendingCheck(plan, 99, T0).kind, "enter");
  assert.equal(pendingEntry({ ...plan, sl: 99.5 }, 99.2), null, "stop on the wrong side of the touch price");
  const text = describePending(plan, (v) => v.toFixed(1), () => "10:30");
  assert.equal(text, "Buy if price comes back to 99.0 to 101.0. Stop loss 97.0, take profit 105.0. Cancelled at 10:30 or if price goes below 97.5.");
  assert.equal(drawable({ kind: "pending", ...plan }), true);
  assert.equal(drawable({ kind: "pending", ...plan, tp: 100 }), false);
});

// ------------------------------------------------------------ timeframe
test("strategy timeframe: history sizing gives each strategy enough candles", () => {
  assert.equal(botTfOf({ botTf: 3600 }), 3600);
  assert.equal(botTfOf({ botTf: 300 }), 60, "only 1m, 15m and 1h");
  assert.equal(botTfOf({}), 60);
  for (const tf of [60, 900, 3600]) for (const s of ["rules", "ai", "ict"]) {
    const n = historyCount(s, tf);
    assert.ok(n >= minBarsFor(s, tf) + 50, `${s} on ${tf}: ${n} candles`);
    assert.ok(n <= 5000, "Deriv sends at most 5000");
  }
  assert.equal(historyCount("ai", 60), 1200, "the 1-minute chart keeps its 1200 candles");
  assert.equal(minBarsFor("ai", 3600), AI_MIN_BARS);
  assert.equal(minBarsFor("ict", 900), ictMinBars());
  // Rules: the higher timeframe follows TbotAdaptive (M1 -> M15, M15 -> H1, H1 -> H4)
  assert.deepEqual([60, 900, 3600].map((g) => rulesParamsFor(g).htfMinutes), [15, 60, 240]);
  assert.deepEqual([60, 900, 3600].map((g) => rulesParamsFor(g).barMinutes), [1, 15, 60]);
  assert.equal(minBarsFor("rules", 60), rulesMinBars(RULES_DEFAULTS));
  assert.equal(minBarsFor("rules", 3600), 4 * 55, "55 four-hour candles of one-hour bars");
});

test("strategy timeframe: 1-hour candles group into complete 4-hour candles, and an unfinished one is dropped", () => {
  const h1 = mk(Array.from({ length: 10 }, (_, k) => [k, k + 1, k - 1, k + 0.5]), 3600);   // starts on a 4h boundary
  const h4 = aggregate(h1, 240, 60);
  assert.equal(h4.length, 2, "8 candles make two 4-hour candles; the last 2 are unfinished");
  assert.deepEqual([h4[0].open, h4[0].high, h4[0].low, h4[0].close], [0, 4, -1, 3.5]);
  assert.equal(aggregate(h1.slice(0, 8), 240, 60).length, 2, "a finished last group is kept");
  // the default (1-minute bars) is unchanged
  assert.equal(aggregate(mk(Array.from({ length: 30 }, () => [1, 2, 0, 1])), 15).length, 2);
  // Rules decide on 1-hour candles with enough of them
  const rows = Array.from({ length: historyCount("rules", 3600) }, (_, k) => [100 + Math.sin(k / 7), 101 + Math.sin(k / 7), 99 + Math.sin(k / 7), 100.2 + Math.sin(k / 7)]);
  const r = evaluateRules(mk(rows, 3600), rulesParamsFor(3600));
  assert.notEqual(r.info.note, "loading history");
});

// ------------------------------------------------------------ markets
const ACTIVE = [
  { underlying_symbol: "R_75", display_name: "Volatility 75 Index", market: "synthetic_index", market_display_name: "Derived", submarket: "random_index", exchange_is_open: 1, is_trading_suspended: 0, display_order: 3 },
  { underlying_symbol: "frxEURUSD", display_name: "EUR/USD", market: "forex", market_display_name: "Forex", submarket: "major_pairs", exchange_is_open: 1, is_trading_suspended: 0, display_order: 1 },
  { underlying_symbol: "frxXAUUSD", display_name: "Gold/USD", market: "commodities", market_display_name: "Commodities", submarket: "metals", exchange_is_open: 0, is_trading_suspended: 0, display_order: 2 },
  { symbol: "cryBTCUSD", display_name: "BTC/USD", market: "cryptocurrency", market_display_name: "Cryptocurrencies", submarket: "non_stable_coin", exchange_is_open: 1, is_trading_suspended: 0 },
  { underlying_symbol: "OTC_DJI", display_name: "Wall Street 30", market: "indices", market_display_name: "Stock Indices", submarket: "americas_OTC", exchange_is_open: 1, is_trading_suspended: 0 },
  { underlying_symbol: "bad symbol!", market: "forex" }, null,
];

test("markets: active_symbols asks for Multipliers only; the answer is grouped, with closed markets marked", () => {
  assert.deepEqual(MARKETS_REQUEST.contract_type, ["MULTUP", "MULTDOWN"]);
  assert.equal(MARKETS_REQUEST.active_symbols, "brief");
  const all = parseMarkets(ACTIVE);
  assert.deepEqual(all.map((m) => m.symbol), ["R_75", "frxEURUSD", "frxXAUUSD", "cryBTCUSD", "OTC_DJI"], "both field names; bad rows dropped");
  // without the Multipliers filter, only the market groups that offer Multipliers are kept
  const plain = parseMarkets(ACTIVE, { filtered: false });
  assert.ok(!plain.some((m) => m.symbol === "OTC_DJI"));
  const groups = groupMarkets(plain);
  assert.deepEqual(groups.map((g) => g.name), ["Synthetic indices", "Forex", "Commodities", "Crypto"]);
  assert.equal(isClosed(plain, "frxXAUUSD"), true);
  assert.equal(isClosed(plain, "frxEURUSD"), false);
  assert.equal(isClosed([{ ...plain[1], suspended: true }], "frxEURUSD"), true, "suspended counts as closed");
  assert.equal(isSynthetic(plain, "R_75"), true);
  assert.equal(isSynthetic(plain, "frxEURUSD"), false);
  assert.equal(marketName(plain, "frxEURUSD"), "EUR/USD");
  assert.equal(marketName([], "R_10"), "Volatility 10 Index", "the built-in names still work");
});

test("markets: without a list the built-in synthetic indices are used, and the current market stays listed", () => {
  assert.deepEqual(marketsOrFallback([], "R_75").map((m) => m.symbol), FALLBACK_MARKETS.map((m) => m.symbol));
  assert.equal(parseMarkets(undefined).length, 0);
  const list = marketsOrFallback(parseMarkets(ACTIVE.slice(1, 3)), "R_75");
  assert.ok(list.some((m) => m.symbol === "R_75"), "kept so the picker can show it");
  assert.equal(isClosed([], "R_75"), false);
});
