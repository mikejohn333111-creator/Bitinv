// The scanner (server/scanner.mjs): which markets it watches, when it asks Deriv (spaced out,
// never while an order is in flight, backing off when Deriv says to slow down), what each
// strategy's setup looks like, and how the list is sorted.
import test from "node:test";
import assert from "node:assert/strict";
import { Scanner, scanSeries, rankItems, pickMarkets, closedBoundary, cleanScannerSettings, loadScannerSettings, isRateLimit,
         SCANNER_DEFAULTS, SCAN_BARS, MAX_MARKETS } from "../server/scanner.mjs";
import { evaluateICT, ictMinBars, ictParamsFor } from "../public/js/strategy.js";

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const market = (symbol, market, extra = {}) => ({ symbol, name: symbol, market, marketName: market, submarket: "", open: true, suspended: false, order: 0, ...extra });
const MARKETS = [
  market("R_75", "synthetic_index"), market("R_100", "synthetic_index"),
  market("frxEURUSD", "forex", { submarket: "major_pairs", name: "EUR/USD" }), market("frxAUDCAD", "forex", { submarket: "minor_pairs" }),
  market("frxXAUUSD", "commodities", { submarket: "metals" }), market("OTC_NDX", "indices"),
  market("frxGBPUSD", "forex", { submarket: "major_pairs", open: false }), market("cryBTCUSD", "cryptocurrency", { suspended: true }),
];

// ICT bars (as in test/ict.test.mjs) on 15-minute candles: flat filler, sweep, structure shift, gap.
const T0 = 1767225600;   // 2026-01-01 00:00 UTC
const FLAT = [100, 100.5, 99.5, 100];
const SETUP = [[100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2], [98.2, 98.4, 96.5, 97.5], [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6], [101.6, 102.5, 101.2, 102.2], [102.2, 102.4, 101.6, 101.8]];
const ENTRY = [101.8, 101.9, 100.8, 101.0], HOLD = [101.8, 102, 101.6, 101.8];
const candles = (rows, tf = 900) => rows.map(([o, h, l, c], k) => ({ epoch: T0 + k * tf, open: String(o), high: String(h), low: String(l), close: String(c) }));
const ictRows = (tail) => [...Array(ictMinBars(ictParamsFor(900)) + 10).fill(FLAT), ...SETUP, ...tail];
const nowAfter = (rows, tf = 900) => (T0 + rows.length * tf) * 1000 - 1000;   // inside the forming candle

/** What the scanner reads from the engine, with a socket that answers ticks_history by hand. */
function fakeEngine({ markets = MARKETS, connection = "online" } = {}) {
  const e = {
    markets, marketsAt: 1, connection, busy: false, trading: false, syncing: false, model: null,
    settings: { strategy: "rules", aiThreshold: 0.55, aiBarrier: 3, aiHorizon: 60 },
    sent: [], answers: [], logged: [],
    logOnce(tag, title) { e.logged.push(title); },
    socket: {
      send(req) {
        e.sent.push(req);
        return new Promise((resolve, reject) => e.answers.push({ req, resolve, reject }));
      },
    },
  };
  return e;
}
const answer = (e, rows = [FLAT, FLAT]) => e.answers.shift().resolve({ msg_type: "candles", candles: candles(rows, e.sent.at(-1).granularity) });
const memStore = () => { const s = { saved: null, getScanner: () => s.saved || {}, saveScanner: (v) => { s.saved = JSON.parse(JSON.stringify(v)); } }; return s; };

// ---------------------------------------------------------------- settings
const ALL = { strategies: ["ict", "rules"] };
test("settings: on by default, real markets only, 15m and 1h, ICT and Rules; bad input is refused, odd saved values fall back", () => {
  assert.deepEqual({ ...SCANNER_DEFAULTS, timeframes: [...SCANNER_DEFAULTS.timeframes], strategies: [...SCANNER_DEFAULTS.strategies] },
                   { on: true, synthetics: false, timeframes: [900, 3600], ...ALL });
  assert.deepEqual(cleanScannerSettings({ synthetics: true, timeframes: ["3600"] }), { settings: { on: true, synthetics: true, timeframes: [3600], ...ALL }, errors: [] });
  assert.deepEqual(cleanScannerSettings({ strategies: ["ai", "ict", "ai"] }).settings.strategies, ["ict", "ai"], "in order, no repeats");
  assert.deepEqual(cleanScannerSettings({ timeframes: [3600, 900, 900] }).settings.timeframes, [900, 3600], "sorted, no repeats");
  for (const bad of [{ on: "yes" }, { synthetics: 1 }, { timeframes: [] }, { timeframes: [60] }, { timeframes: "900" }, { strategies: [] }, { strategies: ["magic"] }, { strategies: "ict" }])
    assert.equal(cleanScannerSettings(bad).errors.length, 1, JSON.stringify(bad));
  assert.equal(cleanScannerSettings(null).errors.length, 1);
  assert.deepEqual(cleanScannerSettings({ other: 1 }).settings, cleanScannerSettings({}).settings, "unknown keys are ignored");
  assert.deepEqual(loadScannerSettings({ on: false, synthetics: "x", timeframes: [60], strategies: ["x"] }), { on: false, synthetics: false, timeframes: [900, 3600], ...ALL });
  assert.deepEqual(loadScannerSettings(null), { on: true, synthetics: false, timeframes: [900, 3600], ...ALL });
});

// ----------------------------------------------------------------- markets
test("pickMarkets: open real markets first (forex majors, metals, indices, minors), synthetics only when asked, at most 20", () => {
  assert.deepEqual(pickMarkets(MARKETS).map((m) => m.symbol), ["frxEURUSD", "frxXAUUSD", "OTC_NDX", "frxAUDCAD"],
                   "closed, suspended and synthetic markets are left out");
  assert.deepEqual(pickMarkets(MARKETS, { synthetics: true }).map((m) => m.symbol).slice(-2), ["R_75", "R_100"], "synthetics last");
  const many = Array.from({ length: 30 }, (_, k) => market(`frxP${k}`, "forex", { submarket: "minor_pairs" }));
  assert.equal(pickMarkets([...many, market("frxEURUSD", "forex", { submarket: "major_pairs" })]).length, MAX_MARKETS);
  assert.equal(pickMarkets([...many, market("frxEURUSD", "forex", { submarket: "major_pairs" })])[0].symbol, "frxEURUSD");
  assert.deepEqual(pickMarkets([]), [], "the list hasn't loaded: no real markets known");
  assert.ok(pickMarkets([], { synthetics: true }).length > 0, "the built-in synthetic indices");
});

// -------------------------------------------------------------- scheduling
test("closedBoundary: the newest candle close, 30 seconds after it happened", () => {
  const h = 1767229200;   // 01:00 UTC
  assert.equal(closedBoundary((h + 29) * 1000, 900), h - 900, "not yet: Deriv may not have the candle");
  assert.equal(closedBoundary((h + 30) * 1000, 900), h);
  assert.equal(closedBoundary((h + 30) * 1000, 3600), h);
  assert.equal(closedBoundary((h + 900 + 30) * 1000, 3600), h, "the hour hasn't closed again");
  assert.ok(isRateLimit({ code: "RateLimit" }) && isRateLimit(new Error("Too many requests")) && !isRateLimit(new Error("Symbol is invalid.")));
});

test("Scanner: each closed candle queues every market once; one request at a time, at least the gap apart", async () => {
  const h = 1767229200, t = { now: (h + 40) * 1000 };
  const e = fakeEngine();
  const sc = new Scanner(e, { now: () => t.now, gapMs: 2000 });
  assert.equal(sc.step(), true);
  assert.equal(sc.queue.length, 7, "4 markets x 2 timeframes, one sent");
  assert.deepEqual(e.sent[0], { ticks_history: "frxEURUSD", style: "candles", granularity: 900, count: SCAN_BARS[900], end: "latest", adjust_start_time: 1 });
  assert.equal(sc.step(), false, "nothing while a request is in flight");
  answer(e); await flush();
  assert.equal(sc.step(), false, "the gap hasn't passed");
  t.now += 2000;
  e.busy = true;
  assert.equal(sc.step(), false, "the bot is placing an order: wait");
  e.busy = false; e.trading = true; e.syncing = true;
  assert.equal(sc.step(), false, "the bot is reloading its open trades: wait");
  e.syncing = false;
  sc.step(); await flush();
  assert.equal(e.sent.length, 2);
  answer(e); await flush();
  for (let i = 0; i < 6; i++) { t.now += 2000; sc.step(); await flush(); answer(e); await flush(); }
  assert.equal(e.sent.length, 8);
  assert.deepEqual(e.sent.map((r) => r.granularity), [900, 900, 900, 900, 3600, 3600, 3600, 3600]);
  assert.equal(sc.view().progress.done, 8);
  assert.equal(sc.view().scanning, false);
  assert.ok(sc.view().lastScanAt);

  t.now += 2000;
  assert.equal(sc.step(), false, "nothing new before the next candle closes");
  t.now = (h + 900 + 30) * 1000;
  sc.step();
  assert.deepEqual(sc.queue.map((j) => j.tf), [900, 900, 900], "a quarter hour: only 15m (one already sent)");
  assert.equal(e.sent.at(-1).granularity, 900);
  assert.equal(sc.view().nextScanAt, (h + 1800 + 30) * 1000);
});

test("Scanner: nothing is asked while offline, off, or before Deriv's market list loads", async () => {
  const t = { now: 1767229240000 };
  const e = fakeEngine({ connection: "connecting" });
  const sc = new Scanner(e, { now: () => t.now });
  sc.step();
  assert.equal(e.sent.length, 0);
  assert.match(sc.view().message, /Not connected/);
  e.connection = "online"; e.markets = []; e.marketsAt = t.now;
  sc.step();
  assert.equal(e.sent.length, 0, "the list is loading");
  t.now += 61000;
  sc.step();
  assert.equal(e.sent.length, 0, "it didn't load and synthetics are off: nothing to scan");
  assert.match(sc.view().message, /closed right now/);
  const off = new Scanner(fakeEngine(), { now: () => t.now, store: { getScanner: () => ({ on: false }) } });
  await off.step();
  assert.equal(off.engine.sent.length, 0);
  assert.match(off.view().message, /scanner is off/);
});

test("Scanner: Deriv's rate limit pauses it (longer each time) and the market is asked again after; other errors are shown", async () => {
  const t = { now: 1767229240000 };
  const e = fakeEngine({ markets: [MARKETS[2], MARKETS[4]] });
  const sc = new Scanner(e, { now: () => t.now, gapMs: 1000, store: { getScanner: () => ({ timeframes: [900] }) } });
  sc.step(); await flush();
  e.answers.shift().reject(Object.assign(new Error("You have reached the rate limit"), { code: "RateLimit" }));
  await flush();
  assert.equal(sc.pausedUntil, t.now + 60000);
  assert.deepEqual(sc.queue.map((j) => j.symbol), ["frxEURUSD", "frxXAUUSD"], "back at the front");
  assert.deepEqual(e.logged, ["Scanner paused: Deriv asked to slow down"]);
  assert.match(sc.view().message, /slow down/);
  t.now += 59000;
  assert.equal(sc.step(), false, "still paused");
  t.now += 1000;
  sc.step(); await flush();
  e.answers.shift().reject(Object.assign(new Error("rate limit"), { code: "RateLimit" }));
  await flush();
  assert.equal(sc.pausedUntil, t.now + 120000, "twice as long");
  t.now += 120000;
  sc.step(); await flush();
  answer(e); await flush();
  assert.equal(sc.backoff, 0, "an answer resets it");
  t.now += 1000;
  sc.step(); await flush();
  e.answers.shift().reject(new Error("request timed out"));
  await flush();
  assert.equal(sc.queue[0].tries, 1, "a lost answer: asked again a little later");
  t.now += 5000;
  sc.step(); await flush();
  e.answers.shift().reject(Object.assign(new Error("Symbol is invalid."), { code: "InvalidSymbol" }));
  await flush();
  assert.equal(sc.queue.length, 0);
  assert.equal(sc.view().failed, 1);
  assert.equal(e.sent.length, 5);
});

test("Scanner: Scan now queues everything, then waits out its cooldown; settings are saved and scan what is new", async () => {
  const t = { now: 1767229240000 };
  const e = fakeEngine(), store = memStore();
  const sc = new Scanner(e, { now: () => t.now, store, cooldownMs: 120000 });
  const v = sc.scanNow();
  assert.equal(v.progress.total, 8);
  assert.equal(v.scanning, true);
  assert.throws(() => sc.scanNow(), (err) => err.status === 429 && /2 min/.test(err.message));
  t.now += 120000;
  assert.equal(sc.queue.length, 8, "already queued markets aren't queued twice");
  sc.scanNow();
  assert.equal(sc.queue.length, 8);

  sc.updateSettings({ on: false, synthetics: false, timeframes: [900, 3600] });
  assert.equal(sc.queue.length, 0, "off: the queue is dropped");
  assert.deepEqual(store.saved, { on: false, synthetics: false, timeframes: [900, 3600], ...ALL });
  assert.throws(() => sc.scanNow(), (err) => err.status === 409 && err.code === "scanner_off");
  sc.updateSettings({ on: true, synthetics: true, timeframes: [3600] });
  sc.step();
  assert.equal(sc.queue.length + e.sent.length, 6, "on again: 6 markets with the synthetics, 1h only");
  assert.deepEqual(new Scanner(e, { store }).settings, { on: true, synthetics: true, timeframes: [3600], ...ALL }, "loaded after a restart");
  e.connection = "offline";
  t.now += 200000;
  assert.throws(() => sc.scanNow(), (err) => err.code === "not_connected");
});

// --------------------------------------------------------------- evaluation
test("scanSeries: an ICT entry on the last closed candle, with the stop and target the bot would use", () => {
  const rows = ictRows([ENTRY, HOLD]);
  const nowMs = nowAfter(rows);
  const { items } = scanSeries({ symbol: "R_100", name: "Volatility 100 Index", tf: 900, candles: candles(rows), synthetic: true, nowMs });
  const ict = items.find((i) => i.strategy === "ict");
  assert.ok(ict, JSON.stringify(items));
  const closed = rows.slice(0, -1).map(([o, h, l, c], k) => ({ epoch: T0 + k * 900, open: o, high: h, low: l, close: c }));
  const res = evaluateICT(closed, ictParamsFor(900, { real: false }));
  assert.equal(res.action, "BUY");
  assert.equal(ict.status, "ready");
  assert.equal(ict.side, "BUY");
  assert.equal(ict.entry, 101);
  assert.ok(Math.abs(ict.sl - (101 - res.slDist)) < 1e-6 && Math.abs(ict.tp - (101 + res.tpDist)) < 1e-6, "as handleSignal: entry -/+ the distances");
  assert.equal(ict.rr, 2);
  assert.equal(ict.start, closed.at(-1).epoch);
  assert.equal(ict.end, closed.at(-1).epoch + 31 * 900, "the 30-candle time limit");
  assert.equal(ict.at, (closed.at(-1).epoch + 900) * 1000, "when that candle closed");
  assert.match(ict.reason, /Swept the low/);
  assert.equal(ict.name, "Volatility 100 Index");
});

test("scanSeries: an ICT plan waiting for price, dropped once price has gone through it", () => {
  const rows = ictRows([HOLD, HOLD]);
  const nowMs = nowAfter(rows);
  const { items } = scanSeries({ symbol: "R_50", tf: 900, candles: candles(rows), synthetic: true, nowMs });
  const w = items.find((i) => i.status === "waiting");
  assert.ok(w, JSON.stringify(items));
  assert.equal(w.side, "BUY");
  assert.deepEqual(w.zone, [99, 101.2]);
  assert.equal(w.entry, 101.2, "price reaches the top of the gap first");
  assert.ok(w.sl < 96.5 && w.tp > 101.2);
  assert.ok(Math.abs(w.rr - (w.tp - 101.2) / (101.2 - w.sl)) < 1e-6);
  assert.equal(w.inZone, false);
  assert.match(w.reason, /Waiting for price to come back/);
  assert.ok(w.end > nowMs / 1000, "expires later");
  // the forming candle has fallen below the sweep low: the setup is gone
  const broken = [...rows.slice(0, -1), [101.8, 101.8, 95, 95]];
  assert.equal(scanSeries({ symbol: "R_50", tf: 900, candles: candles(broken), synthetic: true, nowMs }).items.filter((i) => i.status === "waiting").length, 0);
  // inside the gap now
  const inside = [...rows.slice(0, -1), [101.8, 101.8, 100.5, 100.5]];
  assert.equal(scanSeries({ symbol: "R_50", tf: 900, candles: candles(inside), synthetic: true, nowMs }).items.find((i) => i.status === "waiting").inZone, true);
  // too few candles: nothing
  assert.deepEqual(scanSeries({ symbol: "R_50", tf: 900, candles: candles(rows.slice(-30)), nowMs }).items, []);
});

test("scanSeries: real markets use ICT's real-market filters (kill zones on 15m)", () => {
  const rows = ictRows([ENTRY, HOLD]);
  const outside = (T0 + (rows.length - 2) * 900) % 86400 / 3600;   // the hour (UTC) of the last closed candle
  const real = scanSeries({ symbol: "frxEURUSD", tf: 900, candles: candles(rows), synthetic: false, nowMs: nowAfter(rows) });
  const inKill = [[7, 10], [12, 15]].some(([a, b]) => Math.floor(outside) >= a && Math.floor(outside) < b);
  assert.equal(real.items.some((i) => i.strategy === "ict"), inKill, `last candle at ${outside}h UTC`);
});

// ------------------------------------------------------------------ ranking
test("rankItems: ready first, then the freshest, then the most agreement; agreement is plain words, not a probability", () => {
  const it = (o) => ({ symbol: "A", name: o.symbol || "A", tf: 900, strategy: "ict", side: "BUY", status: "ready", at: 600000, ...o });
  const items = [
    it({ id: "wait", status: "waiting", at: 900000 }),
    it({ id: "old", symbol: "B", name: "B", at: 60000 }),
    it({ id: "lone", symbol: "C", name: "C" }),
    it({ id: "agreed", symbol: "D", name: "D", tf: 3600 }),
    it({ id: "rules", symbol: "D", name: "D", strategy: "rules" }),
    it({ id: "against", symbol: "D", name: "D", strategy: "ai", side: "SELL", at: 600000 }),
  ];
  const trends = new Map([["D:3600", "up"], ["C:900", "down"]]);
  const out = rankItems(items, trends);
  assert.deepEqual(out.map((i) => i.id), ["agreed", "rules", "lone", "against", "old", "wait"]);
  const agreed = out.find((i) => i.id === "agreed");
  assert.deepEqual(agreed.agree, ["4h trend is up", "Rules 15m"]);
  assert.deepEqual(agreed.against, ["AI model 15m"]);
  assert.equal(agreed.score, 1);
  assert.deepEqual(out.find((i) => i.id === "lone").against, ["4h trend is down"]);
  for (const i of out) assert.ok(!("confidence" in i) && !("probability" in i));
});

test("view: only markets and timeframes still watched, no expired setups, at most 40, small", async () => {
  const t = { now: 1767229240000 };
  const e = fakeEngine();
  const sc = new Scanner(e, { now: () => t.now });
  const item = (o) => ({ symbol: "frxEURUSD", name: "EUR/USD", tf: 900, strategy: "rules", side: "BUY", status: "ready", entry: 1, sl: 0.9, tp: 1.2, rr: 2,
                         at: t.now, validUntil: t.now + 1000, reason: "", start: 0, end: null, ...o });
  sc.series.set("frxEURUSD:900", { items: [item({ id: "a" }), item({ id: "gone", validUntil: t.now - 1 }), item({ id: "ai", strategy: "ai", side: "SELL" })], trend: "up", error: "" });
  sc.series.set("R_75:900", { items: [item({ id: "synthetic", symbol: "R_75" })], trend: null, error: "" });
  sc.series.set("frxEURUSD:3600", { items: [item({ id: "hourly", tf: 3600 })], trend: null, error: "" });
  sc.settings.timeframes = [900];
  const v = sc.view();
  assert.deepEqual(v.items.map((i) => i.id), ["a"]);
  assert.equal(v.items[0].validUntil, undefined, "internal fields stay on the server");
  assert.deepEqual(v.items[0].agree, ["4h trend is up"]);
  assert.deepEqual(v.items[0].against, [], "a strategy not picked neither shows nor counts against");
  sc.settings.strategies = ["rules", "ai"];
  assert.deepEqual(sc.view().items.map((i) => [i.id, i.against]), [["a", ["AI model 15m"]], ["ai", ["4h trend is up", "Rules 15m"]]]);
  sc.settings.strategies = ["ict", "rules"];
  assert.equal(v.markets, 4);
  assert.equal(typeof v.now, "number");
  sc.series.set("frxEURUSD:900", { items: Array.from({ length: 60 }, (_, k) => item({ id: `x${k}` })), trend: null, error: "" });
  assert.equal(sc.view().items.length, 40);
  assert.ok(JSON.stringify(sc.view()).length < 20000);
});
