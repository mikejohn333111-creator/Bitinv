// The server's trading engine with a fake Deriv socket, a fake clock and a stubbed REST API.
// The bot is scanner-only: every trade comes from a scanner setup (engine.autoScan), and a
// 1-minute stream of R_75 is its clock (time exits, the daily loss check, the watchdog).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingEngine, cleanSettings, loadSettings, DEFAULT_SETTINGS, SETTINGS_VERSION, CLOCK_SYMBOL, UserError } from "../server/engine.mjs";
import { Scanner } from "../server/scanner.mjs";
import { FileStore, LOG_MAX_LINES } from "../server/store.mjs";

const PAT = "pat_test_TOKEN_abcd1234";
const DEMO = { account_id: "DOT1", account_type: "demo", currency: "USD", balance: 10000, status: "active" };
const REAL = { account_id: "ROT1", account_type: "real", currency: "USD", balance: 500, status: "active" };
const NOW = Date.UTC(2026, 9, 2, 10);   // 10:00 UTC: the 9:45 15m candle has just closed
const NOW_S = NOW / 1000;
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------------ fakes
class FakeSocket {
  constructor(urlProvider, handlers, responder) {
    Object.assign(this, { urlProvider, h: handlers, responder, sent: [], streams: [], online: false, closed: false });
  }
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
  subscribe(req, onMessage) {
    const s = { req, onMessage, active: true };
    this.streams.push(s);
    return { unsubscribe: () => { s.active = false; } };
  }
  push(match, msg) { for (const s of this.streams) if (s.active && match(s.req)) s.onMessage(msg); }
  drop() { this.online = false; this.h.onStatus("offline"); }
  close() { this.closed = true; this.online = false; }
}

function responder(over = {}) {
  let next = 9000;
  return (req, sock) => {
    for (const [k, fn] of Object.entries(over)) if (req[k] !== undefined) return fn(req, sock);
    if (req.contracts_for) return { contracts_for: { available: [
      { contract_type: "MULTUP", contract_category: "multiplier", multiplier_range: [100, 50, 200], min_stake: 1, max_stake: 2000 }] } };
    if (req.portfolio) return { portfolio: { contracts: [] } };
    if (req.proposal) return { proposal: { id: `prop${next}`, ask_price: req.amount, commission: 0.25 } };
    if (req.buy) return { buy: { contract_id: next++, buy_price: req.price } };
    if (req.sell) return { sell: { sold_for: 1 } };
    return {};
  };
}

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function stubDeriv(state = {}) {
  state.calls = [];
  state.accounts ??= [DEMO, REAL];
  globalThis.fetch = async (url, opts = {}) => {
    state.calls.push({ url: String(url), opts });
    if (state.status && state.status !== 200) return jsonRes(state.status, { errors: [{ code: "InvalidToken", message: "Invalid or expired token" }] });
    if (state.otpStatus && /\/otp$/.test(url)) return jsonRes(state.otpStatus, { errors: [{ code: "InvalidToken", message: "Invalid or expired token" }] });
    if (state.offline) throw new TypeError("fetch failed");
    if (/\/otp$/.test(url)) return jsonRes(200, { data: { url: "wss://fake.example/otp" } });
    return jsonRes(200, { data: state.accounts });
  };
  return state;
}

function setup({ settings = {}, rawSettings, state, secret = true, over = {}, deriv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tbot-engine-"));
  const store = new FileStore(dir);
  // The fake balance doesn't drop by the stake, so the 1% profit target is off unless a test sets it.
  store.saveSettings(rawSettings || { v: SETTINGS_VERSION, mode: "auto", dailyProfitPct: 0, ...settings });
  if (state) store.saveState(state);
  if (secret) store.saveSecret({ appId: "app42", token: PAT });
  return makeEngine(dir, { over, deriv });
}

function makeEngine(dir, { over = {}, deriv = {}, clock } = {}) {
  const t = clock || { now: NOW };
  const sockets = [];
  const rest = stubDeriv(deriv);
  const store = new FileStore(dir);
  const printed = [];
  const engine = new TradingEngine({
    cfg: { apiUrl: "https://api.example", publicWs: "wss://public.example" }, store, now: () => t.now,
    log: (e) => printed.push(e),
    socketFactory: (urlProvider, handlers) => { const s = new FakeSocket(urlProvider, handlers, responder(over)); sockets.push(s); return s; },
  });
  return { engine, dir, store, t, rest, printed, sockets, get sock() { return sockets.at(-1); },
           cleanup: () => { engine.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

const isHistory = (r) => r.ticks_history !== undefined;
/** A clock candle opening at `epoch` (seconds): it closes the one before. */
function clock(sock, epoch, close = 100) {
  sock.push(isHistory, { msg_type: "ohlc", ohlc: { open_time: epoch, open: String(close), high: String(close + 1), low: String(close - 1), close: String(close) } });
}
/** The clock's minutes from `from` to `to` (seconds), one candle each. */
function clockRun(sock, from, to) { for (let e = from; e <= to; e += 60) clock(sock, e); }
const sentOf = (sock, key) => sock.sent.filter((r) => r[key] !== undefined);
const logged = (engine, re) => engine.logs.filter((e) => re.test(e.title));

async function ready(ctx) {
  await ctx.engine.init();
  await flush();
  return ctx;
}

const CLOSED = Math.floor(NOW_S / 900) * 900 - 900;   // the newest closed 15m candle opened at 9:45
/** A "Ready now" scanner setup: SELL R_100 at 1000, stop 1010, target 980. */
const setupItem = (o = {}) => {
  const it = { symbol: "R_100", name: "Volatility 100 Index", tf: 900, strategy: "rules", side: "SELL", status: "ready", at: NOW - 60000,
               entry: 1000, sl: 1010, tp: 980, slDist: 10, tpDist: 20, price: 1000, horizonBars: 0, rr: 2, reason: "Pulled back", start: CLOSED, ...o };
  return { ...it, id: o.id || `${it.symbol}:${it.tf}:${it.strategy}:${it.side}:${it.start}` };
};
/** Hands the engine one setup, as the scanner does after a scan, and waits for the order. */
async function take(engine, o = {}) { await engine.autoScan([setupItem(o)]); await flush(); }
const isBal = (r) => r.balance === 1, isPoc = (r) => r.proposal_open_contract === 1;
const pocFor = (id) => (r) => r.proposal_open_contract === 1 && r.contract_id === id;

// ------------------------------------------------------------------ tests
test("connects with the token, follows the clock market, and a scanner setup sends a proposal then a buy", async () => {
  const ctx = await ready(setup());
  const { engine, sock, rest } = ctx;
  try {
    assert.equal(rest.calls[0].url, "https://api.example/trading/v1/options/accounts");
    assert.equal(rest.calls[0].opts.headers.Authorization, `Bearer ${PAT}`);
    assert.equal(rest.calls[0].opts.headers["Deriv-App-ID"], "app42");
    assert.match(rest.calls[1].url, /accounts\/DOT1\/otp$/, "a fresh OTP for the demo account");
    const hist = sock.streams.find((s) => isHistory(s.req)).req;
    assert.deepEqual({ ...hist }, { ticks_history: CLOCK_SYMBOL, style: "candles", granularity: 60, count: 120, end: "latest", adjust_start_time: 1 });
    assert.ok(sock.streams.some((s) => s.req.balance === 1), "balance subscribed");
    assert.ok(sentOf(sock, "portfolio").length, "open trades looked up");
    assert.equal(sentOf(sock, "contracts_for").length, 0, "no market of its own to ask about");
    assert.equal(engine.status().account.id, "DOT1");

    await take(engine);
    assert.equal(sentOf(sock, "proposal").length, 0, "stopped: nothing is traded");
    engine.start();
    await take(engine);
    const [p] = sentOf(sock, "proposal");
    assert.ok(p, "proposal sent");
    assert.deepEqual(Object.keys(p).sort(), ["amount", "basis", "contract_type", "currency", "duration_unit", "limit_order", "multiplier", "proposal", "underlying_symbol"]);
    assert.equal(p.contract_type, "MULTDOWN");
    assert.equal(p.underlying_symbol, "R_100", "on the setup's own market");
    assert.equal(p.multiplier, 50, "the lowest multiplier the market offers");
    assert.ok(p.limit_order.stop_loss > 0 && p.limit_order.take_profit > 0 && p.amount <= 2000);
    assert.deepEqual(sentOf(sock, "buy"), [{ buy: "prop9000", price: p.amount }]);
    const st = engine.status();
    assert.equal(st.open.length, 1);
    assert.equal(st.open[0].side, "SELL");
    assert.equal(st.open[0].source, "scanner");
    assert.equal(st.tradesToday, 1);
    assert.equal(logged(engine, /^Opened SELL R_100 from the scanner/).length, 1);
    assert.ok(Math.abs(st.lastCost.commission - 0.25) < 1e-9);
    assert.deepEqual(st.marks, [{ t: NOW_S, side: "SELL", symbol: "R_100" }]);
    for (const k of ["strategy", "symbol", "lastSignal", "pending", "lastEval", "fast", "botTf"]) assert.equal(k in st, false, `no ${k} in the status`);
    sock.push(isPoc, { msg_type: "proposal_open_contract", proposal_open_contract: {
      contract_id: 9000, contract_type: "MULTDOWN", entry_spot: 1000, buy_price: 10, multiplier: 50, date_start: NOW_S + 5,
      limit_order: { stop_loss: { order_amount: -2, value: "1010" }, take_profit: { order_amount: 4, value: "980" } }, profit: 0 } });
    assert.deepEqual(engine.status().open[0].plan, { side: "SELL", entry: 1000, sl: 1010, tp: 980, slMoney: 2, tpMoney: 4, start: CLOSED + 900, end: null });
  } finally { ctx.cleanup(); }
});

test("Start and Stop: Auto trade takes setups only while running; Signals only never trades; Stop leaves open trades alone", async () => {
  const ctx = await ready(setup({ settings: { scanAutoMaxOpen: 3 } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    assert.match(logged(engine, /^Bot started/)[0].title, /Auto trade/);
    await take(engine);
    assert.equal(sentOf(sock, "buy").length, 1);
    engine.stop();
    assert.equal(engine.running, false);
    assert.equal(sentOf(sock, "sell").length, 0, "Stop closes nothing");
    assert.equal(engine.status().open.length, 1, "the open trade is still watched");
    await take(engine, { symbol: "R_50", name: "Volatility 50 Index" });
    assert.equal(sentOf(sock, "proposal").length, 1, "stopped: no new trade");
    // Signals only: running, nothing traded, the scanner just shows setups.
    engine.updateSettings({ mode: "signals" });
    engine.start();
    assert.match(logged(engine, /^Bot started/).at(-1).title, /Signals only/);
    await take(engine, { symbol: "R_50", name: "Volatility 50 Index" });
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.equal(engine.status().scanAuto.on, false);
    // Back to Auto trade while running (demo): setups are taken again at once.
    engine.updateSettings({ mode: "auto" });
    assert.equal(logged(engine, /^Mode: Auto trade \(demo only\)$/).length, 1);
    await take(engine, { symbol: "R_50", name: "Volatility 50 Index" });
    assert.equal(sentOf(sock, "proposal").length, 2);
  } finally { ctx.cleanup(); }
});

test("the caps: open at once and trades per day are one setting each, and they are the risk guard's limits", async () => {
  const ctx = await ready(setup({ settings: { scanAutoMaxOpen: 1, scanAutoMaxDay: 2 } }));
  const { engine, sock } = ctx;
  try {
    assert.equal(engine.guard.limits.maxOpen, 1);
    assert.equal(engine.guard.limits.maxTradesPerDay, 2);
    engine.start();
    await take(engine);
    await take(engine, { symbol: "R_50", name: "Volatility 50 Index" });
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.ok(logged(engine, /^Scanner setup not taken/).some((e) => /^1 trade open already/.test(e.detail)));
    engine.updateSettings({ scanAutoMaxOpen: 3 });
    assert.equal(engine.guard.limits.maxOpen, 3, "limits apply at once");
    await take(engine, { symbol: "R_10", name: "Volatility 10 Index" });
    assert.equal(sentOf(sock, "proposal").length, 2);
    await take(engine, { symbol: "R_25", name: "Volatility 25 Index" });
    assert.equal(sentOf(sock, "proposal").length, 2, "2 a day");
    assert.equal(engine.status().scanAuto.today, 2);
  } finally { ctx.cleanup(); }
});

test("never sends a second order while one is in flight", async () => {
  let release;
  const ctx = await ready(setup({ settings: { scanAutoMaxOpen: 3 }, over: {
    proposal: (req) => new Promise((r) => { release = () => r({ proposal: { id: "slow", ask_price: req.amount } }); }),
  } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    engine.autoScan([setupItem()]);
    await flush();
    assert.equal(engine.autoScan([setupItem({ symbol: "R_50" })]), null, "busy: nothing taken");
    assert.equal(sentOf(sock, "proposal").length, 1);
    release();
    await flush();
    assert.equal(sentOf(sock, "buy").length, 1);
    assert.equal(engine.status().open.length, 1);
  } finally { ctx.cleanup(); }
});

test("the daily loss limit on equity halts trading and closes all trades; the next day starts afresh", async () => {
  const ctx = await ready(setup());
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine);
    const p = sentOf(sock, "proposal")[0];
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -120, is_sold: 0 } });
    assert.equal(engine.status().halted, false, "-1.2% is inside the 3% limit");
    assert.ok(Math.abs(engine.status().dayPL + 1.2) < 1e-9);
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -350, is_sold: 0 } });
    await flush();
    const st = engine.status();
    assert.equal(st.halted, true);
    assert.match(st.haltReason, /daily loss limit/);
    assert.deepEqual(sentOf(sock, "sell"), [{ sell: 9000, price: 0 }]);
    assert.equal(logged(engine, /^Stopped for today/).length, 1);
    assert.equal(st.running, true, "still running: it carries on tomorrow");
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, buy_price: p.amount, profit: -350, is_sold: 1, status: "sold" } });
    await take(engine, { symbol: "R_50", name: "Volatility 50 Index" });
    assert.equal(sentOf(sock, "proposal").length, 1, "no new trade today");
    assert.match(engine.status().scanAuto.waiting, /daily loss limit/);
    // The next UTC day starts afresh (a clock candle closes then).
    ctx.t.now += 86400e3;
    clock(sock, NOW_S + 86400); clock(sock, NOW_S + 86460);
    await flush();
    assert.equal(engine.status().halted, false);
  } finally { ctx.cleanup(); }
});

test("a setup's time limit closes the trade, counted in its own candles on the clock", async () => {
  const ctx = await ready(setup());
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine, { horizonBars: 2 });   // two 15-minute candles after the 9:45 one: closes at 10:15
    assert.equal(engine.status().open[0].horizon, 2);
    clockRun(sock, NOW_S, NOW_S + 15 * 60);   // up to the candle that opens at 10:15 (10:14 closed)
    await flush();
    assert.equal(sentOf(sock, "sell").length, 0, "not yet");
    clock(sock, NOW_S + 16 * 60);             // the 10:15 candle closes
    await flush();
    assert.deepEqual(sentOf(sock, "sell"), [{ sell: 9000, price: 0 }]);
    assert.equal(logged(engine, /Closing trade \(30 min time limit\)/).length, 1);
    clock(sock, NOW_S + 17 * 60);
    await flush();
    assert.equal(sentOf(sock, "sell").length, 1, "asked once");
  } finally { ctx.cleanup(); }
});

test("after a restart the bot resumes by itself and picks up its open trades", async () => {
  const first = await ready(setup());
  first.engine.start();
  await take(first.engine, { horizonBars: 4 });
  assert.equal(first.engine.status().open.length, 1);
  first.engine.shutdown();   // a crash, reboot or update
  assert.equal(JSON.parse(readFileSync(join(first.dir, "state.json"), "utf8")).running, true);

  const second = makeEngine(first.dir, { over: { portfolio: () => ({ portfolio: { contracts: [
    { contract_id: 9000, contract_type: "MULTDOWN", underlying_symbol: "R_100" },
    { contract_id: 9100, contract_type: "MULTUP", underlying_symbol: "R_50" },      // opened by hand: watched too, so its stake isn't a loss
    { contract_id: 9200, contract_type: "CALL", underlying_symbol: "R_75" },        // not a Multiplier
  ] } }) } });
  try {
    await second.engine.init();
    await flush();
    const { engine, sock } = second;
    assert.equal(engine.running, true);
    assert.equal(logged(engine, /^Resumed after a restart$/).length, 1);
    assert.equal(logged(engine, /trades only the scanner/).length, 0, "no update note for new settings");
    const st = engine.status();
    assert.deepEqual(st.open.map((o) => o.id), ["9000", "9100"]);
    assert.equal(st.open[0].source, "scanner");
    assert.equal(st.open[0].horizon, 4, "the time limit survives the restart");
    assert.equal(st.open[1].horizon, 0, "not the bot's trade: no time limit");
    assert.ok(sock.streams.some((s) => pocFor(9000)(s.req)));
    assert.equal(st.resumedAt, second.t.now, "the page can say when it carried on by itself");
    await take(engine);
    assert.equal(sentOf(sock, "proposal").length, 0, "the same setup is never taken twice");
    assert.ok(engine.seq > first.engine.seq, "log numbering continues");
  } finally { second.cleanup(); }
});

test("a buy that may have gone through is never repeated; open trades are reloaded first", async () => {
  let buys = 0;
  let portfolio = [];
  const ctx = await ready(setup({ settings: { scanAutoMaxOpen: 3 }, over: {
    buy: () => { buys++; portfolio = [{ contract_id: 7777, contract_type: "MULTDOWN", underlying_symbol: "R_100" }]; throw new Error("request timed out"); },
    portfolio: () => ({ portfolio: { contracts: portfolio } }),
  } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine);
    await flush(10);
    assert.equal(buys, 1);
    assert.deepEqual(engine.status().open.map((o) => o.id), ["7777"], "the trade Deriv opened is found");
    assert.equal(engine.status().scanAuto.today, 1, "counted: it went through");
    // A dropped connection: nothing trades until the open trades are checked again.
    sock.drop();
    assert.equal(engine.status().syncing, true);
    await take(engine, { symbol: "R_50" });
    assert.equal(sentOf(sock, "proposal").length, 1);
    sock.online = true; sock.h.onStatus("online");
    await flush();
    assert.equal(engine.status().syncing, false);
    assert.equal(engine.status().open.length, 1, "not tracked twice");
  } finally { ctx.cleanup(); }
});

test("a rejected token stops the bot, is remembered, and needs a new token", async () => {
  const ctx = await ready(setup());
  const { engine, sock, dir } = ctx;
  try {
    engine.start();
    ctx.rest.otpStatus = 401;           // the token was deleted at Deriv
    sock.drop();
    await engine.socket.connect();      // DerivSocket asks for a fresh OTP on every reconnect
    await flush();
    const st = engine.status();
    assert.equal(st.running, false);
    assert.equal(st.needsToken, true);
    assert.match(st.error, /did not accept your token/);
    assert.equal(st.feed, "public");
    assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).running, false);
    assert.throws(() => engine.start(), UserError);

    const again = makeEngine(dir);
    await again.engine.init();
    assert.equal(again.engine.status().needsToken, true);
    assert.equal(again.rest.calls.length, 0, "a rejected token isn't retried after a restart");
    again.engine.shutdown();
  } finally { ctx.cleanup(); }
});

test("a token rejected at startup stops a resumed bot", async () => {
  const ctx = setup({ state: { running: true }, deriv: { status: 401 } });
  try {
    await ctx.engine.init();
    assert.equal(ctx.engine.running, false);
    assert.equal(ctx.engine.status().needsToken, true);
  } finally { ctx.cleanup(); }
});

test("network trouble at startup is retried, not treated as a bad token", async () => {
  const ctx = setup({ state: { running: true }, deriv: { offline: true } });
  try {
    ctx.engine.retryDelay = 20;
    await ctx.engine.init();
    assert.equal(ctx.engine.running, true);
    assert.equal(ctx.engine.status().needsToken, false);
    assert.match(ctx.engine.status().error, /Can't reach Deriv/);
    ctx.rest.offline = false;
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    assert.equal(ctx.engine.status().connection, "online");
    assert.equal(ctx.engine.status().error, "");
    assert.equal(ctx.engine.running, true);
  } finally { ctx.cleanup(); }
});

test("real money accounts are refused unless Allow real money is on, and never auto trade", async () => {
  const ctx = await ready(setup({ state: { accountId: "ROT1" } }));
  const { engine } = ctx;
  try {
    assert.equal(engine.status().account.id, "DOT1", "the saved real account is not used");
    assert.throws(() => engine.selectAccount("ROT1"), (e) => e instanceof UserError && e.status === 403);
    assert.deepEqual(cleanSettings({ allowReal: true }, engine.settings).errors.length, 1, "needs REAL typed");
    assert.equal(cleanSettings({ allowReal: true, confirmReal: "real" }, engine.settings).errors.length, 1, "exactly REAL");
    const ok = cleanSettings({ allowReal: true, confirmReal: "REAL" }, engine.settings);
    assert.deepEqual(ok, { settings: { allowReal: true }, errors: [] });
    engine.updateSettings(ok.settings);
    assert.equal(engine.selectAccount("ROT1").type, "real");
    // Auto trade is demo only: Start is refused with a clear message, and so is switching to it.
    assert.throws(() => engine.start(), (e) => e instanceof UserError && e.code === "scanner_demo_only" && e.status === 403 && /demo only/.test(e.message));
    assert.equal(engine.running, false);
    assert.equal(engine.status().scanAutoBlocked, true);
    engine.updateSettings({ mode: "signals" });
    assert.throws(() => engine.updateSettings({ mode: "auto" }), (e) => e.code === "scanner_demo_only");
    assert.equal(engine.settings.mode, "signals");
    engine.start();
    assert.equal(engine.running, true, "Signals only works on a real account: nothing is traded");
    engine.updateSettings({ allowReal: false });
    assert.equal(engine.running, false, "turning real money off stops the bot");
    assert.equal(engine.status().account.id, "DOT1", "and goes back to demo");
  } finally { ctx.cleanup(); }
});

test("a login with only a real account does not trade without permission", async () => {
  const ctx = await ready(setup({ deriv: { accounts: [REAL] } }));
  try {
    assert.equal(ctx.engine.status().account, null);
    assert.match(ctx.engine.status().error, /no demo account/);
    assert.throws(() => ctx.engine.start(), UserError);
  } finally { ctx.cleanup(); }
});

test("setCredentials checks the token with Deriv before saving it; the token is never shown", async () => {
  const ctx = setup({ secret: false });
  const { engine, dir } = ctx;
  try {
    await engine.init();
    assert.equal(engine.status().feed, "public");
    ctx.rest.status = 401;
    await assert.rejects(engine.setCredentials({ appId: "app42", token: "wrong_token_123" }), (e) => e.status === 400 && /did not accept/.test(e.message));
    assert.equal(ctx.store.getSecret(), null, "a rejected token is not saved");
    ctx.rest.status = 200;
    await assert.rejects(engine.setCredentials({ appId: "", token: PAT }), /App ID/);
    await assert.rejects(engine.setCredentials({ appId: "app42", token: "has space" }), /token/);
    const out = await engine.setCredentials({ appId: " app42​", token: PAT });
    assert.equal(out.account.id, "DOT1");
    assert.equal(statSync(join(dir, "secret.json")).mode & 0o777, 0o600);
    assert.deepEqual(ctx.store.getSecret(), { appId: "app42", token: PAT });
    const st = engine.status();
    assert.equal(st.tokenHint, "1234");
    assert.ok(!JSON.stringify(st).includes(PAT), "status never contains the token");
    assert.ok(!JSON.stringify(out).includes(PAT));
    assert.ok(!readFileSync(join(dir, "log.jsonl"), "utf8").includes(PAT), "log never contains the token");
    assert.ok(!JSON.stringify(ctx.printed).includes(PAT));
    engine.forgetCredentials();
    assert.equal(ctx.store.getSecret(), null);
    assert.equal(engine.status().hasToken, false);
  } finally { ctx.cleanup(); }
});

test("settings: validated and clamped; the old market, strategy and multiplier keys are ignored; mode can change while running", async () => {
  assert.deepEqual(cleanSettings({ riskPct: 50, maxDailyLossPct: 0, scanAutoMaxOpen: 2.6, scanAutoMaxDay: 99, symbol: "R_10", strategy: "ict", multiplier: 100,
                                   maxOpen: 3, maxTradesPerDay: 9, aiFast: true, scanAuto: true, botTf: 900, junk: 1 }).settings,
                   { riskPct: 5, maxDailyLossPct: 0.5, scanAutoMaxOpen: 3, scanAutoMaxDay: 10 });
  assert.equal(cleanSettings({ riskPct: "abc" }).errors.length, 1);
  assert.equal(cleanSettings({ mode: "yolo" }).errors.length, 1);
  assert.equal(cleanSettings([1]).errors.length, 1);
  const ctx = await ready(setup());
  try {
    ctx.engine.start();
    ctx.engine.updateSettings({ mode: "signals" });
    assert.equal(ctx.engine.running, true, "switching mode doesn't stop the bot");
    assert.equal(logged(ctx.engine, /^Mode: Signals only$/).length, 1);
    assert.equal(JSON.parse(readFileSync(join(ctx.dir, "settings.json"), "utf8")).mode, "signals");
  } finally { ctx.cleanup(); }
});

test("update from the single-market bot: scanner auto-trade on keeps Auto trade, off becomes Signals only; odd files don't crash", () => {
  const fresh = loadSettings({});
  assert.equal(fresh.legacy, null);
  assert.deepEqual(fresh.settings, DEFAULT_SETTINGS, "a new install: Auto trade (Start still needs a demo account)");
  const on = loadSettings({ symbol: "frxEURUSD", strategy: "ict", mode: "auto", scanAuto: true, scanAutoStrategies: ["ict"], scanAutoTfs: [3600],
                            scanAutoMaxDay: 6, maxTradesPerDay: 3, riskPct: 2, multiplier: 100, aiFast: true, botTf: 900 });
  assert.equal(on.settings.mode, "auto");
  assert.equal(on.settings.v, SETTINGS_VERSION);
  assert.equal(on.settings.scanAutoMaxDay, 3, "the smaller of the old daily limits");
  assert.equal(on.settings.riskPct, 2);
  for (const k of ["symbol", "strategy", "multiplier", "aiFast", "botTf", "scanAuto", "maxTradesPerDay", "scanAutoStrategies"]) assert.equal(k in on.settings, false, k);
  assert.deepEqual(on.legacy, { scanAuto: true, strategies: ["ict"], timeframes: [3600], symbol: "frxEURUSD", strategy: "ict" });
  assert.equal(loadSettings({ strategy: "rules", mode: "auto", scanAuto: false }).settings.mode, "signals", "scanner auto-trade was off: nothing trades after the update");
  assert.equal(loadSettings({ strategy: "rules", mode: "auto" }).settings.mode, "signals", "from before scanner auto-trade existed");
  assert.equal(loadSettings({ mode: "signals", scanAuto: true }).settings.mode, "signals", "it traded nothing in Signals only before either");
  assert.equal(loadSettings({ v: SETTINGS_VERSION, mode: "signals" }).settings.mode, "signals", "after the update, the saved mode is kept");
  for (const raw of [null, [], "x", { riskPct: "lots", mode: 7, scanAutoStrategies: "ict", scanAutoTfs: [1, 2] }, { v: 99 }])
    assert.ok(["auto", "signals"].includes(loadSettings(raw).settings.mode), JSON.stringify(raw));
});

test("update from the single-market bot: the running bot carries on, its old trade is still watched and closed on time", async () => {
  const meta = { side: "BUY", entryEpoch: NOW_S - 50 * 60, horizon: 60, symbol: "frxEURUSD" };   // the old AI's 60-minute limit
  const ctx = setup({ rawSettings: { symbol: "frxEURUSD", strategy: "ai", mode: "auto", scanAuto: false, maxOpen: 1 },
                      state: { running: true, lastSignal: { action: "BUY" }, openMeta: { 555: meta } },
                      over: { portfolio: () => ({ portfolio: { contracts: [{ contract_id: 555, contract_type: "MULTUP", underlying_symbol: "frxEURUSD" }] } }) } });
  await ready(ctx);
  const { engine, sock } = ctx;
  try {
    assert.equal(engine.running, true, "it was running: it carries on");
    assert.equal(engine.settings.mode, "signals");
    const note = logged(engine, /^The bot now trades only the scanner's setups$/);
    assert.equal(note.length, 1);
    assert.match(note[0].detail, /frxEURUSD, ai\) are no longer used.*Signals only/);
    const saved = JSON.parse(readFileSync(join(ctx.dir, "settings.json"), "utf8"));
    assert.equal(saved.v, SETTINGS_VERSION, "moved over once");
    assert.equal(saved.symbol, undefined);
    const st = engine.status();
    assert.deepEqual(st.open.map((o) => [o.id, o.source, o.horizon]), [["555", "bot", 60]]);
    await take(engine);
    assert.equal(sentOf(sock, "proposal").length, 0, "Signals only: nothing traded");
    clockRun(sock, NOW_S, NOW_S + 11 * 60);
    await flush();
    assert.deepEqual(sentOf(sock, "sell"), [{ sell: 555, price: 0 }], "closed at its time limit");
    const again = makeEngine(ctx.dir);
    assert.equal(again.engine.legacy, null, "the note is written once");
    again.engine.shutdown();
  } finally { ctx.cleanup(); }
});

test("update from the single-market bot with scanner auto-trade on: Auto trade, and the scanner keeps what it traded", async () => {
  const ctx = setup({ rawSettings: { symbol: "R_50", strategy: "rules", mode: "auto", scanAuto: true, scanAutoStrategies: ["rules"], scanAutoTfs: [900] } });
  ctx.store.saveScanner({ on: false, synthetics: true, timeframes: [900, 3600] });
  await ready(ctx);
  try {
    assert.equal(ctx.engine.settings.mode, "auto");
    const scanner = new Scanner(ctx.engine, { store: ctx.store });
    assert.deepEqual(scanner.settings, { on: true, synthetics: true, timeframes: [900], strategies: ["rules"] });
    assert.deepEqual(ctx.store.getScanner(), scanner.settings, "saved");
  } finally { ctx.cleanup(); }
});

test("store: private files, atomic JSON and a trimmed log", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "tbot-store-")), "data");
  try {
    const store = new FileStore(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    store.saveSecret({ appId: "a", token: "t" });
    store.saveState({ running: true });
    assert.equal(statSync(join(dir, "secret.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);
    store.guardStorage.setItem("tbot:guard:X", JSON.stringify({ trades: 2 }));
    assert.equal(JSON.parse(new FileStore(dir).guardStorage.getItem("tbot:guard:X")).trades, 2);
    for (let i = 1; i <= LOG_MAX_LINES + 250; i++) store.appendLog({ seq: i, tag: "INFO", title: `line ${i}` });
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");
    assert.ok(lines.length <= LOG_MAX_LINES + 200, `trimmed (${lines.length})`);
    assert.equal(JSON.parse(lines.at(-1)).seq, LOG_MAX_LINES + 250);
    assert.equal(statSync(join(dir, "log.jsonl")).mode & 0o777, 0o600);
    writeFileSync(join(dir, "log.jsonl"), '{"seq":1}\n{"seq":2,"tit');   // torn last line after a crash
    assert.deepEqual(new FileStore(dir).readLog().map((e) => e.seq), [1]);
  } finally { rmSync(join(dir, ".."), { recursive: true, force: true }); }
});

// ------------------------------------------------------- review fixes
test("a win reported before the new balance does not trip the daily loss limit", async () => {
  const ctx = await ready(setup({ settings: { maxDailyLossPct: 0.5 } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine);
    const p = sentOf(sock, "proposal")[0];
    assert.ok(p.amount / 10000 > 0.005, "the stake is bigger than the limit, so the race matters");
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    await flush();
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 40, is_sold: 0 } });
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 40, is_sold: 1, status: "sold" } });
    clock(sock, NOW_S); clock(sock, NOW_S + 60);   // a clock candle closes inside the gap too
    await flush();
    assert.equal(engine.status().halted, false, "waits for the new balance");
    sock.push(isBal, { balance: { balance: 10040, currency: "USD" } });
    await flush();
    const st = engine.status();
    assert.equal(st.halted, false);
    assert.ok(Math.abs(st.dayPL - 0.4) < 1e-9);
    assert.equal(logged(engine, /^Stopped for today/).length, 0);
  } finally { ctx.cleanup(); }
});

test("the daily profit target (default 1%) stops the bot for the day and closes open trades", async () => {
  assert.equal(DEFAULT_SETTINGS.dailyProfitPct, 1);
  const ctx = await ready(setup({ settings: { dailyProfitPct: 1 } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine);
    const p = sentOf(sock, "proposal")[0];
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 50, is_sold: 0 } });
    clock(sock, NOW_S); clock(sock, NOW_S + 60);
    await flush();
    assert.equal(engine.status().halted, false, "+0.5%: keeps going");
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 120, is_sold: 0 } });
    clock(sock, NOW_S + 120); clock(sock, NOW_S + 180);
    await flush();
    const st = engine.status();
    assert.equal(st.halted, true);
    assert.match(st.haltReason, /daily profit target reached/);
    const [e] = logged(engine, /^Stopped for today: daily profit target reached/);
    assert.equal(e.tag, "INFO");
    assert.equal(sentOf(sock, "sell").length, 1, "the open trade is closed to keep the profit");
  } finally { ctx.cleanup(); }
});

test("a hand-opened trade found when the balance drops is watched, so its stake is not a loss", async () => {
  let portfolio = [];
  const ctx = await ready(setup({ over: { portfolio: () => ({ portfolio: { contracts: portfolio } }) } }));
  const { engine, sock } = ctx;
  try {
    portfolio = [{ contract_id: 5555, contract_type: "MULTUP", underlying_symbol: "R_10" }];
    sock.push(isBal, { balance: { balance: 9500, currency: "USD" } });
    await flush();
    assert.ok(sock.streams.some((s) => pocFor(5555)(s.req)), "the hand-opened trade is watched");
    sock.push(pocFor(5555), { proposal_open_contract: { contract_id: 5555, contract_type: "MULTUP", buy_price: 500, profit: 0, is_sold: 0 } });
    await flush();
    const st = engine.status();
    assert.equal(st.halted, false);
    assert.equal(st.open.length, 1);
    assert.equal(st.open[0].source, "bot");
  } finally { ctx.cleanup(); }
});

test("a failed close after the daily loss halt is tried again on the next clock candle", async () => {
  let sells = 0;
  const ctx = await ready(setup({ over: { sell: () => { if (++sells === 1) throw new Error("request timed out"); return { sell: { sold_for: 1 } }; } } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    await take(engine);
    const p = sentOf(sock, "proposal")[0];
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    await flush();
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -400, is_sold: 0 } });
    await flush();
    assert.equal(engine.status().halted, true);
    assert.equal(sells, 1);
    assert.equal(engine.status().open[0].closing, false, "ready to try again");
    clock(sock, NOW_S); clock(sock, NOW_S + 60);
    await flush();
    assert.equal(sells, 2, "tried again on the next candle");
    clock(sock, NOW_S + 120);
    await flush();
    assert.equal(sells, 2, "not sent again once Deriv took it");
  } finally { ctx.cleanup(); }
});

test("an uncertain buy is looked for again, and a late-booked trade is found with its time limit", async (t) => {
  let portfolio = [];
  const ctx = await ready(setup({ over: {
    buy: () => { throw new Error("request timed out"); },
    portfolio: () => ({ portfolio: { contracts: portfolio } }),
  } }));
  const { engine, sock } = ctx;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    engine.start();
    await take(engine, { horizonBars: 3 });
    await flush(10);
    assert.equal(engine.status().open.length, 0);
    assert.equal(engine.status().syncing, true, "nothing trades while the order is unclear");
    portfolio = [{ contract_id: 4242, contract_type: "MULTDOWN", underlying_symbol: "R_100" }];   // Deriv booked it late
    await take(engine, { symbol: "R_50" });
    assert.equal(sentOf(sock, "proposal").length, 1, "no second order");
    t.mock.timers.tick(5000);
    await flush(10);
    const st = engine.status();
    assert.equal(st.syncing, false);
    assert.deepEqual(st.open.map((o) => [o.id, o.side, o.horizon, o.source]), [["4242", "SELL", 3, "scanner"]]);
    assert.equal(st.tradesToday, 1);
    assert.equal(logged(engine, /did go through/).length, 1);
  } finally { t.mock.timers.reset(); ctx.cleanup(); }
});

test("an uncertain buy that never shows up frees the bot after the last look", async (t) => {
  const ctx = await ready(setup({ over: { buy: () => { throw new Error("request timed out"); } } }));
  const { engine, sock } = ctx;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    engine.start();
    await take(engine);
    await flush(10);
    for (const ms of [5000, 15000, 45000, 90000]) { assert.equal(engine.syncing, true); t.mock.timers.tick(ms); await flush(10); }
    assert.equal(engine.syncing, false);
    assert.equal(sentOf(sock, "portfolio").length, 6, "the first look at connect, then five after the order");
    assert.equal(logged(engine, /did not go through/).length, 1);
  } finally { t.mock.timers.reset(); ctx.cleanup(); }
});

test("a clock feed that goes quiet makes the bot reconnect and watch its trades again", async () => {
  let portfolio = [];
  const ctx = await ready(setup({ over: { portfolio: () => ({ portfolio: { contracts: portfolio } }) } }));
  const { engine } = ctx;
  try {
    engine.start();
    await take(engine, { horizonBars: 4 });
    portfolio = [{ contract_id: 9000, contract_type: "MULTDOWN", underlying_symbol: "R_100" }];
    clock(ctx.sock, NOW_S);
    const n = ctx.sockets.length;
    ctx.t.now += 2 * 60000;
    engine.watchdog();
    assert.equal(ctx.sockets.length, n, "2 quiet minutes are fine");
    ctx.t.now += 2 * 60000;
    engine.watchdog();
    await flush();
    assert.equal(ctx.sockets.length, n + 1, "a new connection");
    assert.ok(ctx.sockets[n - 1].closed, "the stuck one is closed");
    assert.ok(ctx.sock.streams.some((s) => pocFor(9000)(s.req)), "the open trade is watched on the new connection");
    assert.equal(engine.status().open[0].horizon, 4);
    assert.equal(logged(engine, /price feed went quiet/).length, 1);
    engine.watchdog();
    assert.equal(ctx.sockets.length, n + 1, "not again straight away");
  } finally { ctx.cleanup(); }
});

test("pressing Stop while a proposal is out sends no buy", async () => {
  let release;
  const ctx = await ready(setup({ over: { proposal: (req) => new Promise((r) => { release = () => r({ proposal: { id: "p1", ask_price: req.amount } }); }) } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    const run = engine.autoScan([setupItem()]);
    await flush();
    engine.stop();
    release();
    await run;
    await flush();
    assert.equal(sentOf(sock, "buy").length, 0);
    assert.equal(logged(engine, /Skipped SELL: the bot was stopped/).length, 1);
    assert.equal(engine.busy, false);
  } finally { ctx.cleanup(); }
});

test("a trade that closed while the server was down still counts for the losing streak", async () => {
  const day = new Date(Date.UTC(2026, 9, 2, 10)).toISOString().slice(0, 10);
  const ctx = setup({ settings: { maxConsecLosses: 3, cooldownMinutes: 15 },
                      state: { openMeta: { 777: { side: "SELL", entryEpoch: 1, horizon: 60, symbol: "R_75" } } } });
  ctx.store.guardStorage.setItem("tbot:guard:DOT1", JSON.stringify({ day, startBalance: 10000, trades: 3, halted: false, lossStreak: 2, cooldownUntil: 0 }));
  await ready(ctx);
  const { engine, sock } = ctx;
  try {
    assert.ok(sock.streams.some((s) => pocFor(777)(s.req)), "its final result is looked up");
    assert.equal(engine.status().open.length, 0, "not shown as open");
    sock.push(pocFor(777), { proposal_open_contract: { contract_id: 777, contract_type: "MULTDOWN", buy_price: 50, profit: -5, is_sold: 1, status: "sold",
                                                       sell_time: Math.floor(ctx.t.now / 1000) - 600 } });
    await flush();
    assert.equal(engine.guard.state.cooldownUntil, ctx.t.now - 600e3 + 15 * 60e3, "the pause counts from the real close time");
    assert.equal(logged(engine, /^Closed SELL R_75: -5.00 USD/).length, 1);
    assert.deepEqual(engine.state.openMeta, {});
  } finally { ctx.cleanup(); }
});

test("removing the token while Deriv is still answering does not mark it rejected", async () => {
  const ctx = setup();
  const { engine } = ctx;
  const realFetch = globalThis.fetch;
  let release;
  globalThis.fetch = (...a) => new Promise((r) => { release = () => r(realFetch(...a)); });
  try {
    const started = engine.init();
    await flush();
    engine.forgetCredentials();
    globalThis.fetch = realFetch;
    ctx.rest.otpStatus = 401;
    release();
    await started;
    await flush();
    const st = engine.status();
    assert.equal(st.hasToken, false);
    assert.equal(st.needsToken, false);
    assert.equal(st.account, null);
    assert.equal(st.feed, "public");
    assert.equal(engine.state.tokenRejected, false);
  } finally { globalThis.fetch = realFetch; ctx.cleanup(); }
});

