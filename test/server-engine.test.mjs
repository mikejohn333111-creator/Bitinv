// The server's trading engine with a fake Deriv socket, a fake clock and a stubbed REST API.
// The AI model on the fixture bars gives real signals: SELL on bars 465 and 466.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingEngine, cleanSettings, UserError } from "../server/engine.mjs";
import { FileStore, LOG_MAX_LINES } from "../server/store.mjs";
import { evaluateAI, AI_FAST } from "../public/js/strategy.js";

const fx = JSON.parse(readFileSync(new URL("./fixture-ai.json", import.meta.url)));
const model = JSON.parse(readFileSync(new URL("../public/model/tbotai-model.json", import.meta.url)));
const SIG = 465;
const PAT = "pat_test_TOKEN_abcd1234";
const DEMO = { account_id: "DOT1", account_type: "demo", currency: "USD", balance: 10000, status: "active" };
const REAL = { account_id: "ROT1", account_type: "real", currency: "USD", balance: 500, status: "active" };
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

function setup({ settings = {}, state, secret = true, over = {}, deriv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tbot-engine-"));
  const store = new FileStore(dir);
  store.saveSettings({ strategy: "ai", mode: "auto", ...settings });
  if (state) store.saveState(state);
  if (secret) store.saveSecret({ appId: "app42", token: PAT });
  return makeEngine(dir, { over, deriv });
}

function makeEngine(dir, { over = {}, deriv = {}, clock } = {}) {
  const t = clock || { now: Date.UTC(2026, 9, 2, 10) };
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
function history(sock, upto) { sock.push(isHistory, { msg_type: "candles", candles: fx.bars.slice(0, upto + 1) }); }
/** Starts bar i, which closes bar i-1. */
function openBar(sock, i) {
  const b = fx.bars[i];
  sock.push(isHistory, { msg_type: "ohlc", ohlc: { open_time: b.epoch, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close) } });
}
const sentOf = (sock, key) => sock.sent.filter((r) => r[key] !== undefined);
const logged = (engine, re) => engine.logs.filter((e) => re.test(e.title));

async function ready(ctx) {
  await ctx.engine.init();
  await flush();
  return ctx;
}

// ------------------------------------------------------------------ tests
test("the fixture really gives AI signals on bars 465 and 466", () => {
  for (const i of [SIG, SIG + 1]) assert.equal(evaluateAI(fx.bars.slice(0, i + 1), model, { threshold: 0.55, margin: 0.1, barrierATR: 3, horizonBars: 60 }).action, "SELL");
});

test("connects with the token, subscribes like the browser, and a signal sends a proposal then a buy", async () => {
  const ctx = await ready(setup());
  const { engine, sock, rest } = ctx;
  try {
    assert.equal(rest.calls[0].url, "https://api.example/trading/v1/options/accounts");
    assert.equal(rest.calls[0].opts.headers.Authorization, `Bearer ${PAT}`);
    assert.equal(rest.calls[0].opts.headers["Deriv-App-ID"], "app42");
    assert.match(rest.calls[1].url, /accounts\/DOT1\/otp$/, "a fresh OTP for the demo account");
    const hist = sock.streams.find((s) => isHistory(s.req)).req;
    assert.deepEqual({ ...hist }, { ticks_history: "R_75", style: "candles", granularity: 60, count: 1200, end: "latest", adjust_start_time: 1 });
    assert.ok(sock.streams.some((s) => s.req.balance === 1), "balance subscribed");
    assert.ok(sentOf(sock, "portfolio").length, "open trades looked up");
    assert.equal(engine.status().account.id, "DOT1");

    engine.start();
    history(sock, SIG);
    assert.equal(sentOf(sock, "proposal").length, 0, "no trade on history alone");
    openBar(sock, SIG + 1);
    await flush();
    const [p] = sentOf(sock, "proposal");
    assert.ok(p, "proposal sent");
    const keys = Object.keys(p).sort();
    assert.deepEqual(keys, ["amount", "basis", "contract_type", "currency", "duration_unit", "limit_order", "multiplier", "proposal", "underlying_symbol"]);
    assert.equal(p.contract_type, "MULTDOWN");
    assert.equal(p.underlying_symbol, "R_75");
    assert.equal(p.multiplier, 50, "lowest offered multiplier");
    assert.equal(p.basis, "stake");
    assert.ok(p.limit_order.stop_loss > 0 && p.limit_order.take_profit > 0 && p.amount <= 2000);
    const [b] = sentOf(sock, "buy");
    assert.deepEqual(b, { buy: "prop9000", price: p.amount });
    const st = engine.status();
    assert.equal(st.open.length, 1);
    assert.equal(st.open[0].side, "SELL");
    assert.equal(st.tradesToday, 1);
    assert.ok(sock.streams.some((s) => s.req.proposal_open_contract === 1 && s.req.contract_id === 9000), "contract tracked");
    assert.equal(logged(engine, /^Opened SELL R_75/).length, 1);
    assert.equal(st.lastSignal.traded, true);
    assert.ok(Math.abs(st.lastCost.commission - 0.25) < 1e-9);
  } finally { ctx.cleanup(); }
});

test("signals mode logs one signal per gap and trades nothing", async () => {
  const ctx = await ready(setup({ settings: { mode: "signals" } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);   // SELL on 465
    openBar(sock, SIG + 2);   // SELL on 466, inside the gap
    await flush();
    assert.equal(engine.logs.filter((e) => e.tag === "SELL").length, 1);
    assert.equal(sentOf(sock, "proposal").length, 0);
    assert.equal(engine.status().lastSignal.barEpoch, fx.bars[SIG].epoch);
    assert.equal(engine.state.lastSignalEpoch, fx.bars[SIG].epoch);
  } finally { ctx.cleanup(); }
});

test("the risk guard blocks a second trade, and nothing trades while stopped", async () => {
  const ctx = await ready(setup());
  const { engine, sock } = ctx;
  try {
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0, "stopped: no trade");
    engine.start();
    openBar(sock, SIG + 2);   // signal on 466
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    openBar(sock, SIG + 3);
    openBar(sock, SIG + 4);   // SELL on 468: one trade is open already
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.ok(logged(engine, /Skipped SELL: max open trades reached/).length >= 1);
  } finally { ctx.cleanup(); }
});

test("never sends a second order while one is in flight", async () => {
  let release;
  const ctx = await ready(setup({ settings: { maxOpen: 3 }, over: {
    proposal: (req) => new Promise((r) => { release = () => r({ proposal: { id: "slow", ask_price: req.amount } }); }),
  } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    openBar(sock, SIG + 2);   // another signal while the first order waits
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    release();
    await flush();
    assert.equal(sentOf(sock, "buy").length, 1);
    assert.equal(engine.status().open.length, 1);
  } finally { ctx.cleanup(); }
});

test("the daily loss limit on equity halts trading and closes all trades", async () => {
  const ctx = await ready(setup());
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    const p = sentOf(sock, "proposal")[0];
    const isBal = (r) => r.balance === 1, isPoc = (r) => r.proposal_open_contract === 1;
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
    // Closed at a loss: no new trade today.
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, buy_price: p.amount, profit: -350, is_sold: 1, status: "sold" } });
    openBar(sock, SIG + 2);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.ok(logged(engine, /Skipped SELL: daily loss limit/).length >= 1);
    // The next UTC day starts afresh.
    ctx.t.now += 86400e3;
    openBar(sock, SIG + 3);
    await flush();
    assert.equal(engine.status().halted, false);
  } finally { ctx.cleanup(); }
});

test("AI trades close after the time limit", async () => {
  const ctx = await ready(setup({ settings: { aiHorizon: 5 } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    assert.equal(engine.status().open[0].horizon, 5);
    const entry = fx.bars[SIG].epoch;
    let i = SIG + 2;              // opening bar i closes bar i-1
    for (; fx.bars[i - 1].epoch - entry < 300; i++) {
      openBar(sock, i);
      await flush();
      assert.equal(sentOf(sock, "sell").length, 0, `not closed yet after bar ${i - 1}`);
    }
    openBar(sock, i);             // closes the first bar 5 minutes after the entry bar
    await flush();
    assert.deepEqual(sentOf(sock, "sell"), [{ sell: 9000, price: 0 }]);
    assert.equal(logged(engine, /Closing trade \(5 min time limit\)/).length, 1);
    openBar(sock, i + 1);
    await flush();
    assert.equal(sentOf(sock, "sell").length, 1, "asked once");
  } finally { ctx.cleanup(); }
});

test("after a restart the bot resumes by itself and picks up its open trades", async () => {
  const first = await ready(setup({ settings: { aiHorizon: 30 } }));
  first.engine.start();
  history(first.sock, SIG);
  openBar(first.sock, SIG + 1);
  await flush();
  assert.equal(first.engine.status().open.length, 1);
  first.engine.shutdown();   // a crash, reboot or update
  assert.equal(JSON.parse(readFileSync(join(first.dir, "state.json"), "utf8")).running, true);

  const second = makeEngine(first.dir, { over: { portfolio: () => ({ portfolio: { contracts: [
    { contract_id: 9000, contract_type: "MULTDOWN", underlying_symbol: "R_75" },
    { contract_id: 9100, contract_type: "MULTUP", underlying_symbol: "R_50" },      // another market: watched too, so its stake isn't a loss
    { contract_id: 9200, contract_type: "CALL", underlying_symbol: "R_75" },        // not a Multiplier
  ] } }) } });
  try {
    await second.engine.init();
    await flush();
    const { engine, sock } = second;
    assert.equal(engine.running, true);
    assert.equal(logged(engine, /^Resumed after a restart$/).length, 1);
    const st = engine.status();
    assert.deepEqual(st.open.map((o) => o.id), ["9000", "9100"]);
    assert.equal(st.open[1].symbol, "R_50");
    assert.equal(st.open[1].horizon, 0, "not the bot's trade: no time limit");
    assert.equal(st.open[0].horizon, 30, "the time limit survives the restart");
    assert.equal(st.open[0].side, "SELL");
    assert.ok(sock.streams.some((s) => s.req.proposal_open_contract === 1 && s.req.contract_id === 9000));
    assert.equal(st.account.id, "DOT1");
    assert.equal(st.resumedAt, second.t.now, "the page can say when it carried on by itself");
    assert.equal(st.lastSignal?.action, "SELL", "the latest signal is still there after the restart");
    assert.equal(st.lastSignal.traded, true);
    // The same bar again (feed replayed after reconnect) and the next signal: no second trade.
    history(sock, SIG);
    openBar(sock, SIG + 1);
    openBar(sock, SIG + 2);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0);
    assert.ok(engine.logs.some((e) => e.seq > 0) && engine.seq > first.engine.seq, "log numbering continues");
  } finally { second.cleanup(); }
});

test("a buy that may have gone through is never repeated; open trades are reloaded first", async () => {
  let buys = 0;
  let portfolio = [];
  const ctx = await ready(setup({ settings: { maxOpen: 3 }, over: {
    buy: () => { buys++; portfolio = [{ contract_id: 7777, contract_type: "MULTDOWN", underlying_symbol: "R_75" }]; throw new Error("request timed out"); },
    portfolio: () => ({ portfolio: { contracts: portfolio } }),
  } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush(10);
    assert.equal(buys, 1);
    assert.deepEqual(engine.status().open.map((o) => o.id), ["7777"], "the trade Deriv opened is found");
    // A dropped connection: nothing trades until the open trades are checked again.
    sock.drop();
    assert.equal(engine.status().syncing, true);
    openBar(sock, SIG + 2);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.ok(logged(engine, /still checking your open trades/).length >= 1);
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

test("real money accounts are refused unless Allow real money is on", async () => {
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
    engine.start();
    assert.equal(engine.running, true);
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

test("settings are validated and clamped; mode can't change while running", async () => {
  assert.deepEqual(cleanSettings({ riskPct: 50, maxDailyLossPct: 0, maxOpen: 2.6, symbol: "R_10", junk: 1 }).settings,
                   { riskPct: 5, maxDailyLossPct: 0.5, maxOpen: 3, symbol: "R_10" });
  assert.equal(cleanSettings({ riskPct: "abc" }).errors.length, 1);
  assert.equal(cleanSettings({ symbol: "EVIL" }).errors.length, 1);
  assert.equal(cleanSettings({ mode: "yolo" }).errors.length, 1);
  assert.equal(cleanSettings([1]).errors.length, 1);
  const ctx = await ready(setup());
  try {
    ctx.engine.start();
    assert.throws(() => ctx.engine.updateSettings({ mode: "signals" }), /Stop the bot/);
    ctx.engine.updateSettings({ maxOpen: 2 });
    assert.equal(ctx.engine.guard.limits.maxOpen, 2, "limits apply at once");
    ctx.engine.updateSettings({ symbol: "R_50" });
    assert.equal(ctx.engine.running, false, "changing the market stops the bot, as in the browser");
    assert.equal(ctx.sock.streams.find((s) => isHistory(s.req)).req.ticks_history, "R_50");
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
const isBal = (r) => r.balance === 1, isPoc = (r) => r.proposal_open_contract === 1;
const pocFor = (id) => (r) => r.proposal_open_contract === 1 && r.contract_id === id;

test("changing market keeps watching the open trade, so its stake is not a loss (and a hand-opened trade is found)", async () => {
  let portfolio = [];
  const ctx = await ready(setup({ settings: { maxOpen: 3 }, over: { portfolio: () => ({ portfolio: { contracts: portfolio } }) } }));
  const { engine } = ctx;
  try {
    engine.start();
    history(ctx.sock, SIG);
    openBar(ctx.sock, SIG + 1);
    await flush();
    const p = sentOf(ctx.sock, "proposal")[0];
    portfolio = [{ contract_id: 9000, contract_type: "MULTDOWN", underlying_symbol: "R_75" }];
    ctx.sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    ctx.sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -1, is_sold: 0 } });
    await flush();
    engine.updateSettings({ symbol: "R_50" });
    await flush();
    const sock = ctx.sock;
    assert.ok(sock.streams.some((s) => pocFor(9000)(s.req)), "the R_75 trade is still watched on the new connection");
    sock.push(pocFor(9000), { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -1, is_sold: 0 } });
    await flush();
    let st = engine.status();
    assert.equal(st.halted, false, "no false daily-loss halt");
    assert.ok(Math.abs(st.dayPL + 0.01) < 1e-9, `day P/L counts the open stake (${st.dayPL})`);
    assert.deepEqual({ ...engine.state.openMeta["9000"] }, { side: "SELL", entryEpoch: fx.bars[SIG].epoch, horizon: 60, symbol: "R_75" });
    assert.equal(st.open[0].symbol, "R_75");
    assert.equal(st.open[0].horizon, 60, "the AI time limit is kept");

    // A trade opened by hand on Deriv: the balance drops, the bot looks again before the loss check.
    portfolio = [...portfolio, { contract_id: 5555, contract_type: "MULTUP", underlying_symbol: "R_10" }];
    sock.push(isBal, { balance: { balance: 10000 - p.amount - 500, currency: "USD" } });
    await flush();
    assert.ok(sock.streams.some((s) => pocFor(5555)(s.req)), "the hand-opened trade is watched");
    sock.push(pocFor(5555), { proposal_open_contract: { contract_id: 5555, contract_type: "MULTUP", buy_price: 500, profit: 0, is_sold: 0 } });
    await flush();
    st = engine.status();
    assert.equal(st.halted, false);
    assert.equal(st.open.length, 2);
  } finally { ctx.cleanup(); }
});

test("a win reported before the new balance does not trip the daily loss limit", async () => {
  const ctx = await ready(setup({ settings: { maxDailyLossPct: 0.5 } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    const p = sentOf(sock, "proposal")[0];
    assert.ok(p.amount / 10000 > 0.005, "the stake is bigger than the limit, so the race matters");
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    await flush();
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 40, is_sold: 0 } });
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: 40, is_sold: 1, status: "sold" } });
    engine.stop();            // so the next bar only runs the checks, not a new trade
    openBar(sock, SIG + 2);   // a bar closes inside the gap too
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

test("a failed close after the daily loss halt is tried again on the next bar", async () => {
  let sells = 0;
  const ctx = await ready(setup({ over: { sell: () => { if (++sells === 1) throw new Error("request timed out"); return { sell: { sold_for: 1 } }; } } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    const p = sentOf(sock, "proposal")[0];
    sock.push(isBal, { balance: { balance: 10000 - p.amount, currency: "USD" } });
    await flush();
    sock.push(isPoc, { proposal_open_contract: { contract_id: 9000, contract_type: "MULTDOWN", buy_price: p.amount, profit: -400, is_sold: 0 } });
    await flush();
    assert.equal(engine.status().halted, true);
    assert.equal(sells, 1);
    assert.equal(engine.status().open[0].closing, false, "ready to try again");
    openBar(sock, SIG + 2);
    await flush();
    assert.equal(sells, 2, "tried again on the next bar");
    openBar(sock, SIG + 3);
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
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush(10);
    assert.equal(engine.status().open.length, 0);
    assert.equal(engine.status().syncing, true, "nothing trades while the order is unclear");
    portfolio = [{ contract_id: 4242, contract_type: "MULTDOWN", underlying_symbol: "R_75" }];   // Deriv booked it late
    openBar(sock, SIG + 2);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1, "no second order");
    t.mock.timers.tick(5000);
    await flush(10);
    const st = engine.status();
    assert.equal(st.syncing, false);
    assert.deepEqual(st.open.map((o) => [o.id, o.side, o.horizon]), [["4242", "SELL", 60]]);
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
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush(10);
    for (const ms of [5000, 15000, 45000, 90000]) { assert.equal(engine.syncing, true); t.mock.timers.tick(ms); await flush(10); }
    assert.equal(engine.syncing, false);
    assert.equal(sentOf(sock, "portfolio").length, 6, "the first look at connect, then five after the order");
    assert.equal(logged(engine, /did not go through/).length, 1);
  } finally { t.mock.timers.reset(); ctx.cleanup(); }
});

test("a price feed that goes quiet makes the bot reconnect and watch its trades again", async () => {
  let portfolio = [];
  const ctx = await ready(setup({ over: { portfolio: () => ({ portfolio: { contracts: portfolio } }) } }));
  const { engine } = ctx;
  try {
    engine.start();
    history(ctx.sock, SIG);
    openBar(ctx.sock, SIG + 1);
    await flush();
    portfolio = [{ contract_id: 9000, contract_type: "MULTDOWN", underlying_symbol: "R_75" }];
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
    assert.equal(engine.status().open[0].horizon, 60);
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
    history(sock, SIG);
    openBar(sock, SIG + 1);
    await flush();
    engine.stop();
    release();
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

// ------------------------------------------------------------- fast mode
// With the fast preset the fixture gives a SELL on every bar from 463 to 478.
const FAST_SIG = 463;

test("fast mode uses the AI_FAST preset and allows up to 3 open trades, then keeps the user's own settings when off", async () => {
  const ctx = await ready(setup({ settings: { aiFast: true, maxOpen: 1, aiThreshold: 0.6, aiBarrier: 3, aiHorizon: 60 } }));
  const { engine, sock } = ctx;
  try {
    assert.deepEqual(engine.strategyParams(), { threshold: 0.45, margin: 0.05, barrierATR: 1, horizonBars: 10 });
    assert.equal(engine.limits().maxOpen, 3);
    assert.equal(engine.guard.limits.maxOpen, 3, "the risk guard uses the fast limit");
    assert.equal(engine.status().fast, true);
    engine.start();
    history(sock, FAST_SIG);
    for (let i = FAST_SIG + 1; i <= FAST_SIG + 4; i++) { openBar(sock, i); await flush(); }   // SELL on 463, 464, 465, 466
    const props = sentOf(sock, "proposal");
    assert.equal(props.length, 3, "three trades, then the open-trade limit");
    assert.ok(logged(engine, /Skipped SELL: max open trades reached/).length >= 1);
    const st = engine.status();
    assert.equal(st.open.length, 3);
    assert.ok(st.open.every((t) => t.horizon === 10), "fast trades close after 10 min");
    // Stop and target are 1x ATR: the same distance as the AI gives with the preset.
    const res = evaluateAI(fx.bars.slice(0, FAST_SIG + 1), model, engine.strategyParams());
    assert.equal(res.action, "SELL");
    assert.ok(Math.abs(res.slDist - AI_FAST.barrierATR * res.atr) < 1e-12 && res.tpDist === res.slDist);
    assert.ok(Math.abs(props[0].limit_order.take_profit - props[0].limit_order.stop_loss) < 0.02, "target equals stop at 1x ATR");
    // Off again: the user's own values are back, and the guard limit too.
    engine.updateSettings({ aiFast: false });
    assert.deepEqual(engine.strategyParams(), { threshold: 0.6, margin: 0.1, barrierATR: 3, horizonBars: 60 });
    assert.equal(engine.guard.limits.maxOpen, 1);
    assert.equal(engine.settings.maxOpen, 1, "the saved limit was never changed");
    // Fast mode does not apply to the rules strategy.
    engine.updateSettings({ aiFast: true, strategy: "rules" });
    assert.equal(engine.fast(), false);
    assert.equal(engine.limits().maxOpen, 1);
  } finally { ctx.cleanup(); }
});

test("fast mode never trades on a real account, even with Allow real money on", async () => {
  const ctx = await ready(setup({ settings: { aiFast: true, allowReal: true }, state: { accountId: "ROT1" } }));
  const { engine, sock } = ctx;
  try {
    assert.equal(engine.status().account.type, "real");
    assert.equal(engine.status().fastBlocked, true);
    assert.throws(() => engine.start(), (e) => e instanceof UserError && e.code === "fast_demo_only");
    assert.equal(engine.running, false);
    assert.equal(logged(engine, /^Did not start: fast mode is demo only/).length, 1);
    // Running already (e.g. resumed after a restart): every signal is refused, with a log line.
    engine.running = true;
    history(sock, FAST_SIG);
    openBar(sock, FAST_SIG + 1);
    openBar(sock, FAST_SIG + 2);
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0, "no order on the real account");
    assert.equal(logged(engine, /Skipped SELL: Fast mode is demo only/).length, 1, "logged once, not every bar");
    engine.running = false;
    // Turning it on while a real account is in use is refused too.
    engine.updateSettings({ aiFast: false });
    assert.throws(() => engine.updateSettings({ aiFast: true }), (e) => e.code === "fast_demo_only");
    assert.equal(engine.settings.aiFast, false);
    // On the demo account it trades.
    engine.selectAccount("DOT1");
    await flush();
    engine.updateSettings({ aiFast: true });
    engine.start();
    history(ctx.sock, FAST_SIG);
    openBar(ctx.sock, FAST_SIG + 1);
    await flush();
    assert.equal(sentOf(ctx.sock, "proposal").length, 1);
  } finally { ctx.cleanup(); }
});

test("fast mode setting is validated and kept across restarts", async () => {
  assert.deepEqual(cleanSettings({ aiFast: true }).settings, { aiFast: true });
  assert.equal(cleanSettings({ aiFast: "yes" }).errors.length, 1);
  const ctx = await ready(setup({ settings: { aiFast: true } }));
  try {
    assert.equal(ctx.engine.settings.aiFast, true);
    ctx.engine.shutdown();
    const again = makeEngine(ctx.dir);
    assert.equal(again.engine.settings.aiFast, true);
    again.engine.shutdown();
  } finally { ctx.cleanup(); }
});

// ------------------------------------------------- ICT, waiting plans, timeframe, markets
// The ICT setup of test/ict.test.mjs at a price level the Multiplier sizing accepts:
// price = 10000 + (unit - 100) x 10. The gap is 9990 to 10012; the sweep's low is 9965.
import { ictMinBars, historyCount } from "../public/js/strategy.js";
import { sizeMultiplier } from "../public/js/risk.js";
const U = (v) => 10000 + (v - 100) * 10;
const ICT_ROWS = [
  ...Array.from({ length: ictMinBars() + 20 }, () => [100, 100.5, 99.5, 100]),
  [100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2], [98.2, 98.4, 96.5, 97.5], [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6], [101.6, 102.5, 101.2, 102.2],
];
const ICT_T0 = Date.UTC(2026, 9, 2, 6) / 1000;
const ictBar = (k, [o, h, l, c] = [101.8, 102.0, 101.6, 101.8], sec = 60) =>
  ({ epoch: ICT_T0 + k * sec, open: U(o), high: U(h), low: U(l), close: U(c) });
const ICT_LAST = ICT_ROWS.length - 1;     // the candle that completes the gap
/** History up to the gap's candle (still forming), then a new candle closes it: the plan is made. */
function ictSetup(sock) {
  sock.push(isHistory, { msg_type: "candles", candles: ICT_ROWS.map((r, k) => ictBar(k, r)) });
  tick(sock, ictBar(ICT_LAST + 1));
}
const tick = (sock, b) => sock.push(isHistory, { msg_type: "ohlc", ohlc: { open_time: b.epoch, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close) } });
/** A tick at `price` inside candle k (which may already be forming). */
const tickAt = (sock, k, price) => tick(sock, { ...ictBar(k), close: price, low: Math.min(U(101.6), price) });

test("ICT: a waiting plan is made at the candle close and entered on the tick that reaches the zone, with the drawn stop and target", async () => {
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "auto" } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    ictSetup(sock);
    await flush();
    const plan = engine.status().pending;
    assert.ok(plan, "a waiting plan");
    assert.equal(plan.side, "BUY");
    assert.deepEqual(plan.zone, [U(99), U(101.2)]);
    assert.equal(plan.invalidateAt, U(96.5));
    assert.match(plan.text, /^Buy if price comes back to 9990\.0+ to 10012\.0+\. Stop loss .*, take profit .*\. Cancelled at \d\d:\d\d UTC or if price goes below 9965/);
    assert.equal(logged(engine, /^Waiting for price: BUY R_75/).length, 1);
    assert.equal(sentOf(sock, "proposal").length, 0, "nothing traded yet");
    tickAt(sock, ICT_LAST + 1, U(101.5));     // still above the zone
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0);
    tickAt(sock, ICT_LAST + 1, U(101.05));    // inside: enter now, not at the candle close
    await flush();
    const [p] = sentOf(sock, "proposal");
    assert.ok(p, "proposal on the touch");
    assert.equal(p.contract_type, "MULTUP");
    const entry = U(101.05);
    const size = sizeMultiplier({ balance: 10000, riskPct: 1, entry, slDist: entry - plan.sl, tpDist: plan.tp - entry, multiplier: 50, minStake: 1, maxStake: 2000 });
    assert.deepEqual(p.limit_order, { stop_loss: size.stopLoss, take_profit: size.takeProfit }, "the money of the drawn stop loss and take profit");
    assert.equal(sentOf(sock, "buy").length, 1);
    assert.equal(engine.status().pending, null, "the plan became the trade");
    assert.equal(engine.status().open[0].horizon, 30);
    assert.equal(engine.lastSignal.fromPending, true);
    assert.ok(Math.abs(engine.lastSignal.sl - plan.sl) < 1e-9 && Math.abs(engine.lastSignal.tp - plan.tp) < 1e-9, "same levels as the plan");
    // The touch candle closes: the closed-candle ICT signal of the same setup is not traded again.
    tick(sock, ictBar(ICT_LAST + 2));
    tick(sock, ictBar(ICT_LAST + 3));
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 1, "one trade for one setup");
  } finally { ctx.cleanup(); }
});

test("ICT: a waiting plan is cancelled when it expires, when price breaks the sweep's low, and when the bot stops", async () => {
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "auto" } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    ictSetup(sock);
    await flush();
    const plan = engine.status().pending;
    // 30 candles after the gap's candle, still above the zone: expired
    let k = ICT_LAST + 2;
    for (; ictBar(k).epoch < plan.expiresAt; k++) { tick(sock, ictBar(k)); await flush(); assert.ok(engine.status().pending, `still waiting at candle ${k}`); }
    tick(sock, ictBar(k));
    await flush();
    assert.equal(engine.status().pending, null);
    assert.equal(logged(engine, /^Cancelled the waiting BUY plan/).length, 1);
    assert.match(engine.logs.at(-1).detail, /did not come back in time/);
    assert.equal(sentOf(sock, "proposal").length, 0);
  } finally { ctx.cleanup(); }

  const again = await ready(setup({ settings: { strategy: "ict", mode: "auto" } }));
  try {
    again.engine.start();
    ictSetup(again.sock);
    await flush();
    tickAt(again.sock, ICT_LAST + 1, U(96.4));   // below the sweep's low (9965) without a tick in the zone
    await flush();
    assert.equal(again.engine.status().pending, null);
    assert.match(logged(again.engine, /^Cancelled the waiting BUY plan/)[0].detail, /below the low the setup was built on/);
    assert.equal(sentOf(again.sock, "proposal").length, 0);
    // a new plan, then Stop
    again.engine.stop();
    again.engine.start();
    ictSetup(again.sock);
    await flush();
    assert.ok(again.engine.status().pending === null, "a used setup is not offered again");
  } finally { again.cleanup(); }

  const third = await ready(setup({ settings: { strategy: "ict", mode: "signals" } }));
  try {
    third.engine.start();
    ictSetup(third.sock);
    await flush();
    assert.ok(third.engine.status().pending);
    third.engine.stop();
    assert.equal(third.engine.status().pending, null);
    assert.match(logged(third.engine, /^Cancelled the waiting BUY plan/)[0].detail, /The bot was stopped/);
  } finally { third.cleanup(); }
});

test("ICT in signals mode: the touch sends the signal at the price then, nothing is traded", async () => {
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "signals" } }));
  const { engine, sock } = ctx;
  try {
    engine.start();
    ictSetup(sock);
    await flush();
    const plan = engine.status().pending;
    tickAt(sock, ICT_LAST + 1, U(100.5));
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0);
    assert.equal(logged(engine, /^BUY R_75 @ 10005/).length, 1);
    assert.equal(engine.lastSignal.traded, false);
    assert.ok(Math.abs(engine.lastSignal.sl - plan.sl) < 1e-9);
  } finally { ctx.cleanup(); }
});

test("ICT is demo only for auto trade: refused on a real account, signals still work there", async () => {
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "auto", allowReal: true }, state: { accountId: "ROT1" } }));
  const { engine, sock } = ctx;
  try {
    assert.equal(engine.status().account.type, "real");
    assert.equal(engine.status().ictBlocked, true);
    assert.throws(() => engine.start(), (e) => e instanceof UserError && e.code === "ict_demo_only" && e.status === 403);
    assert.equal(engine.running, false);
    assert.equal(logged(engine, /^Did not start: ICT is demo only for auto trade/).length, 1);
    // Running already (resumed after a restart): the touch is refused, with one log line.
    engine.running = true;
    ictSetup(sock);
    await flush();
    tickAt(sock, ICT_LAST + 1, U(101.0));
    await flush();
    assert.equal(sentOf(sock, "proposal").length, 0, "no order on the real account");
    assert.equal(logged(engine, /^Skipped BUY: ICT is demo only for auto trade/).length, 1);
    engine.running = false;
    // Switching to ICT while auto trading a real account is refused.
    engine.updateSettings({ strategy: "rules" });
    engine.start();
    assert.throws(() => engine.updateSettings({ strategy: "ict" }), (e) => e.code === "ict_demo_only");
    engine.stop();
    // Signals only works on the real account.
    engine.updateSettings({ mode: "signals", strategy: "ict" });
    engine.start();
    assert.equal(engine.running, true);
    assert.equal(engine.status().ictBlocked, false);
  } finally { ctx.cleanup(); }
});

test("strategy timeframe: 1-hour candles are subscribed with enough history, and time limits count hours", async () => {
  assert.deepEqual(cleanSettings({ botTf: 3600 }).settings, { botTf: 3600 });
  assert.deepEqual(cleanSettings({ botTf: "900" }).settings, { botTf: 900 });
  assert.equal(cleanSettings({ botTf: 300 }).errors.length, 1);
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "auto", botTf: 3600 } }));
  const { engine, sock } = ctx;
  try {
    const hist = sock.streams.find((s) => isHistory(s.req)).req;
    assert.equal(hist.granularity, 3600);
    assert.equal(hist.count, historyCount("ict", 3600));
    assert.equal(engine.status().botTf, 3600);
    engine.start();
    sock.push(isHistory, { msg_type: "candles", candles: ICT_ROWS.map((r, k) => ictBar(k, r, 3600)) });
    tick(sock, ictBar(ICT_LAST + 1, undefined, 3600));
    await flush();
    const plan = engine.status().pending;
    assert.ok(plan);
    assert.equal(plan.expiresAt, ictBar(ICT_LAST, undefined, 3600).epoch + 31 * 3600, "30 one-hour candles");
    tick(sock, { ...ictBar(ICT_LAST + 1, undefined, 3600), close: U(101.0) });
    await flush();
    assert.equal(sentOf(sock, "buy").length, 1);
    assert.equal(engine.state.openMeta["9000"].barSec, 3600);
    // the 30-candle time limit is 30 hours
    let k = ICT_LAST + 2;
    for (; k < ICT_LAST + 31; k++) { tick(sock, ictBar(k, undefined, 3600)); await flush(); }
    assert.equal(sentOf(sock, "sell").length, 0, "not closed after 29 hours");
    tick(sock, ictBar(k, undefined, 3600)); tick(sock, ictBar(k + 1, undefined, 3600));
    await flush();
    assert.equal(sentOf(sock, "sell").length, 1);
    assert.equal(logged(engine, /Closing trade \(30 hours time limit\)/).length, 1);
    // changing the timeframe stops the bot and asks for the new candles
    engine.updateSettings({ botTf: 900 });
    assert.equal(engine.running, false);
    const h15 = ctx.sock.streams.find((s) => isHistory(s.req)).req;
    assert.equal(h15.granularity, 900);
    assert.equal(logged(engine, /The bot now trades on 15-minute candles/).length, 1);
  } finally { ctx.cleanup(); }
});

const ACTIVE_SYMBOLS = [
  { underlying_symbol: "R_75", display_name: "Volatility 75 Index", market: "synthetic_index", market_display_name: "Derived", submarket: "random_index", exchange_is_open: 1, is_trading_suspended: 0 },
  { underlying_symbol: "frxEURUSD", display_name: "EUR/USD", market: "forex", market_display_name: "Forex", submarket: "major_pairs", exchange_is_open: 1, is_trading_suspended: 0 },
  { underlying_symbol: "frxXAUUSD", display_name: "Gold/USD", market: "commodities", market_display_name: "Commodities", submarket: "metals", exchange_is_open: 0, is_trading_suspended: 0 },
];

test("markets: Deriv's list (Multipliers only) feeds the picker, unknown markets are refused, a closed market trades nothing", async () => {
  let asked = [];
  const ctx = await ready(setup({ settings: { strategy: "ict", mode: "auto" }, over: { active_symbols: (req) => { asked.push(req); return { active_symbols: ACTIVE_SYMBOLS }; } } }));
  const { engine } = ctx;
  try {
    assert.deepEqual({ ...asked[0], contract_type: [...asked[0].contract_type] }, { active_symbols: "brief", contract_type: ["MULTUP", "MULTDOWN"] });
    const st = engine.status();
    assert.deepEqual(st.marketGroups.map((g) => g.name), ["Synthetic indices", "Forex", "Commodities"]);
    assert.deepEqual(st.marketGroups[2].items, [{ symbol: "frxXAUUSD", name: "Gold/USD", open: false }]);
    assert.equal(st.marketOpen, true);
    assert.equal(cleanSettings({ symbol: "frxEURUSD" }, engine.settings, engine.knownSymbols()).errors.length, 0);
    assert.equal(cleanSettings({ symbol: "R_10" }, engine.settings, engine.knownSymbols()).errors.length, 1, "not in Deriv's list now");
    engine.updateSettings({ symbol: "frxXAUUSD" });
    await flush();
    assert.equal(engine.status().marketOpen, false);
    assert.equal(engine.status().synthetic, false);
    assert.equal(engine.status().symbolName, "Gold/USD");
    assert.match(logged(engine, /^Market changed to Gold\/USD/)[0].detail, /closed now/);
    engine.start();
    assert.equal(logged(engine, /^Gold\/USD is closed now/).length, 1);
    ictSetup(ctx.sock);
    await flush();
    tickAt(ctx.sock, ICT_LAST + 1, U(101.0));
    await flush();
    assert.equal(sentOf(ctx.sock, "proposal").length, 0, "no order while closed");
    assert.equal(logged(engine, /^Skipped BUY: Gold\/USD is closed now/).length, 1);
  } finally { ctx.cleanup(); }
});

test("markets: when Deriv refuses the Multipliers filter, the plain list is used without non-Multiplier groups", async () => {
  const ctx = await ready(setup({ over: { active_symbols: (req) => {
    if (req.contract_type) throw new Error("Input validation failed: contract_type");
    return { active_symbols: [...ACTIVE_SYMBOLS, { underlying_symbol: "OTC_DJI", display_name: "Wall Street 30", market: "indices", exchange_is_open: 1 }] };
  } } }));
  try {
    const names = ctx.engine.status().symbols.map(([v]) => v);
    assert.deepEqual(names, ["R_75", "frxEURUSD", "frxXAUUSD"]);
  } finally { ctx.cleanup(); }
});
