// Deriv's stake limit (server/engine.mjs #order, stakeLimit): when Deriv refuses a stake as
// too big, the trade is scaled down to the limit and asked once more, and the limit is kept.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingEngine, stakeLimit } from "../server/engine.mjs";
import { FileStore } from "../server/store.mjs";

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

const maxStake = (max) => ({ proposal: (req) => {
  if (req.amount > max) throw new Error(`Maximum stake allowed is ${max.toFixed(2)}.`);
  return { proposal: { id: "propX", ask_price: req.amount, commission: 0.25, spot: 1000.5 } };
} });

test("stakeLimit reads Deriv's refusal", () => {
  assert.deepEqual(stakeLimit("Maximum stake allowed is 2000.00."), { max: 2000 });
  assert.deepEqual(stakeLimit("Maximum stake allowed is 1,500."), { max: 1500 });
  assert.equal(stakeLimit("Insufficient balance"), null);
  assert.equal(stakeLimit(undefined), null);
});

test("a stake over Deriv's limit is capped, its stop loss and target scaled, and the trade goes through", async () => {
  const ctx = await setup({ over: maxStake(150) });
  const { engine, sock } = ctx;
  try {
    engine.start();
    engine.autoScan([setup1()]);
    await flush(12);
    const props = sentOf(sock, "proposal");
    assert.deepEqual(props.map((p) => p.amount), [200.2, 150]);
    const k = 150 / 200.2;
    assert.deepEqual(props[1].limit_order, { stop_loss: Math.round(100 * k * 100) / 100, take_profit: Math.round(200 * k * 100) / 100 });
    assert.equal(sentOf(sock, "buy").length, 1);
    assert.equal(logged(engine, /^Stake capped at 150\.00 USD/).length, 1);
    assert.equal(logged(engine, /refused/).length, 0);
    assert.equal(engine.symbolInfo.get("R_100").maxStake, 150, "kept for the next trade on R_100");
  } finally { ctx.cleanup(); }
});

test("other refusals are not retried", async () => {
  const ctx = await setup({ over: { proposal: () => { throw new Error("Insufficient balance"); } } });
  const { engine, sock } = ctx;
  try {
    engine.start();
    engine.autoScan([setup1()]);
    await flush(12);
    assert.equal(sentOf(sock, "proposal").length, 1);
    assert.equal(sentOf(sock, "buy").length, 0);
    assert.equal(logged(engine, /^Deriv refused the BUY order Insufficient balance/).length, 1);
  } finally { ctx.cleanup(); }
});
