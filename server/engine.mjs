// Tbot server engine: the browser bot's trading logic (public/js/app.js) without the page,
// so it can run 24/7 on a server. It uses the same strategy, sizing, risk-limit and Deriv
// modules as the browser, and trades the same way: one evaluation per closed M1 bar,
// proposal then buy with underlying_symbol and limit_order, open trades tracked with
// proposal_open_contract, the daily loss limit checked on equity, time exits for the AI.
//
// What the server adds: settings, state and the activity log live in files, so after a
// crash, reboot or update the bot resumes on its own and picks up its open trades again.
import { readFileSync } from "node:fs";
import { CONFIG, SYMBOLS } from "../public/js/config.js";
import { evaluateRules, evaluateAI, RULES_DEFAULTS, AI_DEFAULTS, rulesMinBars } from "../public/js/strategy.js";
import { sizeMultiplier, RiskGuard } from "../public/js/risk.js";
import { getAccounts, createDemoAccount, getTradingSocketUrl, DerivSocket, cleanAppId } from "../public/js/deriv.js";

export const HISTORY_BARS = 1200;
const DEFAULT_MULTIPLIERS = [10, 20, 30, 40, 50, 100, 200, 300, 400];
const LOG_KEEP = 500;                 // entries kept in memory (the file keeps 2000)
const SYMBOL_NAMES = Object.fromEntries(SYMBOLS);
const PENDING_BUY_CHECKS_MS = [5000, 15000, 45000, 90000];   // re-checks after a buy that may have gone through
const SETTLE_MS = 15000;              // after a close, wait this long at most for the new balance
const WATCHDOG_TICK_MS = 30000;
const FEED_QUIET_MS = 3 * 60000;      // synthetic indices tick every 1-2 s, so 3 quiet minutes means the feed is stuck

// ------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  symbol: "R_75", strategy: "rules", mode: "auto",
  riskPct: 1, maxDailyLossPct: 3, maxOpen: 1, maxTradesPerDay: 20, maxConsecLosses: 3, cooldownMinutes: 15,
  multiplier: 0, signalGap: 8,
  aiThreshold: 0.55, aiBarrier: AI_DEFAULTS.barrierATR, aiHorizon: AI_DEFAULTS.horizonBars,
  allowReal: false,
};

const NUMBERS = {
  riskPct:         { min: 0.1, max: 5, label: "Risk per trade" },
  maxDailyLossPct: { min: 0.5, max: 20, label: "Daily loss limit" },
  maxOpen:         { min: 1, max: 5, int: true, label: "Max open trades" },
  maxTradesPerDay: { min: 1, max: 500, int: true, label: "Max trades per day" },
  maxConsecLosses: { min: 0, max: 20, int: true, label: "Losses in a row before a pause" },
  cooldownMinutes: { min: 0, max: 1440, int: true, label: "Pause length" },
  multiplier:      { min: 0, max: 5000, int: true, label: "Multiplier" },
  signalGap:       { min: 0, max: 240, int: true, label: "Minutes between signals" },
  aiThreshold:     { min: 0.34, max: 0.95, label: "AI confidence" },
  aiBarrier:       { min: 0.5, max: 10, label: "AI stop distance" },
  aiHorizon:       { min: 5, max: 240, int: true, label: "AI time limit" },
};
const CHOICES = {
  symbol: SYMBOLS.map(([v]) => v),
  strategy: ["rules", "ai"],
  mode: ["auto", "signals"],
};

/**
 * Checks a partial settings update. Numbers are clamped to safe ranges. Turning on real
 * money needs confirmReal: "REAL" in the same update. Returns {settings, errors}.
 */
export function cleanSettings(input, current = DEFAULT_SETTINGS) {
  const out = {}, errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { settings: out, errors: ["Settings must be an object."] };
  for (const [k, v] of Object.entries(input)) {
    if (NUMBERS[k]) {
      const spec = NUMBERS[k];
      let n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) { errors.push(`${spec.label} must be a number.`); continue; }
      n = Math.min(spec.max, Math.max(spec.min, n));
      out[k] = spec.int ? Math.round(n) : Math.round(n * 1000) / 1000;
    } else if (CHOICES[k]) {
      if (!CHOICES[k].includes(v)) { errors.push(`Unknown ${k}.`); continue; }
      out[k] = v;
    } else if (k === "allowReal") {
      if (typeof v !== "boolean") { errors.push("Allow real money must be on or off."); continue; }
      if (v && !current.allowReal && String(input.confirmReal ?? "").trim() !== "REAL") {
        errors.push("To allow real money, type REAL in the box first."); continue;
      }
      out[k] = v;
    }
    // anything else (confirmReal, unknown keys) is ignored
  }
  return { settings: out, errors };
}

/** Settings read from disk: anything odd falls back to the default. */
function loadSettings(raw) {
  const { settings } = cleanSettings({ ...raw, allowReal: undefined }, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...settings, allowReal: raw?.allowReal === true };
}

// ----------------------------------------------------------------- helpers
export class UserError extends Error {
  constructor(message, status = 409, code = "refused") { super(message); this.status = status; this.code = code; }
}

const isTokenError = (e) => !!(e && (e.auth || e.status === 401 || e.status === 403));
const fmtNum = (v) => (Number.isFinite(v) ? v.toFixed(Math.abs(v) > 1000 ? 2 : Math.abs(v) >= 10 ? 3 : 5) : "–");
const TOKEN_MSG = {
  401: "Deriv did not accept your token. It may have expired or been deleted. Please add a new token under Deriv connection.",
  403: "Deriv refused access with this token. Make a new token with the Trade permission and add it under Deriv connection.",
};

export class TradingEngine {
  /**
   * @param {object} o
   * @param {object} o.cfg            Deriv addresses: {apiUrl, publicWs}; appId comes from the saved credentials
   * @param {FileStore} o.store       settings, state, secret, guard storage and log
   * @param {function} [o.log]        called with every activity log entry (e.g. to print it)
   * @param {function} [o.socketFactory] (urlProvider, {onStatus, onError}) => DerivSocket-like object
   * @param {function} [o.now]        clock in ms (tests use a fake one)
   */
  constructor({ cfg = {}, store, log = () => {}, socketFactory, now = Date.now, modelPath } = {}) {
    this.cfg = { ...CONFIG, ...cfg };
    this.store = store;
    this.sink = log;
    this.socketFactory = socketFactory || ((urlProvider, handlers) => new DerivSocket(urlProvider, handlers));
    this.now = now;
    this.modelPath = modelPath ?? new URL("../public/model/tbotai-model.json", import.meta.url);

    this.settings = loadSettings(store.getSettings());
    this.state = { running: false, accountId: null, lastSignalEpoch: 0, lastTradeEpoch: 0, openMeta: {},
                   tokenRejected: false, tokenError: 401, ...store.getState() };
    if (!this.state.openMeta || typeof this.state.openMeta !== "object") this.state.openMeta = {};
    this.secret = store.getSecret();

    this.logs = [];
    this.seq = 0;
    this.lastLogged = new Map();         // title -> time, for logOnce
    this.accounts = []; this.account = null; this.socket = null; this.trading = false; this.feed = "none";
    this.bars = []; this.forming = null; this.balance = NaN; this.currency = "USD";
    this.multipliers = DEFAULT_MULTIPLIERS; this.minStake = 1; this.maxStake = Infinity;
    this.running = false; this.model = null; this.guard = null;
    this.contracts = new Map();          // contract_id -> {side, entryEpoch, horizon, profit, buyPrice, sub, opened}
    this.busy = false;                   // an order is in flight
    this.syncing = false;                // open trades not loaded yet after (re)connecting
    this.connection = "idle"; this.error = ""; this.needsToken = !!this.state.tokenRejected;
    this.lastEval = null; this.lastCost = null; this.lastPriceAt = 0;
    // The latest signal is kept in state.json, so the page still shows it after a restart.
    this.lastSignal = this.state.lastSignal && typeof this.state.lastSignal === "object" ? this.state.lastSignal : null;
    this.resumedAt = 0;
    this.retryTimer = null; this.retryDelay = 5000; this.pfTimer = null;
    this.settling = 0;                   // a trade just closed; the daily loss check waits for the new balance
    this.pendingBuy = null;              // a buy that may have gone through: {checks, meta}
    this.balanceDropped = false;         // the balance fell while an order was in flight
    this.onlineAt = 0; this.watchdogTimer = null;
    this.closed = false;
  }

  // ------------------------------------------------------------- startup
  async init() {
    this.#loadModel();
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_TICK_MS);
    this.watchdogTimer.unref?.();
    for (const e of this.store.readLog(LOG_KEEP)) { this.logs.push(e); this.seq = Math.max(this.seq, Number(e.seq) || 0); }
    const canTrade = !!this.secret && !this.state.tokenRejected;
    if (this.state.tokenRejected) { this.needsToken = true; this.error = TOKEN_MSG[this.state.tokenError] || TOKEN_MSG[401]; }
    if (this.state.running) {
      if (this.settings.mode === "auto" && !canTrade) {
        this.#setRunning(false);
        this.log("INFO", "The bot was running before the restart, but it has no working Deriv token, so it stays stopped.");
      } else {
        this.running = true;
        this.resumedAt = this.now();
        this.log("INFO", "Resumed after a restart", `${this.#describeRun()}. It keeps running until you press Stop.`);
      }
    }
    if (canTrade) await this.connectDeriv();
    else this.connectPublic();
  }

  #loadModel() {
    try { this.model = JSON.parse(readFileSync(this.modelPath, "utf8")); }
    catch { this.model = null; this.log("INFO", "The AI model could not be loaded, so only the rules strategy works."); }
  }

  auth() { return { kind: "pat", token: this.secret?.token || "" }; }
  #derivCfg(appId = this.secret?.appId) { return { ...this.cfg, appId: cleanAppId(appId) }; }

  /** Lists the accounts with the saved token and connects to the chosen one. */
  async connectDeriv() {
    clearTimeout(this.retryTimer);
    const secret = this.secret;
    if (!secret || this.closed) return false;
    // The token can be removed or replaced while Deriv is answering; then this answer is stale.
    const stale = () => this.closed || this.secret !== secret;
    const cfg = this.#derivCfg(secret.appId), auth = { kind: "pat", token: secret.token };
    let accounts;
    try {
      accounts = await getAccounts(cfg, auth);
      if (stale()) return false;
      if (!accounts.length) accounts = await this.#ensureAccount(cfg, auth);
    } catch (e) {
      if (stale()) return false;
      if (isTokenError(e)) { this.tokenRejected(e); return false; }
      this.connection = "offline";
      if (e.code === "no_account") {
        // The user has to create the account at Deriv; look again every few minutes.
        this.error = e.message;
        this.logOnce("ERROR", "No Options trading account yet", e.message);
        this.retryTimer = setTimeout(() => this.connectDeriv(), 5 * 60000);
        return false;
      }
      this.error = "Can't reach Deriv right now. The bot keeps trying by itself.";
      this.logOnce("ERROR", "Can't reach Deriv right now", e.message);
      this.retryTimer = setTimeout(() => this.connectDeriv(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60000);
      return false;
    }
    if (stale()) return false;
    this.retryDelay = 5000;
    this.error = "";
    this.accounts = accounts;
    const pick = this.#pickAccount();
    if (!pick) {
      this.error = "There is no demo account on this Deriv login. Turn on Allow real money only if you really mean to trade real money.";
      this.log("ERROR", "No demo account found");
      this.connectPublic();
      return false;
    }
    if (this.state.accountId && pick.id !== this.state.accountId) {
      const saved = accounts.find((a) => a.id === this.state.accountId);
      if (saved?.type === "real") this.log("INFO", `Real money is off, so using demo account ${pick.id}`);
    }
    this.connectAccount(pick);
    return true;
  }

  async #ensureAccount(cfg, auth) {
    this.log("INFO", "No Options account yet, so creating your demo account");
    try {
      const created = await createDemoAccount(cfg, auth);
      return created.length ? created : await getAccounts(cfg, auth);
    } catch (e) {
      if (isTokenError(e) && e.status === 401) throw e;
      throw Object.assign(new Error(`Your Deriv login has no Options trading account yet, and creating a demo one failed (${e.message}). Open Deriv's trading site once to create it, then try again.`),
                          { code: "no_account" });
    }
  }

  #pickAccount() {
    const allowed = (a) => a.type === "demo" || this.settings.allowReal;
    const list = this.accounts;
    return list.find((a) => a.id === this.state.accountId && allowed(a)) ||
           list.find((a) => a.type === "demo" && a.active) || list.find((a) => a.type === "demo") ||
           (this.settings.allowReal ? list[0] : null) || null;
  }

  connectPublic() {
    if (this.closed) return;
    this.untrackAll();
    this.pendingBuy = null;
    this.trading = false; this.account = null; this.guard = null; this.balance = NaN; this.feed = "public";
    this.#makeSocket(async () => this.cfg.publicWs);
  }

  connectAccount(account) {
    if (this.closed) return;
    this.untrackAll();
    const same = this.trading && this.account?.id === account.id;
    if (!same) this.pendingBuy = null;
    this.account = account;
    this.trading = true;
    this.feed = "account";
    this.currency = account.currency || "USD";
    // On a reconnect to the same account, keep the live balance: the account list may be hours old.
    if (!same || !Number.isFinite(this.balance)) this.balance = account.balance;
    this.guard = new RiskGuard(this.store.guardStorage, account.id, this.limits());
    // The browser updates the guard here; the server waits until the open trades are loaded,
    // so a stake that is out in an open trade doesn't look like a loss after a restart.
    if (this.state.accountId !== account.id) { this.state.accountId = account.id; this.#saveState(); }
    this.#makeSocket(() => getTradingSocketUrl(this.#derivCfg(), this.auth(), account.id));
  }

  limits() {
    const s = this.settings;
    return { maxDailyLossPct: +s.maxDailyLossPct, maxOpen: +s.maxOpen, maxTradesPerDay: +s.maxTradesPerDay,
             maxConsecLosses: +s.maxConsecLosses, cooldownMinutes: +s.cooldownMinutes };
  }

  // ---------------------------------------------------------- connection
  #makeSocket(urlProvider) {
    this.socket?.close();
    clearTimeout(this.pfTimer);
    this.syncing = this.trading;
    this.connection = "connecting";
    const sock = this.socketFactory(urlProvider, {
      onStatus: (s) => {
        if (this.socket !== sock) return;
        this.connection = s;
        if (s === "online") { this.onlineAt = this.now(); this.#onOnline(sock); }
        else if (this.trading) this.syncing = true;    // open trades must be re-checked after a reconnect
      },
      onError: (e) => { if (this.socket === sock) this.#onSocketError(e); },
    });
    this.socket = sock;
    sock.subscribe({ ticks_history: this.settings.symbol, style: "candles", granularity: 60, count: HISTORY_BARS,
                     end: "latest", adjust_start_time: 1 }, (msg) => this.onCandles(msg));
    if (this.trading) {
      sock.subscribe({ balance: 1 }, (msg) => {
        if (!msg.balance || this.socket !== sock) return;
        const prev = this.balance;
        this.balance = Number(msg.balance.balance);
        this.currency = msg.balance.currency || this.currency;
        this.settling = 0;               // this balance includes any trade that just closed
        // Only a new trade takes money out of the balance. If it isn't one the bot is
        // tracking (opened by hand on Deriv, or a slow buy), load the open trades again
        // before the daily loss check, so its stake doesn't look like a loss.
        if (this.balance < prev - 1e-9) {
          if (this.busy) { this.balanceDropped = true; return; }
          if (!this.syncing && this.connection === "online") { this.syncing = true; this.#syncPortfolio(sock); return; }
        }
        this.checkGuard();
      });
    }
    sock.connect();
  }

  #onSocketError(e) {
    if (isTokenError(e)) { this.tokenRejected(e); return; }
    this.logOnce("ERROR", e.message);
  }

  async #onOnline(sock) {
    try {
      const r = await sock.send({ contracts_for: this.settings.symbol });
      const items = r.contracts_for?.available || [];
      const mult = items.find((a) => /MULT/.test(a.contract_type) || a.contract_category === "multiplier");
      if (mult?.multiplier_range?.length) this.multipliers = mult.multiplier_range.map(Number).sort((a, b) => a - b);
      if (mult?.min_stake) this.minStake = Number(mult.min_stake);
      if (mult?.max_stake) this.maxStake = Number(mult.max_stake);
    } catch { /* defaults stay; the proposal will report any limit */ }
    if (this.trading && this.socket === sock) await this.#syncPortfolio(sock);
  }

  /**
   * Picks up every open Multiplier trade on the account (after a reconnect, restart or update,
   * after a buy that may have gone through, or when the balance drops for a trade the bot
   * doesn't know). Trades on another market are tracked too, so their stake is never
   * counted as a loss. Trades that closed while the bot wasn't watching are looked up once,
   * so their result still counts for the losing-streak pause.
   */
  async #syncPortfolio(sock) {
    clearTimeout(this.pfTimer);
    try {
      const pf = await sock.send({ portfolio: 1 });
      if (this.socket !== sock || this.closed) return;
      const seen = new Set(), found = [];
      for (const c of pf.portfolio?.contracts || []) {
        if (!/MULT/.test(c.contract_type)) continue;
        const id = String(c.contract_id);
        seen.add(id);
        if (this.contracts.has(id)) continue;
        found.push(id);
        const symbol = c.underlying_symbol ?? c.symbol ?? this.state.openMeta[id]?.symbol;
        const pb = this.pendingBuy;
        if (pb && !this.state.openMeta[id] && symbol === pb.meta.symbol) {
          // The order that "timed out" did go through: track it with its time limit.
          this.pendingBuy = null;
          this.guard?.recordEntry();
          this.trackContract(id, { ...pb.meta, symbol });
          this.log("INFO", `Your ${pb.meta.side} order did go through at Deriv (trade ${id})`);
        } else {
          const known = !!this.state.openMeta[id];
          this.trackContract(id, { ...this.state.openMeta[id], symbol });
          this.log("INFO", known ? `Watching open trade ${id} again` : `Found open trade ${id} on ${SYMBOL_NAMES[symbol] || symbol || "another market"}`,
                   known ? "" : "The bot watches it so its stake isn't counted as a loss.");
        }
      }
      // Trades the bot opened that Deriv no longer lists closed while it wasn't watching.
      // One look at each gives its final result, which goes through the normal close path.
      for (const id of Object.keys(this.state.openMeta))
        if (!seen.has(id) && !this.contracts.has(id)) this.trackContract(id, { ...this.state.openMeta[id], stale: true });
      if (this.pendingBuy) {
        const pb = this.pendingBuy;
        if (pb.checks < PENDING_BUY_CHECKS_MS.length) {
          // Deriv may still be booking it: look again a little later, and trade nothing meanwhile.
          this.pfTimer = setTimeout(() => { if (this.socket === sock && this.connection === "online") this.#syncPortfolio(sock); },
                                    PENDING_BUY_CHECKS_MS[pb.checks++]);
          return;
        }
        this.pendingBuy = null;
        this.log("INFO", `Your ${pb.meta.side} order did not go through at Deriv, so no trade was opened`);
      }
      this.syncing = false;
      this.checkGuard();
      this.haltExits();
    } catch (e) {
      if (this.socket !== sock || this.closed) return;
      this.logOnce("ERROR", "Couldn't load your open trades. New trades wait until they load.", e.message);
      this.pfTimer = setTimeout(() => { if (this.socket === sock && this.connection === "online") this.#syncPortfolio(sock); }, 15000);
    }
  }

  /** Deriv rejected the token: stop trading until the user adds a new one. */
  tokenRejected(e) {
    const status = e?.status === 403 ? 403 : 401;
    const wasRunning = this.running;
    this.#setRunning(false);
    this.state.tokenRejected = true;
    this.state.tokenError = status;
    this.#saveState();
    this.needsToken = true;
    this.error = TOKEN_MSG[status];
    this.log("ERROR", status === 403 ? "Deriv refused access with your token" : "Deriv did not accept your token",
             wasRunning ? "The bot stopped. Open trades keep their stop loss and take profit." : "");
    this.accounts = [];
    this.connectPublic();
  }

  // --------------------------------------------------------------- market
  static normBar(c) {
    return { epoch: Number(c.epoch ?? c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close };
  }

  onCandles(msg) {
    if (msg.error) return;
    if (msg.msg_type === "candles") {
      const all = (msg.candles || []).map(TradingEngine.normBar);
      this.forming = all.pop() || null;
      this.bars = all;
      this.lastPriceAt = this.now();
      this.evaluate(false);
    } else if (msg.msg_type === "ohlc") {
      const o = msg.ohlc;
      const bar = { epoch: Number(o.open_time), open: +o.open, high: +o.high, low: +o.low, close: +o.close };
      this.lastPriceAt = this.now();
      if (!this.forming || bar.epoch > this.forming.epoch) {
        if (this.forming) {
          this.bars.push(this.forming);
          if (this.bars.length > HISTORY_BARS * 1.5) this.bars.splice(0, this.bars.length - HISTORY_BARS);
          this.forming = bar;
          this.onBarClosed();
        } else this.forming = bar;
      } else if (bar.epoch === this.forming.epoch) this.forming = bar;
    }
  }

  lastPrice() { return this.forming?.close ?? this.bars.at(-1)?.close ?? NaN; }

  strategyParams() {
    const s = this.settings;
    return s.strategy === "ai"
      ? { threshold: +s.aiThreshold, margin: AI_DEFAULTS.margin, barrierATR: +s.aiBarrier, horizonBars: +s.aiHorizon }
      : RULES_DEFAULTS;
  }

  evaluate(actOnSignal) {
    if (!this.bars.length) return null;
    const res = this.settings.strategy === "ai" ? evaluateAI(this.bars, this.model, this.strategyParams())
                                                : evaluateRules(this.bars, this.strategyParams());
    this.lastEval = { action: res.action || null, reason: res.reason || "", sees: this.#describe(res),
                      at: this.now(), barEpoch: this.bars.at(-1).epoch, strategy: this.settings.strategy };
    if (actOnSignal && res.action) this.handleSignal(res).catch((e) => this.log("ERROR", "Signal handling failed", e.message));
    return res;
  }

  #describe(res) {
    const i = res.info || {};
    if (i.note) return i.note === "loading history" ? "Loading price history" : i.note === "model not loaded" ? "AI model not loaded" : i.note;
    return this.settings.strategy === "ai"
      ? `up ${(i.pUp * 100).toFixed(0)}% · down ${(i.pDn * 100).toFixed(0)}% · flat ${(i.pNone * 100).toFixed(0)}%`
      : `${i.regime} · ADX ${i.adx?.toFixed(0)} · RSI ${i.rsi?.toFixed(0)}`;
  }

  onBarClosed() {
    this.timeExits();
    this.checkGuard();          // also starts a new day for the limits, even if nothing else changes
    this.haltExits();
    if (!this.running) { this.evaluate(false); return; }
    this.evaluate(true);
  }

  // -------------------------------------------------------------- signals
  chooseMultiplier() {
    const m = +this.settings.multiplier;
    return this.multipliers.includes(m) ? m : this.multipliers[0];
  }

  #money(v) { return Number.isFinite(v) ? `${v.toFixed(2)} ${this.currency}` : "–"; }

  async handleSignal(sig) {
    const s = this.settings;
    const lastBar = this.bars.at(-1);
    const entry = lastBar.close;
    const gapMin = s.mode === "signals" ? Math.max(+s.signalGap, sig.horizonBars || 0) : 0;
    if (gapMin && lastBar.epoch - (this.state.lastSignalEpoch || 0) < gapMin * 60) return;

    const mult = this.chooseMultiplier();
    const size = Number.isFinite(this.balance)
      ? sizeMultiplier({ balance: this.balance, riskPct: +s.riskPct, entry, slDist: sig.slDist, tpDist: sig.tpDist,
                         multiplier: mult, minStake: this.minStake, maxStake: this.maxStake })
      : null;
    const up = sig.action === "BUY";
    const sl = up ? entry - sig.slDist : entry + sig.slDist, tp = up ? entry + sig.tpDist : entry - sig.tpDist;
    const sizeText = size?.ok ? `stake ${this.#money(size.stake)} at x${mult} · risk ${this.#money(size.stopLoss)} · target ${this.#money(size.takeProfit)}`
                   : size ? size.reason : "add your Deriv token to see the stake for your balance";
    const signal = { action: sig.action, symbol: s.symbol, entry, sl, tp, sizeText, reason: sig.reason || "", at: this.now(), barEpoch: lastBar.epoch };

    if (s.mode === "signals") {
      this.state.lastSignalEpoch = lastBar.epoch;
      this.lastSignal = this.state.lastSignal = { ...signal, traded: false };
      this.#saveState();
      this.log(sig.action, `${sig.action} ${s.symbol} @ ${fmtNum(entry)}`, `SL ${fmtNum(sl)} · TP ${fmtNum(tp)} · ${sizeText} · ${sig.reason}`);
      return;
    }

    // ---- auto trade
    if (!this.trading) { this.logOnce("ERROR", "Auto trade needs your Deriv account. Add your token under Deriv connection."); return; }
    if (this.syncing) { this.log("INFO", `Skipped ${sig.action}: still checking your open trades`); return; }
    if (lastBar.epoch <= (this.state.lastTradeEpoch || 0)) return;   // already traded on this bar
    const blocked = this.guard.blockReason(this.openCount(), this.now());
    if (blocked) { this.log("INFO", `Skipped ${sig.action}: ${blocked}`); return; }
    if (!size?.ok) { this.log("INFO", `Skipped ${sig.action}`, size?.reason || "balance not known yet"); return; }
    if (this.busy) return;
    this.busy = true;
    const sock = this.socket;
    let stage = "proposal";
    try {
      const p = await sock.send({
        proposal: 1, amount: size.stake, basis: "stake", contract_type: up ? "MULTUP" : "MULTDOWN",
        currency: this.currency, underlying_symbol: s.symbol, multiplier: mult, duration_unit: "s",
        limit_order: { stop_loss: size.stopLoss, take_profit: size.takeProfit },
      });
      const prop = p.proposal;
      const commission = Number(prop.commission ?? prop.contract_details?.commission ?? NaN);
      if (Number.isFinite(commission)) this.lastCost = { commission, r: commission / size.stopLoss, currency: this.currency };
      if (!this.running || this.closed || this.socket !== sock) { this.log("INFO", `Skipped ${sig.action}: the bot was stopped`); return; }
      stage = "buy";
      const b = await sock.send({ buy: prop.id, price: Number(prop.ask_price ?? size.stake) });
      const buy = b.buy;
      this.guard.recordEntry();
      this.state.lastSignalEpoch = lastBar.epoch;
      this.state.lastTradeEpoch = lastBar.epoch;
      this.lastSignal = this.state.lastSignal = { ...signal, traded: true };
      this.trackContract(buy.contract_id, { side: sig.action, entryEpoch: lastBar.epoch, horizon: sig.horizonBars || 0,
                                            buyPrice: Number(buy.buy_price), symbol: s.symbol });
      this.log(sig.action, `Opened ${sig.action} ${s.symbol}`,
               `${sizeText} · ${sig.reason}${Number.isFinite(commission) ? ` · commission ${this.#money(commission)}` : ""}`);
    } catch (e) {
      this.log("ERROR", `Deriv refused the ${sig.action} order`, e.message);
      if (stage === "buy" && /closed|timed out|not connected/i.test(e.message)) {
        // The buy may have gone through. Never retry this bar, and reload the open trades first.
        this.state.lastTradeEpoch = lastBar.epoch;
        this.#saveState();
        if (this.socket === sock && this.trading) {
          // Deriv can book a slow order after the first look, so look a few more times.
          this.pendingBuy = { checks: 0, meta: { side: sig.action, entryEpoch: lastBar.epoch, horizon: sig.horizonBars || 0, symbol: s.symbol } };
          this.syncing = true;
          if (this.connection === "online") this.#syncPortfolio(sock);
        }
      }
    } finally {
      this.busy = false;
      if (this.balanceDropped) {
        this.balanceDropped = false;
        if (this.socket === sock && this.trading && !this.syncing && this.connection === "online") { this.syncing = true; this.#syncPortfolio(sock); }
      }
    }
  }

  // ------------------------------------------------------------ contracts
  /** Balance plus what open trades are worth now (stakes are taken from the balance while open). */
  equity() {
    let e = this.balance;
    for (const c of this.contracts.values()) if (!c.stale) e += c.buyPrice + (c.profit || 0);
    return e;
  }

  /** Open trades (not counting closed ones the bot is only looking up). */
  openCount() { let n = 0; for (const c of this.contracts.values()) if (!c.stale) n++; return n; }

  /**
   * Daily loss limit on equity. Skipped while an order is in flight, open trades are loading,
   * or a trade has just closed and Deriv hasn't sent the new balance yet.
   */
  checkGuard() {
    if (!this.guard || this.busy || this.syncing || !Number.isFinite(this.equity())) return;
    if (this.settling && this.now() - this.settling < SETTLE_MS) return;
    this.settling = 0;
    const { justHalted } = this.guard.update(this.equity(), this.now());
    if (justHalted) {
      this.log("ERROR", `Stopped for today: ${this.guard.state.haltReason}`, "Open trades are being closed. The bot starts again tomorrow (UTC).");
      this.haltExits();
    }
  }

  /** While halted for today: close every open trade, and try again next bar if Deriv didn't close one. */
  haltExits() {
    const g = this.guard;
    if (!g?.state.halted || this.syncing || g.state.day !== new Date(this.now()).toISOString().slice(0, 10)) return;
    for (const [id, c] of this.contracts) if (!c.closing && !c.stale) {
      c.closing = true;
      this.closeContract(id, "daily loss limit").then((ok) => { if (!ok) c.closing = false; });   // retried next bar
    }
  }

  trackContract(id, meta) {
    id = String(id);
    if (this.contracts.has(id)) return;
    const c = { side: "?", profit: 0, buyPrice: NaN, horizon: 0, entryEpoch: 0, opened: 0, ...meta };
    this.contracts.set(id, c);
    if ((meta.side || meta.horizon) && !c.stale) {
      this.state.openMeta[id] = { side: c.side, entryEpoch: c.entryEpoch, horizon: c.horizon, symbol: c.symbol };
      this.#saveState();
    }
    const sock = this.socket;
    c.sub = sock.subscribe({ proposal_open_contract: 1, contract_id: Number(id) || id }, (msg) => {
      if (this.contracts.get(id) !== c) return;
      if (msg.error) {
        if (/ContractNotFound|InvalidContract/i.test(msg.error.code || "")) this.#forget(id, c);
        return;
      }
      const poc = msg.proposal_open_contract;
      if (!poc || !Object.keys(poc).length) return;
      c.profit = Number(poc.profit ?? c.profit);
      c.buyPrice = Number(poc.buy_price ?? c.buyPrice);
      if (!c.opened && poc.date_start) c.opened = Number(poc.date_start) * 1000;
      if (c.side === "?") c.side = String(poc.contract_type).includes("DOWN") ? "SELL" : "BUY";
      const sold = poc.is_sold === 1 || poc.is_sold === true || ["sold", "won", "lost"].includes(poc.status);
      if (sold) {
        this.#forget(id, c);
        const soldAt = Number(poc.sell_time) > 0 ? Math.min(Number(poc.sell_time) * 1000, this.now()) : this.now();
        this.guard?.recordClose(c.profit, soldAt);
        this.log(c.profit >= 0 ? "WIN" : "LOSS", `Closed ${c.side} ${c.symbol || this.settings.symbol}: ${c.profit >= 0 ? "+" : ""}${this.#money(c.profit)}`,
                 [c.stale ? "it closed while the bot wasn't watching" : "", poc.exit_tick_display_value ? `exit ${poc.exit_tick_display_value}` : ""].filter(Boolean).join(" · "));
        // The payout may reach the balance stream after this message: wait for it before the loss check.
        if (!c.stale) this.settling = this.now();
      }
      this.checkGuard();
    });
    if (!c.opened) c.opened = c.entryEpoch ? (c.entryEpoch + 60) * 1000 : 0;
  }

  #forget(id, c) {
    c.sub?.unsubscribe();
    this.contracts.delete(id);
    if (this.state.openMeta[id]) { delete this.state.openMeta[id]; this.#saveState(); }
  }

  /** Forgets the tracked trades of an old connection (they stay open at Deriv). */
  untrackAll() {
    for (const c of this.contracts.values()) { try { c.sub?.unsubscribe(); } catch { /* socket gone */ } }
    this.contracts.clear();
  }

  async closeContract(id, why) {
    if (!this.socket || this.connection !== "online") {
      this.log("ERROR", "Close failed", "The bot isn't connected to Deriv right now. It keeps trying to reconnect.");
      return false;
    }
    try {
      await this.socket.send({ sell: Number(id) || id, price: 0 });
      this.log("INFO", `Closing trade (${why})`);
      return true;
    } catch (e) {
      this.log("ERROR", "Close failed", e.message);
      return false;
    }
  }

  timeExits() {
    const last = this.bars.at(-1);
    if (!last) return;
    for (const [id, c] of this.contracts)
      if (c.horizon && last.epoch - c.entryEpoch >= c.horizon * 60 && !c.closing && !c.stale) {
        c.closing = true;
        this.closeContract(id, `${c.horizon} min time limit`).then((ok) => { if (!ok) c.closing = false; });   // retried next bar
      }
  }

  closeAll(why) { return Promise.all([...this.contracts].filter(([, c]) => !c.stale).map(([id]) => this.closeContract(id, why))); }

  // ------------------------------------------------------------- run/stop
  #describeRun() {
    const s = this.settings;
    return `${s.strategy === "ai" ? "AI model" : "rules"}, ${s.mode === "auto" ? "auto trade" : "signals only"}, ${SYMBOL_NAMES[s.symbol] || s.symbol}`;
  }

  #setRunning(on) {
    this.running = on;
    this.state.running = on;
    if (on) this.state.startedAt = this.now();
    this.#saveState();
  }

  start() {
    if (this.running) return;
    const s = this.settings;
    if (s.mode === "auto") {
      if (!this.secret) throw new UserError("Add your Deriv token first, so the bot can trade on your account.");
      if (this.needsToken) throw new UserError(this.error || TOKEN_MSG[401]);
      if (!this.trading || !this.account) throw new UserError("The bot isn't connected to your Deriv account yet. Please wait a moment and try again.");
      if (this.account.type === "real" && !s.allowReal) throw new UserError("This is a real money account. Turn on Allow real money first.");
    }
    this.#setRunning(true);
    this.log("INFO", `Bot started: ${this.#describeRun()}`,
             this.account ? `${this.account.type === "demo" ? "Demo" : "REAL"} account ${this.account.id}` : "Prices only, no account");
    if (s.strategy === "rules" && this.bars.length < rulesMinBars()) this.log("INFO", "Waiting for enough price history");
  }

  stop() {
    if (!this.running) return;
    this.#setRunning(false);
    this.resumedAt = 0;
    this.log("INFO", "Bot stopped. Open trades keep their stop loss and take profit.");
  }

  // ------------------------------------------------------------- settings
  /** Applies an already cleaned partial settings object. */
  updateSettings(partial) {
    const prev = { ...this.settings };
    if (partial.mode && partial.mode !== prev.mode && this.running) throw new UserError("Stop the bot before switching mode.");
    Object.assign(this.settings, partial);
    this.store.saveSettings(this.settings);
    if (this.guard) this.guard.limits = this.limits();
    if (partial.allowReal === true && !prev.allowReal) this.log("INFO", "Real money trading is now allowed");
    if (partial.allowReal === false && prev.allowReal) {
      this.log("INFO", "Real money trading is now off");
      if (this.account?.type === "real") {
        this.stop();
        const demo = this.#pickAccount();
        if (demo) { this.log("INFO", `Switched to demo account ${demo.id}`); this.connectAccount(demo); }
        else this.connectPublic();
      }
    }
    if (partial.symbol && partial.symbol !== prev.symbol) {
      this.stop();
      this.bars = []; this.forming = null; this.lastEval = null; this.lastSignal = null;
      this.state.lastSignal = null;
      this.#saveState();
      this.multipliers = DEFAULT_MULTIPLIERS; this.minStake = 1; this.maxStake = Infinity;
      if (this.trading && this.account) this.connectAccount(this.account); else this.connectPublic();
      this.log("INFO", `Market changed to ${SYMBOL_NAMES[partial.symbol] || partial.symbol}`);
    } else if (partial.strategy && partial.strategy !== prev.strategy) this.evaluate(false);
    return this.settings;
  }

  // --------------------------------------------------------- credentials
  /** Checks the App ID and token by listing the accounts; saves them only if Deriv accepts them. */
  async setCredentials({ appId, token }) {
    appId = cleanAppId(appId);
    token = String(token ?? "").trim();
    if (!appId || !/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new UserError("Paste your Deriv App ID. It has only letters and numbers.", 400, "bad_app_id");
    if (!token || token.length > 512 || /[\s\x00-\x1f]/.test(token)) throw new UserError("Paste your Deriv token. It looks empty or has spaces in it.", 400, "bad_token");
    const cfg = this.#derivCfg(appId), auth = { kind: "pat", token };
    let accounts;
    try {
      accounts = await getAccounts(cfg, auth);
      if (!accounts.length) accounts = await this.#ensureAccount(cfg, auth);
    } catch (e) {
      const said = e.detail ? ` Deriv said: "${e.detail}"` : "";
      if (e.status === 401) throw new UserError(`Deriv did not accept this token and App ID. Check that you copied both completely.${said}`, 400, "token_rejected");
      if (e.status === 403) throw new UserError(`Deriv refused access with this token. Make sure it has the Trade permission.${said}`, 400, "token_forbidden");
      if (e.code === "no_account") throw new UserError(e.message, 400, "no_account");
      throw new UserError(`Couldn't check the token with Deriv (${e.message}). Please try again.`, 502, "deriv_unreachable");
    }
    if (this.closed) throw new UserError("The bot is shutting down.", 503, "closing");
    clearTimeout(this.retryTimer);
    const changedToken = this.secret?.token !== token;
    this.secret = { appId, token };
    this.store.saveSecret(this.secret);
    this.state.tokenRejected = false;
    this.#saveState();
    this.needsToken = false;
    this.error = "";
    this.accounts = accounts;
    this.log("INFO", "Deriv token saved", `${accounts.length} account${accounts.length === 1 ? "" : "s"} found`);
    const pick = this.#pickAccount();
    if (!pick) {
      this.stop();
      this.error = "There is no demo account on this Deriv login. Turn on Allow real money only if you really mean to trade real money.";
      this.connectPublic();
    } else if (changedToken || !this.trading || this.account?.id !== pick.id) {
      if (this.account && this.account.id !== pick.id) this.stop();
      this.connectAccount(pick);
    }
    return { accounts: this.publicAccounts(), account: this.publicAccount() };
  }

  forgetCredentials() {
    this.stop();
    this.secret = null;
    this.store.clearSecret();
    this.state.tokenRejected = false;
    this.#saveState();
    this.needsToken = false;
    this.error = "";
    this.accounts = [];
    clearTimeout(this.retryTimer);
    this.log("INFO", "Deriv token removed from this server");
    this.connectPublic();
  }

  async refreshAccounts() {
    const secret = this.secret;
    if (!secret || this.needsToken) return this.publicAccounts();
    let accounts;
    try {
      accounts = await getAccounts(this.#derivCfg(secret.appId), { kind: "pat", token: secret.token });
    } catch (e) {
      if (this.secret !== secret) return this.publicAccounts();   // the token changed meanwhile
      if (isTokenError(e)) { this.tokenRejected(e); throw new UserError(this.error, 400, "token_rejected"); }
      throw new UserError(`Couldn't reach Deriv (${e.message}). Please try again.`, 502, "deriv_unreachable");
    }
    if (this.secret === secret) this.accounts = accounts;
    return this.publicAccounts();
  }

  selectAccount(id) {
    const a = this.accounts.find((x) => x.id === String(id));
    if (!a) throw new UserError("That account isn't on your Deriv login.", 404, "no_such_account");
    if (a.type === "real" && !this.settings.allowReal) throw new UserError("Real money is off. Turn on Allow real money first.", 403, "real_not_allowed");
    if (this.account?.id === a.id && this.trading) return this.publicAccount();
    this.stop();
    this.state.accountId = a.id;
    this.#saveState();
    this.log("INFO", `Switched to ${a.type === "demo" ? "demo" : "REAL"} account ${a.id}`);
    this.connectAccount(a);
    return this.publicAccount();
  }

  publicAccounts() {
    return this.accounts.map((a) => ({ id: a.id, type: a.type, currency: a.currency, balance: Number.isFinite(a.balance) ? a.balance : null, active: a.active }));
  }

  publicAccount() { return this.account ? { id: this.account.id, type: this.account.type, currency: this.account.currency || this.currency } : null; }

  // ----------------------------------------------------------------- log
  log(tag, title, detail = "") {
    const e = { seq: ++this.seq, t: this.now(), tag, title: String(title), detail: detail ? String(detail) : "" };
    this.logs.push(e);
    if (this.logs.length > LOG_KEEP) this.logs.splice(0, this.logs.length - LOG_KEEP);
    try { this.store.appendLog(e); } catch { /* disk full: keep running */ }
    try { this.sink(e); } catch { /* ignore */ }
    return e;
  }

  /** Like log, but the same message is written at most once per 10 minutes (reconnect noise). */
  logOnce(tag, title, detail = "") {
    const last = this.lastLogged.get(title) || 0;
    if (this.now() - last < 10 * 60000) return null;
    this.lastLogged.set(title, this.now());
    if (this.lastLogged.size > 200) this.lastLogged.clear();
    return this.log(tag, title, detail);
  }

  logsAfter(after = 0, limit = 200) {
    const out = this.logs.filter((e) => e.seq > after);
    return out.slice(-limit);
  }

  // -------------------------------------------------------------- status
  status() {
    const s = this.settings, g = this.guard, now = this.now();
    const eq = this.equity();
    const halted = !!g?.state.halted && g.state.day === new Date(now).toISOString().slice(0, 10);
    const cooldownUntil = g && (g.state.cooldownUntil || 0) > now ? g.state.cooldownUntil : 0;
    const token = this.secret?.token || "";
    return {
      running: this.running,
      mode: s.mode, strategy: s.strategy, symbol: s.symbol, symbolName: SYMBOL_NAMES[s.symbol] || s.symbol,
      connection: this.connection, feed: this.feed,
      account: this.publicAccount(),
      balance: Number.isFinite(this.balance) ? this.balance : null,
      equity: Number.isFinite(eq) ? eq : null,
      currency: this.currency,
      dayPL: g && Number.isFinite(eq) && g.state.startBalance > 0 ? g.dayPL(eq) : null,
      tradesToday: g ? g.state.trades || 0 : 0,
      halted, haltReason: halted ? g.state.haltReason || "" : "",
      cooldownUntil,
      blockReason: g && this.running && s.mode === "auto" ? g.blockReason(this.openCount(), now) : "",
      syncing: this.syncing,
      lastPrice: Number.isFinite(this.lastPrice()) ? this.lastPrice() : null,
      lastPriceAt: this.lastPriceAt || null,
      lastEval: this.lastEval,
      lastSignal: this.lastSignal,
      lastCost: this.lastCost,
      open: [...this.contracts.entries()].filter(([, c]) => !c.stale).map(([id, c]) => ({
        id, side: c.side, symbol: c.symbol || s.symbol, stake: Number.isFinite(c.buyPrice) ? c.buyPrice : null, profit: Number.isFinite(c.profit) ? c.profit : null,
        opened: c.opened || null, horizon: c.horizon || 0, closing: !!c.closing,
      })),
      hasToken: !!token,
      needsToken: this.needsToken,
      tokenHint: token.length >= 8 ? token.slice(-4) : token ? "set" : "",
      appId: this.secret?.appId || "",
      error: this.error,
      modelLoaded: !!this.model,
      multipliers: this.multipliers,
      multiplierInUse: this.chooseMultiplier(),
      accounts: this.publicAccounts(),
      symbols: SYMBOLS,
      settings: { ...s },
      limits: this.limits(),
      startedAt: this.running ? this.state.startedAt || null : null,
      resumedAt: this.running ? this.resumedAt || null : null,
      lastLogSeq: this.seq,
    };
  }

  // ------------------------------------------------------------ watchdog
  /**
   * Runs every 30 s. A socket can stay "online" while Deriv's side has stalled and sends nothing.
   * Then no bar closes, so no time exits, no loss checks and no trades. If the price feed has
   * been quiet for 3 minutes, connect again from scratch (fresh login link, open trades re-loaded).
   */
  watchdog() {
    if (this.closed || this.connection !== "online") return;
    const ref = Math.max(this.lastPriceAt, this.onlineAt);
    if (!ref || this.now() - ref <= FEED_QUIET_MS) return;
    this.log("ERROR", "Deriv's price feed went quiet, so the bot is reconnecting");
    this.lastPriceAt = 0; this.onlineAt = this.now();
    if (this.trading && this.account) this.connectAccount(this.account); else this.connectPublic();
  }

  // ------------------------------------------------------------ shutdown
  #saveState() {
    try { this.store.saveState(this.state); } catch (e) { this.sink?.({ tag: "ERROR", title: "Couldn't save state", detail: e.message }); }
  }

  /** Stops timers and sockets. Keeps "running" as it is, so the bot resumes after a restart. */
  shutdown() {
    this.closed = true;
    clearInterval(this.watchdogTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.pfTimer);
    this.untrackAll();
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.#saveState();
  }
}
