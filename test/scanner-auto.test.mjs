// Scanner auto-trade (server/engine.mjs autoScan, server/scanner.mjs staleReason): demo only,
// the caps (per day, open at once, one per market), each setup taken once (also after a
// restart), fresh setups only, the order on the setup's own market, and the Scanner hook.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingEngine, cleanSettings, DEFAULT_SETTINGS, UserError } from "../server/engine.mjs";
import { Scanner, scanSeries, staleReason, FRESH_R } from "../server/scanner.mjs";
import { FileStore } from "../server/store.mjs";
import { ictMinBars, ictParamsFor } from "../public/js/strategy.js";

const PAT = "pat_test_TOKEN_abcd1234";
const DEMO = { account_id: "DOT1", account_type: "demo", currency: "USD", balance: 10000, status: "active" };
const REAL = { account_id: "ROT1", account_type: "real", currency: "USD", balance: 500, status: "active" };
const NOW = Date.UTC(2026, 9, 2, 10, 5);   // 10:05 UTC: the 9:45 15m candle closed at 10:00
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------------ fakes (as in server-engine.test.mjs)
class FakeSocket {
  constructor(urlProvider, handlers, responder) { Object.assign(this, { urlProvider, h: handlers, responder, sent: [], streams: [], online: false, closed: false }); }
  async connect() {
    try { this.url = await this.urlProvider(); } catch (e) { this.h.onStatus("offline"); this.h.onError(e); return; }
    if (this.closed) return;
    this.online = true;
    this.h.onStatus("online");
  }
  send(req) {
    this.sent.push(req);
    if (!this.online) return Promise.reject(new Error("not connected"));
    return Promise.resolve().then(() => this.responder(req, this));
  }
  subscribe(req, onMessage) { const s = { req, onMessage, active: true }; this.streams.push(s); return { unsubscribe: () => { s.active = false; } }; }
  push(match, msg) { for (const s of this.streams) if (s.active && match(s.req)) s.onMessage(msg); }
  close() { this.closed = true; this.online = false; }
}

function responder(over = {}, portfolio = []) {
  let next = 9000;
  return (req, sock) => {
    for (const [k, fn] of Object.entries(over)) if (req[k] !== undefined) return fn(req, sock);
    if (req.contracts_for) return { contracts_for: { available: [
      { contract_type: "MULTUP", contract_category: "multiplier", multiplier_range: req.contracts_for === "R_75" ? [100, 200] : [300, 50, 100], min_stake: 1, max_stake: 2000 }] } };
    if (req.portfolio) return { portfolio: { contracts: portfolio } };
    if (req.proposal) return { proposal: { id: `prop${next}`, ask_price: req.amount, commission: 0.25, spot: 1000.5 } };
    if (req.buy) return { buy: { contract_id: next++, buy_price: req.price } };
    return {};
  };
}

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function stubDeriv(accounts) {
  globalThis.fetch = async (url) => (/\/otp$/.test(url) ? jsonRes(200, { data: { url: "wss://fake.example/otp" } }) : jsonRes(200, { data: accounts }));
}

function makeEngine(dir, { over = {}, accounts = [DEMO, REAL], portfolio = [], t = { now: NOW } } = {}) {
  stubDeriv(accounts);
  const sockets = [];
  const engine = new TradingEngine({
    cfg: { apiUrl: "https://api.example", publicWs: "wss://public.example" }, store: new FileStore(dir), now: () => t.now,
    socketFactory: (u, h) => { const s = new FakeSocket(u, h, responder(over, portfolio)); sockets.push(s); return s; },
  });
  return { engine, dir, t, get sock() { return sockets.at(-1); } };
}

async function setup({ settings = {}, state, ...o } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tbot-scanauto-"));
  const store = new FileStore(dir);
  store.saveSettings({ strategy: "rules", mode: "auto", scanAuto: true, ...settings });
  if (state) store.saveState(state);
  store.saveSecret({ appId: "app42", token: PAT });
  const ctx = makeEngine(dir, o);
  await ctx.engine.init();
  await flush();
  ctx.cleanup = () => { ctx.engine.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return ctx;
}

const sentOf = (sock, key) => sock.sent.filter((r) => r[key] !== undefined);
const logged = (engine, re) => engine.logs.filter((e) => re.test(e.title + " " + e.detail));
const CLOSED = Math.floor(NOW / 1000 / 900) * 900 - 900;   // the newest closed 15m candle opened at 9:45
/** A "Ready now" setup as the scanner gives it: BUY at 1000, stop 990, target 1020. */
const setup1 = (o = {}) => {
  const it = { symbol: "R_100", name: "Volatility 100 Index", tf: 900, strategy: "ict", side: "BUY", status: "ready", at: NOW - 240000,
               entry: 1000, sl: 990, tp: 1020, slDist: 10, tpDist: 20, price: 1001, horizonBars: 0, rr: 2, reason: "Swept the low", start: CLOSED, ...o };
  return { ...it, id: o.id || `${it.symbol}:${it.tf}:${it.strategy}:${it.side}:${it.start}` };
};

// ------------------------------------------------------------------ pure parts
test("staleReason: only ready setups from the newest closed candle, with price still inside the plan", () => {
  assert.equal(staleReason(setup1(), NOW), "");
  assert.equal(staleReason(setup1({ price: 1000 - FRESH_R * 10 }), NOW), "", "0.25R against: still fine");
  assert.equal(staleReason(setup1({ price: 1000 + FRESH_R * 10 }), NOW), "", "0.25R beyond: still fine");
  assert.match(staleReason(setup1({ price: 1003 }), NOW), /more than 0.25R/);
  assert.match(staleReason(setup1({ price: 989 }), NOW), /past its stop loss/);
  assert.match(staleReason(setup1({ price: 1021 }), NOW), /past its take profit/);
  assert.match(staleReason(setup1({ side: "SELL", sl: 1010, tp: 980, price: 1011 }), NOW), /past its stop loss/);
  assert.equal(staleReason(setup1({ side: "SELL", sl: 1010, tp: 980, price: 999 }), NOW), "");
  assert.match(staleReason(setup1({ start: CLOSED - 900 }), NOW), /newer candle/);
  assert.match(staleReason(setup1({ tf: 3600, start: Math.floor(NOW / 3600000) * 3600 - 7200 }), NOW), /newer candle/);
  assert.equal(staleReason(setup1({ tf: 3600, start: Math.floor(NOW / 3600000) * 3600 - 3600 }), NOW), "");
  assert.match(staleReason(setup1({ status: "waiting" }), NOW), /waiting for price/);
  assert.match(staleReason(setup1({ price: null }), NOW), /no price/);
});

test("the scanner's ready setups carry what an order needs: id, side, entry, stop and target distances, the price now", () => {
  const FLAT = [100, 100.5, 99.5, 100];
  const SETUP = [[100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
    [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2], [98.2, 98.4, 96.5, 97.5], [97.5, 99, 97.3, 98.8],
    [98.8, 101.8, 98.7, 101.6], [101.6, 102.5, 101.2, 102.2], [102.2, 102.4, 101.6, 101.8]];
  const rows = [...Array(ictMinBars(ictParamsFor(900)) + 10).fill(FLAT), ...SETUP, [101.8, 101.9, 100.8, 101.0], [101.8, 102, 101.6, 101.8]];
  const T0 = 1767225600, nowMs = (T0 + rows.length * 900) * 1000 - 1000;
  const { items } = scanSeries({ symbol: "R_100", tf: 900, synthetic: true, nowMs,
    candles: rows.map(([o, h, l, c], k) => ({ epoch: T0 + k * 900, open: o, high: h, low: l, close: c })) });
  const it = items.find((i) => i.status === "ready" && i.strategy === "ict");
  assert.ok(it);
  assert.equal(it.id, `R_100:900:ict:BUY:${T0 + (rows.length - 2) * 900}`);
  assert.equal(it.price, 101.8, "the forming candle's close");
  assert.ok(Math.abs(it.entry - it.slDist - it.sl) < 1e-6 && Math.abs(it.entry + it.tpDist - it.tp) < 1e-6 && it.slDist > 0, JSON.stringify(it));
  assert.equal(typeof it.horizonBars, "number");
  assert.equal(staleReason(it, nowMs), "", "0.8 of a 4.65 stop away from the entry: fresh");
});

test("settings: off by default, ICT and Rules on 15m and 1h, 4 a day, 2 open; bad values refused, numbers clamped", () => {
  assert.equal(DEFAULT_SETTINGS.scanAuto, false);
  assert.deepEqual([DEFAULT_SETTINGS.scanAutoStrategies, DEFAULT_SETTINGS.scanAutoTfs, DEFAULT_SETTINGS.scanAutoMaxDay, DEFAULT_SETTINGS.scanAutoMaxOpen],
                   [["ict", "rules"], [900, 3600], 4, 2]);
  assert.deepEqual(cleanSettings({ scanAuto: true, scanAutoStrategies: ["rules", "ai", "rules"], scanAutoTfs: ["3600"], scanAutoMaxDay: 99, scanAutoMaxOpen: 0 }),
                   { settings: { scanAuto: true, scanAutoStrategies: ["rules", "ai"], scanAutoTfs: [3600], scanAutoMaxDay: 10, scanAutoMaxOpen: 1 }, errors: [] });
  for (const bad of [{ scanAuto: "on" }, { scanAutoStrategies: [] }, { scanAutoStrategies: ["magic"] }, { scanAutoStrategies: "ict" },
                     { scanAutoTfs: [60] }, { scanAutoTfs: [] }, { scanAutoMaxDay: "x" }])
    assert.equal(cleanSettings(bad).errors.length, 1, JSON.stringify(bad));
});

// ------------------------------------------------------------------ demo only
test("demo only: not turned on, not started, and no order on a real account; the status says so", async () => {
  const ctx = await setup({ settings: { scanAuto: false, allowReal: true }, state: { accountId: "ROT1" } });
  const { engine, sock } = ctx;
  try {
    assert.equal(engine.account.type, "real");
    assert.throws(() => engine.updateSettings({ scanAuto: true }), (e) => e instanceof UserError && e.code === "scanner_demo_only" && e.status === 403 && /demo only/.test(e.message));
    assert.equal(engine.settings.scanAuto, false);
    assert.equal(logged(engine, /^Scanner auto-trade was not turned on: it is demo only/).length, 1);
    // Saved on before (e.g. set while on demo, then the account changed): Start is refused.
    engine.settings.scanAuto = true;
    assert.equal(engine.status().scanAutoBlocked, true);
    assert.equal(engine.status().scanAuto.blocked, true);
    assert.throws(() => engine.start(), (e) => e.code === "scanner_demo_only");
    assert.equal(engine.running, false);
    assert.equal(logged(engine, /^Did not start: scanner auto-trade is demo only/).length, 1);
    // Running anyway (resumed after a restart): every setup is refused, with one log line.
    engine.running = true;
    engine.autoScan([setup1()]);
    engine.autoScan([setup1({ symbol: "R_50" })]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0, "no order on the real account");
    assert.equal(logged(engine, /^Scanner auto-trade placed no trade: it is demo only/).length, 1);
    // Turning it off still works on the real account.
    engine.running = false;
    engine.updateSettings({ scanAuto: false });
    assert.equal(engine.settings.scanAuto, false);
  } finally { ctx.cleanup(); }
});

// ------------------------------------------------------------------ orders
test("a ready setup is traded on its own market with the bot's sizing, tagged as the scanner's, and counted", async () => {
  const ctx = await setup();
  const { engine, sock } = ctx;
  try {
    engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0, "the bot is stopped: nothing");
    engine.start();
    engine.autoScan([setup1()]);
    await flush();
    assert.deepEqual(sentOf(sock, "contracts_for").map((r) => r.contracts_for), ["R_75", "R_100"], "the setup's market's Multipliers");
    const [p] = sentOf(sock, "proposal");
    assert.equal(p.underlying_symbol, "R_100", "not the bot's market (R_75)");
    assert.equal(p.contract_type, "MULTUP");
    assert.equal(p.multiplier, 50, "the lowest offered on R_100");
    // 1% of 10,000 at a stop 10 away from 1001 with x50: stake 200.2, risk 100, target 200
    assert.equal(p.amount, 200.2);
    assert.deepEqual(p.limit_order, { stop_loss: 100, take_profit: 200 });
    assert.equal(sentOf(sock, "buy").length, 1);
    const st = engine.status();
    assert.equal(st.open.length, 1);
    assert.deepEqual({ ...st.open[0], plan: undefined, opened: undefined },
      { id: "9000", side: "BUY", symbol: "R_100", stake: 200.2, profit: 0, opened: undefined, horizon: 0, barSec: 900, closing: false, plan: undefined,
        source: "scanner", scan: { strategy: "ict", tf: 900, name: "Volatility 100 Index" } });
    assert.equal(st.tradesToday, 1, "the risk guard counts it");
    assert.deepEqual({ ...st.scanAuto }, { on: true, demoOnly: true, blocked: false, today: 1, maxDay: 4, open: 1, maxOpen: 2,
                                           strategies: ["ict", "rules"], timeframes: [900, 3600], waiting: "" });
    assert.equal(engine.scanTraded(setup1().id), true);
    assert.equal(logged(engine, /^Opened BUY R_100 from the scanner \(ICT 15m Volatility 100 Index\)/).length, 1);
    assert.equal(st.blockReason, "", "the bot's own open-trade limit doesn't count scanner trades");

    // the same setup again: never twice
    engine.autoScan([setup1()]);
    // another setup on the same market (1h): one trade per market
    engine.autoScan([setup1({ tf: 3600, start: Math.floor(NOW / 3600000) * 3600 - 3600 })]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.equal(logged(engine, /^Scanner setup not taken: BUY ICT 1h Volatility 100 Index.*A trade on Volatility 100 Index is open already/).length, 1);
  } finally { ctx.cleanup(); }
});

test("caps: open at once, per day, strategies and timeframes picked, the risk guard; best ranked first; skips logged once", async () => {
  const ctx = await setup({ settings: { scanAutoMaxDay: 3 } });
  const { engine, sock } = ctx;
  try {
    engine.start();
    const rules = setup1({ symbol: "frxEURUSD", name: "EUR/USD", strategy: "rules" });
    const ai = setup1({ symbol: "R_10", strategy: "ai" }), hour = setup1({ symbol: "R_25", tf: 60 });
    engine.autoScan([ai, hour, rules, setup1()]);
    await flush();
    assert.deepEqual(sentOf(sock, "proposal").map((p) => p.underlying_symbol), ["frxEURUSD"], "AI and other timeframes are not picked: the next best");
    assert.equal(logged(engine, /not taken/).length, 0, "not picked: quiet");
    engine.autoScan([ai, hour, rules, setup1()]);
    await flush();
    assert.deepEqual(sentOf(sock, "proposal").map((p) => p.underlying_symbol), ["frxEURUSD", "R_100"]);
    // two open: the third waits, and says why once
    const third = setup1({ symbol: "R_50", name: "Volatility 50 Index" });
    engine.autoScan([third]); engine.autoScan([third]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 2);
    assert.equal(logged(engine, /^Scanner setup not taken: BUY ICT 15m Volatility 50 Index.*2 scanner trades open already/).length, 1);
    assert.match(engine.status().scanAuto.waiting, /2 scanner trades open/);
    // one closes: the third is taken (3 of 3 today), then the day is full
    sock.push((r) => r.contract_id === 9000, { msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 9000, contract_type: "MULTUP", buy_price: 200, profit: 5, is_sold: 1, status: "won" } });
    engine.autoScan([third]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 3);
    assert.equal(engine.status().scanAuto.today, 3);
    sock.push((r) => r.contract_id === 9001, { msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 9001, contract_type: "MULTUP", buy_price: 200, profit: 5, is_sold: 1, status: "won" } });
    engine.autoScan([setup1({ symbol: "R_25" })]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 3);
    assert.equal(logged(engine, /3 scanner trades today already/).length, 1);
    // a new UTC day: the count starts again, but the risk guard's daily loss halt stops everything
    ctx.t.now += 24 * 3600e3;
    engine.guard.state.halted = true; engine.guard.state.haltReason = "daily loss limit hit (-3.10%)";
    const tomorrow = setup1({ symbol: "R_25", start: Math.floor(ctx.t.now / 900000) * 900 - 900 });
    engine.autoScan([tomorrow]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 3);
    assert.equal(engine.status().scanAuto.today, 0);
    assert.equal(logged(engine, /not taken.*daily loss limit hit/i).length, 1);
    engine.guard.state.halted = false;
    engine.guard.state.cooldownUntil = ctx.t.now + 60000;
    const later = setup1({ symbol: "R_10", start: tomorrow.start });
    engine.autoScan([later]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 3, "the losing-streak pause stops it too");
  } finally { ctx.cleanup(); }
});

test("freshness and price: stale setups are skipped (logged once), and so is a quote already past the stop", async () => {
  const ctx = await setup({ over: { proposal: (req) => ({ proposal: { id: "p1", ask_price: req.amount, spot: 989.5 } }) } });
  const { engine, sock } = ctx;
  try {
    engine.start();
    const old = setup1({ start: CLOSED - 900 }), far = setup1({ symbol: "R_50", price: 1004 });
    engine.autoScan([old, far]); engine.autoScan([old, far]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0);
    assert.equal(logged(engine, /not taken.*A newer candle has closed/).length, 1);
    assert.equal(logged(engine, /not taken.*Price moved more than 0.25R/).length, 1);
    engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.equal(sentOf(sock, "buy").length, 0, "Deriv's price is below the stop: no buy");
    assert.equal(logged(engine, /^Skipped BUY R_100.*already past the setup's stop loss/).length, 1);
    engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1, "tried once only");
    assert.equal(engine.status().scanAuto.today, 0, "nothing traded");
  } finally { ctx.cleanup(); }
});

test("signals only mode and a stopped bot take nothing; the bot's own market and mode don't matter otherwise", async () => {
  const ctx = await setup({ settings: { mode: "signals", symbol: "frxEURUSD" } });
  const { engine, sock } = ctx;
  try {
    engine.start();
    engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0);
    assert.match(engine.status().scanAuto.waiting, /Signals only/);
    engine.stop();
    engine.updateSettings({ mode: "auto" });
    engine.start();
    engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(sock, "proposal")[0].underlying_symbol, "R_100");
  } finally { ctx.cleanup(); }
});

test("after a restart: setups taken and today's count are kept, and the open scanner trade is followed with its tag", async () => {
  const ctx = await setup();
  try {
    ctx.engine.start();
    ctx.engine.autoScan([setup1()]);
    await flush();
    assert.equal(ctx.engine.status().open.length, 1);
    ctx.engine.shutdown();
    // the server comes back: Deriv still lists the trade
    const again = makeEngine(ctx.dir, { portfolio: [{ contract_id: 9000, contract_type: "MULTUP", underlying_symbol: "R_100" }] });
    await again.engine.init();
    await flush();
    const st = again.engine.status();
    assert.equal(st.running, true, "resumed");
    assert.equal(st.open.length, 1);
    assert.equal(st.open[0].source, "scanner");
    assert.deepEqual(st.open[0].scan, { strategy: "ict", tf: 900, name: "Volatility 100 Index" });
    assert.equal(st.scanAuto.today, 1);
    assert.equal(again.engine.scanTraded(setup1().id), true);
    again.engine.autoScan([setup1()]);
    await flush();
    assert.equal(sentOf(again.sock, "proposal").length, 0, "not taken twice after a restart");
    again.engine.shutdown();
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("Scanner: after a finished scan it hands the engine its ready setups, best first, and marks traded ones", async () => {
  const calls = [];
  const engine = { markets: [], marketsAt: 1, connection: "online", socket: {}, model: null, settings: {},
                   autoScan: (items) => calls.push(items.map((i) => i.id)), scanTraded: (id) => id === "b", scanAutoView: () => ({ on: true, today: 1, maxDay: 4 }) };
  const t = { now: NOW };
  const sc = new Scanner(engine, { now: () => t.now, store: { getScanner: () => ({ synthetics: true }) } });
  const item = (id, o) => ({ id, symbol: o.symbol, name: o.symbol, tf: 900, strategy: "ict", side: "BUY", status: "ready", at: NOW, validUntil: NOW + 600000, ...o });
  sc.series.set("R_100:900", { at: NOW, trend: null, error: "", items: [item("a", { symbol: "R_100" })] });
  sc.series.set("R_50:900", { at: NOW, trend: null, error: "", items: [item("b", { symbol: "R_50", at: NOW + 60000 }), item("w", { symbol: "R_50", status: "waiting" })] });
  sc.done.set(900, 1e12); sc.done.set(3600, 1e12);   // nothing due
  sc.step();
  assert.deepEqual(calls, [["b", "a"]], "ready only, the freshest first");
  sc.inflight = true;
  sc.step();
  assert.equal(calls.length, 1, "not while a scan is running");
  const v = sc.view();
  assert.deepEqual(v.auto, { on: true, today: 1, maxDay: 4 });
  assert.deepEqual(v.items.map((i) => [i.id, i.traded]), [["b", true], ["a", false], ["w", false]]);
});
