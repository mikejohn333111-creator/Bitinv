// Tbot server engine: the scanner's trader. It holds the Deriv connection, the account and the
// risk limits, and (in Auto trade, demo only) takes the scanner's "Ready now" setups on their own
// markets (autoScan). It has no single-market strategy of its own any more: the strategies
// (ICT, Rules, AI model) run inside the scanner (server/scanner.mjs).
//
// Orders go out as on the website: proposal then buy with underlying_symbol and limit_order, open
// trades tracked with proposal_open_contract, the daily loss limit checked on equity, time exits.
// A 1-minute candle stream of one synthetic index (open around the clock) is the bot's clock:
// each candle close runs the time exits and the daily loss check, and a quiet stream means a
// stuck connection (watchdog).
//
// What the server adds: settings, state and the activity log live in files, so after a
// crash, reboot or update the bot resumes on its own and picks up its open trades again.
import { readFileSync } from "node:fs";
import { CONFIG } from "../public/js/config.js";
import { AI_DEFAULTS } from "../public/js/strategy.js";
import { MARKETS_REQUEST, PLAIN_REQUEST, parseMarkets, marketsOrFallback, marketName, isClosed } from "../public/js/markets.js";
import { sizeMultiplier, RiskGuard } from "../public/js/risk.js";
import { getAccounts, createDemoAccount, getTradingSocketUrl, DerivSocket, cleanAppId } from "../public/js/deriv.js";
import { tradePlan, planView } from "./chart.mjs";
import { staleReason } from "./scanner.mjs";

export const HISTORY_BARS = 1200;
/** The clock: a synthetic index that ticks around the clock. Its 1-minute candles drive the time exits and loss checks. */
export const CLOCK_SYMBOL = "R_75";
const CLOCK_BARS = 120;
const DEFAULT_MULTIPLIERS = [10, 20, 30, 40, 50, 100, 200, 300, 400];
const LOG_KEEP = 500;                 // entries kept in memory (the file keeps 2000)
const MARKETS_REFRESH_MS = 5 * 60000;  // Deriv's market list (open / closed) is loaded again this often
const PENDING_BUY_CHECKS_MS = [5000, 15000, 45000, 90000];   // re-checks after a buy that may have gone through
const SETTLE_MS = 15000;              // after a close, wait this long at most for the new balance
const WATCHDOG_TICK_MS = 30000;
const FEED_QUIET_MS = 3 * 60000;      // synthetic indices tick every 1-2 s, so 3 quiet minutes means the feed is stuck

// ------------------------------------------------------------- settings
/** Saved settings carry this version. A file without it is from before the bot became scanner-only. */
export const SETTINGS_VERSION = 2;
export const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION,
  // "auto": the scanner's ready setups are traded (demo only). "signals": the scanner only shows them.
  mode: "auto",
  riskPct: 1, maxDailyLossPct: 3, dailyProfitPct: 1, maxConsecLosses: 3, cooldownMinutes: 15,
  scanAutoMaxDay: 4, scanAutoMaxOpen: 2,      // trades per day and open at once
  // The scanner's AI model reads these (not on the page).
  aiThreshold: 0.55, aiBarrier: AI_DEFAULTS.barrierATR, aiHorizon: AI_DEFAULTS.horizonBars,
  allowReal: false,
};
export const SCAN_AUTO_STRATEGIES = ["ict", "rules", "ai"];
export const SCAN_AUTO_TFS = [900, 3600];
const SCAN_REAL_MSG = "Scanner auto-trade is demo only. It never trades on a real money account.";
const SCAN_STRATEGY_NAMES = { ict: "ICT", rules: "Rules", ai: "AI model" };
const SCAN_TF_NAMES = { 900: "15m", 3600: "1h" };
const SCAN_TAKEN_KEEP = 300;          // setup ids remembered (each is taken at most once)
const SYMBOL_INFO_MS = 60 * 60000;    // a market's Multiplier range and stake limits are asked again after this
/** The stake limit in a Deriv refusal like "Maximum stake allowed is 2000.00.", or null. */
export function stakeLimit(message) {
  const m = /maximum stake[^0-9]*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(String(message ?? ""));
  const max = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return max > 0 ? { max } : null;
}

const round2 = (v) => Math.round(v * 100) / 100;

/** A time limit in plain words: "60 min", "30 hours". */
export function spanText(bars, barSec = 60) {
  const min = Math.round((bars * barSec) / 60);
  return min < 120 || min % 60 ? `${min} min` : `${min / 60} hours`;
}

const NUMBERS = {
  riskPct:         { min: 0.1, max: 5, label: "Risk per trade" },
  maxDailyLossPct: { min: 0.5, max: 20, label: "Daily loss limit" },
  maxConsecLosses: { min: 0, max: 20, int: true, label: "Losses in a row before a pause" },
  cooldownMinutes: { min: 0, max: 1440, int: true, label: "Pause length" },
  aiThreshold:     { min: 0.34, max: 0.95, label: "AI confidence" },
  aiBarrier:       { min: 0.5, max: 10, label: "AI stop distance" },
  aiHorizon:       { min: 5, max: 240, int: true, label: "AI time limit" },
  dailyProfitPct:  { min: 0, max: 20, label: "Daily profit target" },
  scanAutoMaxDay:  { min: 1, max: 10, int: true, label: "Trades per day" },
  scanAutoMaxOpen: { min: 1, max: 5, int: true, label: "Trades open at once" },
};
const CHOICES = { mode: ["auto", "signals"] };

/**
 * Checks a partial settings update. Numbers are clamped to safe ranges. Turning on real
 * money needs confirmReal: "REAL" in the same update. Keys the bot no longer uses (the old
 * market, strategy and multiplier settings) are ignored. Returns {settings, errors}.
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
    // anything else (confirmReal, old or unknown keys) is ignored
  }
  return { settings: out, errors };
}

/**
 * Settings read from disk: anything odd falls back to the default. A file from before the bot
 * became scanner-only (no `v`) is moved over: Auto trade only if scanner auto-trade was on (and
 * the bot was in Auto trade), else Signals only, so an update never starts trading by itself.
 * Returns {settings, legacy}: legacy holds what the scanner's settings may need from the old file.
 */
export function loadSettings(raw) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const { mode, allowReal, ...rest } = raw;
  const { settings } = cleanSettings(rest, DEFAULT_SETTINGS);
  const out = { ...DEFAULT_SETTINGS, ...settings, v: SETTINGS_VERSION, allowReal: allowReal === true };
  const isLegacy = Object.keys(raw).length > 0 && raw.v !== SETTINGS_VERSION;
  if (!isLegacy) { out.mode = CHOICES.mode.includes(mode) ? mode : DEFAULT_SETTINGS.mode; return { settings: out, legacy: null }; }
  const autoOn = raw.scanAuto === true && mode !== "signals";
  out.mode = autoOn ? "auto" : "signals";
  // One "trades per day" now: the old bot-wide limit, if it was the smaller one.
  const day = Number(raw.maxTradesPerDay);
  if (Number.isFinite(day) && day >= 1 && day < out.scanAutoMaxDay) out.scanAutoMaxDay = Math.round(day);
  const list = (v, ok) => (Array.isArray(v) ? ok.filter((x) => v.map((y) => (typeof x === "number" ? Number(y) : y)).includes(x)) : []);
  return { settings: out, legacy: { scanAuto: autoOn, strategies: list(raw.scanAutoStrategies, SCAN_AUTO_STRATEGIES), timeframes: list(raw.scanAutoTfs, SCAN_AUTO_TFS),
                                    symbol: typeof raw.symbol === "string" ? raw.symbol.slice(0, 30) : "", strategy: typeof raw.strategy === "string" ? raw.strategy.slice(0, 10) : "" } };
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

    const loaded = loadSettings(store.getSettings());
    this.settings = loaded.settings;
    this.legacy = loaded.legacy;         // set once, on the first start after the update to scanner-only
    if (this.legacy) { try { store.saveSettings(this.settings); } catch { /* saved with the next change */ } }
    this.symbol = CLOCK_SYMBOL;
    this.state = { running: false, accountId: null, openMeta: {},
                   tokenRejected: false, tokenError: 401, ...store.getState() };
    if (!this.state.openMeta || typeof this.state.openMeta !== "object") this.state.openMeta = {};
    // Scanner auto-trade: the UTC day, its trade count, and the setups already taken ({id, at, ok}).
    const sa = this.state.scanAuto;
    this.state.scanAuto = { day: typeof sa?.day === "string" ? sa.day : "", count: Number(sa?.count) || 0,
                            taken: Array.isArray(sa?.taken) ? sa.taken.filter((x) => typeof x?.id === "string").slice(-SCAN_TAKEN_KEEP) : [] };
    this.secret = store.getSecret();

    this.logs = [];
    this.seq = 0;
    this.lastLogged = new Map();         // title -> time, for logOnce
    this.accounts = []; this.account = null; this.socket = null; this.trading = false; this.feed = "none";
    this.bars = []; this.forming = null; this.balance = NaN; this.currency = "USD";
    this.running = false; this.model = null; this.guard = null;
    this.markets = []; this.marketsAt = 0;  // Deriv's list of Multiplier markets (empty: the built-in list)
    this.contracts = new Map();          // contract_id -> {side, entryEpoch, horizon, profit, buyPrice, sub, opened}
    this.busy = false;                   // an order is in flight
    this.syncing = false;                // open trades not loaded yet after (re)connecting
    this.connection = "idle"; this.error = ""; this.needsToken = !!this.state.tokenRejected;
    this.lastCost = null; this.lastPriceAt = 0;
    this.resumedAt = 0;
    this.marks = [];                     // the latest signals and trades, for arrows on the chart: {t, side, symbol}
    this.retryTimer = null; this.retryDelay = 5000; this.pfTimer = null;
    this.settling = 0;                   // a trade just closed; the daily loss check waits for the new balance
    this.pendingBuy = null;              // a buy that may have gone through: {checks, meta}
    this.balanceDropped = false;         // the balance fell while an order was in flight
    this.onlineAt = 0; this.watchdogTimer = null;
    this.symbolInfo = new Map();         // symbol -> {at, multipliers, minStake, maxStake, none}: for scanner trades on other markets
    this.scanBusy = false;               // a scanner setup is being taken
    this.scanSkipped = new Set();        // setup ids whose "not taken" reason was logged
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
    if (this.legacy) {
      const l = this.legacy;
      this.log("INFO", "The bot now trades only the scanner's setups",
               `${l.symbol || l.strategy ? `Your old market and strategy (${[l.symbol, l.strategy].filter(Boolean).join(", ")}) are no longer used. ` : ""}` +
               (l.scanAuto ? "Scanner auto-trade was on, so the mode is Auto trade (demo only)." : "Scanner auto-trade was off, so the mode is Signals only: the scanner shows setups and nothing is traded."));
    }
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
    catch { this.model = null; this.log("INFO", "The AI model could not be loaded, so the scanner uses ICT and Rules only."); }
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

  /** The risk guard's limits. Trades per day and open at once are the scanner's (one setting each). */
  limits() {
    const s = this.settings;
    return { maxDailyLossPct: +s.maxDailyLossPct, dailyProfitPct: +s.dailyProfitPct || 0, maxOpen: +s.scanAutoMaxOpen, maxTradesPerDay: +s.scanAutoMaxDay,
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
    sock.subscribe({ ticks_history: this.symbol, style: "candles", granularity: 60, count: CLOCK_BARS,
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
    await this.loadMarkets(sock);
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
          this.log("INFO", known ? `Watching open trade ${id} again` : `Found open trade ${id} on ${symbol ? this.marketName(symbol) : "another market"}`,
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

  /**
   * Loads Deriv's list of markets with Multipliers (and whether each is open now). Asks with
   * the Multipliers filter first, and without it if Deriv refuses the filter. On any failure
   * the bot keeps the list it has (or the built-in synthetic indices).
   */
  async loadMarkets(sock = this.socket) {
    if (!sock) return;
    this.marketsAt = this.now();
    let list = null;
    for (const [req, filtered] of [[MARKETS_REQUEST, true], [PLAIN_REQUEST, false]]) {
      try {
        const r = await sock.send({ ...req, contract_type: req.contract_type && [...req.contract_type] });
        if (Array.isArray(r.active_symbols)) { list = parseMarkets(r.active_symbols, { filtered }); break; }
      } catch { /* try without the filter, then give up */ }
    }
    if (this.closed || !list?.length) return;
    this.markets = list;
  }

  /** Market codes the chart may show: Deriv's list once loaded, else the built-in one (plus the clock's). */
  knownSymbols() { return marketsOrFallback(this.markets, this.symbol).map((m) => m.symbol); }
  marketName(symbol = this.symbol) { return marketName(this.markets, symbol); }
  /** The clock's market is closed (it normally never is: a synthetic index). */
  marketClosed() { return isClosed(this.markets, this.symbol); }
  /** Seconds per candle of the clock stream. */
  tf() { return 60; }

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
    } else if (msg.msg_type === "ohlc") {
      const o = msg.ohlc;
      const bar = { epoch: Number(o.open_time), open: +o.open, high: +o.high, low: +o.low, close: +o.close };
      this.lastPriceAt = this.now();
      const keep = HISTORY_BARS;
      if (!this.forming || bar.epoch > this.forming.epoch) {
        if (this.forming) {
          this.bars.push(this.forming);
          if (this.bars.length > keep * 1.5) this.bars.splice(0, this.bars.length - keep);
          this.forming = bar;
          this.onBarClosed();
        } else this.forming = bar;
      } else if (bar.epoch === this.forming.epoch) this.forming = bar;
    }
  }

  lastPrice() { return this.forming?.close ?? this.bars.at(-1)?.close ?? NaN; }

  /** Every closed clock candle: time limits, the daily loss check (also a new day), and the halt's closes. */
  onBarClosed() {
    this.timeExits();
    this.checkGuard();
    this.haltExits();
  }

  #money(v) { return Number.isFinite(v) ? `${v.toFixed(2)} ${this.currency}` : "–"; }

  /**
   * The order itself, for scanner setups: a proposal with the stop
   * loss and take profit as money, then the buy, then the trade is followed like any other.
   * `check(proposal)` may refuse the price Deriv quotes (a reason in words). Returns true when bought.
   */
  async #order({ side, symbol, size, mult, meta, sizeText, reason, title = `Opened ${side} ${symbol}`, check = null, onBought = () => {}, onUnsure = () => {} }) {
    if (this.busy) return false;
    this.busy = true;
    const sock = this.socket, up = side === "BUY";
    let stage = "proposal";
    try {
      const ask = () => sock.send({
        proposal: 1, amount: size.stake, basis: "stake", contract_type: up ? "MULTUP" : "MULTDOWN",
        currency: this.currency, underlying_symbol: symbol, multiplier: mult, duration_unit: "s",
        limit_order: { stop_loss: size.stopLoss, take_profit: size.takeProfit },
      });
      let p;
      try { p = await ask(); }
      catch (e) {
        // Deriv's stake limit can be lower than contracts_for said (or it didn't say): the
        // stake, stop loss and take profit are scaled down to that limit and asked once more.
        const limit = stakeLimit(e.message);
        if (!limit || limit.max >= size.stake) throw e;
        this.#learnMaxStake(symbol, limit.max);
        const k = limit.max / size.stake;
        size = { ...size, stake: limit.max, stopLoss: Math.max(round2(size.stopLoss * k), 0.01), takeProfit: Math.max(round2(size.takeProfit * k), 0.01) };
        size.risk = size.stopLoss;
        sizeText = `stake ${this.#money(size.stake)} at x${mult} · risk ${this.#money(size.stopLoss)} · target ${this.#money(size.takeProfit)}`;
        this.log("INFO", `Stake capped at ${this.#money(limit.max)}`, `Deriv's largest stake for ${symbol} is ${limit.max}, so this trade risks less than your Risk per trade.`);
        p = await ask();
      }
      const prop = p.proposal;
      const commission = Number(prop.commission ?? prop.contract_details?.commission ?? NaN);
      if (Number.isFinite(commission)) this.lastCost = { commission, r: commission / size.stopLoss, currency: this.currency };
      if (!this.running || this.closed || this.socket !== sock) { this.log("INFO", `Skipped ${side}: the bot was stopped`); return false; }
      const refused = check?.(prop);
      if (refused) { this.log("INFO", `Skipped ${side} ${symbol}`, refused); return false; }
      stage = "buy";
      const b = await sock.send({ buy: prop.id, price: Number(prop.ask_price ?? size.stake) });
      const buy = b.buy;
      this.guard.recordEntry();
      onBought(buy);
      this.trackContract(buy.contract_id, { ...meta, buyPrice: Number(buy.buy_price) });
      this.log(side, title, `${sizeText} · ${reason}${Number.isFinite(commission) ? ` · commission ${this.#money(commission)}` : ""}`);
      return true;
    } catch (e) {
      this.log("ERROR", `Deriv refused the ${side} order`, e.message);
      if (stage === "buy" && /closed|timed out|not connected/i.test(e.message)) {
        // The buy may have gone through. Never retry it, and reload the open trades first.
        onUnsure();
        this.#saveState();
        if (this.socket === sock && this.trading) {
          // Deriv can book a slow order after the first look, so look a few more times.
          this.pendingBuy = { checks: 0, meta };
          this.syncing = true;
          if (this.connection === "online") this.#syncPortfolio(sock);
        }
      }
      return false;
    } finally {
      this.busy = false;
      if (this.balanceDropped) {
        this.balanceDropped = false;
        if (this.socket === sock && this.trading && !this.syncing && this.connection === "online") { this.syncing = true; this.#syncPortfolio(sock); }
      }
    }
  }

  // ---------------------------------------------------- scanner auto-trade
  #today() { return new Date(this.now()).toISOString().slice(0, 10); }

  /** Today's scanner auto-trade record (a new UTC day starts the count again). */
  #scanDay() {
    const sa = this.state.scanAuto, day = this.#today();
    if (sa.day !== day) { sa.day = day; sa.count = 0; }
    return sa;
  }

  /** True when the scanner's setup with this id was traded. */
  scanTraded(id) { return this.state.scanAuto.taken.some((x) => x.id === id && x.ok); }

  /** Open trades for the "open at once" limit: every open trade, also ones from before the update or opened by hand. */
  scanOpenCount() { return this.openCount(); }

  /** Auto trade is chosen, but the account is a real money one (it trades nothing there). */
  scanAutoBlocked() { return this.settings.mode === "auto" && !!this.account && this.account.type !== "demo"; }

  /**
   * Why no scanner setup can be taken right now, or "" when one can. `quiet` reasons are
   * states the page already shows (off, stopped, signals only), not worth a log line.
   */
  scanAutoBlock() {
    const s = this.settings;
    if (s.mode !== "auto") return { why: "the bot is in Signals only mode", quiet: true };
    if (!this.running) return { why: "the bot is stopped", quiet: true };
    if (!this.trading || !this.account) return { why: "the bot isn't connected to your Deriv account", quiet: true };
    if (this.account.type !== "demo") return { why: SCAN_REAL_MSG, real: true };
    if (this.syncing || this.busy || this.scanBusy || this.pendingBuy) return { why: "the bot is busy", quiet: true };
    const blocked = this.guard?.blockReason(0, this.now());   // the daily loss limit, the losing-streak pause, max trades per day
    if (blocked) return { why: blocked };
    const n = (k, w) => `${k} ${w}${+k === 1 ? "" : "s"}`;
    if (this.#scanDay().count >= +s.scanAutoMaxDay) return { why: `${n(s.scanAutoMaxDay, "trade")} today already (the most allowed)` };
    if (this.scanOpenCount() >= +s.scanAutoMaxOpen) return { why: `${n(s.scanAutoMaxOpen, "trade")} open already (the most allowed)` };
    return { why: "" };
  }

  /**
   * Why this one setup can't be taken (the bot-wide checks are in scanAutoBlock), or "".
   * The scanner only hands over setups of the strategies and timeframes picked in its settings.
   */
  scanSetupBlock(it) {
    if (this.state.scanAuto.taken.some((x) => x.id === it.id)) return { why: "already taken", quiet: true };
    const stale = staleReason(it, this.now());
    if (stale) return { why: stale };
    for (const c of this.contracts.values()) if (!c.stale && c.symbol === it.symbol) return { why: `a trade on ${it.name || it.symbol} is open already` };
    if (isClosed(this.markets, it.symbol)) return { why: `${it.name || it.symbol} is closed now` };
    return { why: "" };
  }

  /**
   * Called by the scanner after each scan with its "Ready now" setups, best first (ready,
   * freshest, most agreement). Takes the first one every check allows, at most one at a time.
   * Each reason a setup is not taken is logged once (quiet ones never).
   */
  autoScan(items) {
    const all = this.scanAutoBlock();
    if (all.why) {
      if (all.real) this.logOnce("ERROR", "Scanner auto-trade placed no trade: it is demo only", `Account ${this.account?.id} is a real money account. Switch to a demo account or use Signals only.`);
      else if (!all.quiet) for (const it of items) if (!this.scanSetupBlock(it).quiet) this.#scanSkip(it, all.why);
      return null;
    }
    for (const it of items) {
      const one = this.scanSetupBlock(it);
      if (!one.why) {
        const run = this.#takeSetup(it).catch((e) => this.log("ERROR", "Scanner trade failed", e.message));
        return run;
      }
      if (!one.quiet) this.#scanSkip(it, one.why);
    }
    return null;
  }

  #scanName(it) { return `${SCAN_STRATEGY_NAMES[it.strategy] || it.strategy} ${SCAN_TF_NAMES[it.tf] || ""} ${it.name || it.symbol}`.replace(/\s+/g, " ").trim(); }

  #scanSkip(it, why) {
    if (this.scanSkipped.has(it.id)) return;
    this.scanSkipped.add(it.id);
    if (this.scanSkipped.size > 500) this.scanSkipped.delete(this.scanSkipped.values().next().value);
    this.log("INFO", `Scanner setup not taken: ${it.side} ${this.#scanName(it)}`, `${why.charAt(0).toUpperCase()}${why.slice(1)}.`);
  }

  /** Remembers a stake limit Deriv named in a refusal, so later trades are sized under it. */
  #learnMaxStake(symbol, max) {
    const known = this.symbolInfo.get(symbol);
    if (known) known.maxStake = Math.min(known.maxStake, max);
  }

  /** A market's Multiplier range and stake limits (contracts_for), asked once an hour. */
  async #symbolLimits(symbol) {
    const known = this.symbolInfo.get(symbol);
    if (known && this.now() - known.at < SYMBOL_INFO_MS) return known;
    const r = await this.socket.send({ contracts_for: symbol });
    const items = r.contracts_for?.available || [];
    const mult = items.find((a) => /MULT/.test(a.contract_type) || a.contract_category === "multiplier");
    const info = { at: this.now(), none: items.length > 0 && !mult,
                   multipliers: mult?.multiplier_range?.length ? mult.multiplier_range.map(Number).sort((a, b) => a - b) : DEFAULT_MULTIPLIERS,
                   minStake: mult?.min_stake ? Number(mult.min_stake) : 1, maxStake: mult?.max_stake ? Number(mult.max_stake) : Infinity };
    this.symbolInfo.set(symbol, info);
    if (this.symbolInfo.size > 50) this.symbolInfo.delete(this.symbolInfo.keys().next().value);
    return info;
  }

  /** Records a setup as taken (it is never tried again), and counts it for today when it traded or may have. */
  #scanTaken(it, ok, count = ok) {
    const sa = this.#scanDay();
    sa.taken = [...sa.taken.filter((x) => x.id !== it.id), { id: it.id, at: this.now(), ok }].slice(-SCAN_TAKEN_KEEP);
    if (count) sa.count++;
    this.#saveState();
  }

  /** Places a scanner setup's order on its own market, sized with the bot's risk settings. */
  async #takeSetup(it) {
    this.scanBusy = true;
    const name = this.#scanName(it);
    try {
      // The demo-only guard again, right at the order.
      if (this.account?.type !== "demo") { this.logOnce("ERROR", `Skipped scanner ${it.side} ${it.symbol}: ${SCAN_REAL_MSG}`, "Use a demo account."); return false; }
      this.#scanTaken(it, false);   // never tried twice, whatever happens next
      let lim;
      try { lim = await this.#symbolLimits(it.symbol); }
      catch (e) { this.#scanSkip(it, `Deriv didn't say which Multipliers ${it.name || it.symbol} has (${e.message})`); return false; }
      if (lim.none) { this.#scanSkip(it, `${it.name || it.symbol} has no Multipliers`); return false; }
      if (!this.running) return false;
      if (this.busy || this.syncing) { this.#scanSkip(it, "the bot was busy with another order"); return false; }
      const s = this.settings;
      const mult = lim.multipliers[0];   // the lowest Multiplier the market has
      const entry = Number.isFinite(it.price) ? it.price : it.entry;
      const size = Number.isFinite(this.balance)
        ? sizeMultiplier({ balance: this.balance, riskPct: +s.riskPct, entry, slDist: it.slDist, tpDist: it.tpDist,
                           multiplier: mult, minStake: lim.minStake, maxStake: lim.maxStake })
        : null;
      if (!size?.ok) { this.#scanSkip(it, size?.reason || "the balance isn't known yet"); return false; }
      const sizeText = `stake ${this.#money(size.stake)} at x${mult} · risk ${this.#money(size.stopLoss)} · target ${this.#money(size.takeProfit)}`;
      const scan = { strategy: it.strategy, tf: it.tf, name: it.name || it.symbol, id: it.id };
      const meta = { side: it.side, entryEpoch: it.start, horizon: it.horizonBars || 0, symbol: it.symbol, barSec: it.tf, source: "scanner", scan };
      const up = it.side === "BUY";
      const ok = await this.#order({ side: it.side, symbol: it.symbol, size, mult, meta, sizeText, reason: it.reason || "",
        title: `Opened ${it.side} ${it.symbol} from the scanner (${name})`,
        // Deriv's price now: refused when it is already past the plan's stop loss or take profit.
        check: (prop) => {
          const spot = Number(prop.spot);
          if (!Number.isFinite(spot)) return "";
          if (up ? spot <= it.sl : spot >= it.sl) return `The price now (${fmtNum(spot)}) is already past the setup's stop loss.`;
          if (up ? spot >= it.tp : spot <= it.tp) return `The price now (${fmtNum(spot)}) is already past the setup's take profit.`;
          return "";
        },
        onBought: () => { this.#scanTaken(it, true); this.#mark(this.now() / 1000, it.side, it.symbol); },
        onUnsure: () => { this.#scanTaken(it, false, true); },   // counted for today: it may have gone through
      });
      return ok;
    } finally { this.scanBusy = false; }
  }

  /** What the page shows about scanner auto-trade. */
  scanAutoView() {
    const s = this.settings, sa = this.#scanDay();
    const block = this.scanAutoBlock();
    const on = s.mode === "auto";
    return { on, demoOnly: true, blocked: this.scanAutoBlocked(), today: sa.count, maxDay: +s.scanAutoMaxDay,
             open: this.scanOpenCount(), maxOpen: +s.scanAutoMaxOpen, waiting: on ? block.why : "" };
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
    const { justHalted, profit } = this.guard.update(this.equity(), this.now());
    if (justHalted) {
      this.log(profit ? "INFO" : "ERROR", `Stopped for today: ${this.guard.state.haltReason}`, "Open trades are being closed. The bot starts again tomorrow (UTC).");
      this.haltExits();
    }
  }

  /** While halted for today: close every open trade, and try again next bar if Deriv didn't close one. */
  haltExits() {
    const g = this.guard;
    if (!g?.state.halted || this.syncing || g.state.day !== new Date(this.now()).toISOString().slice(0, 10)) return;
    for (const [id, c] of this.contracts) if (!c.closing && !c.stale) {
      c.closing = true;
      this.closeContract(id, "daily limit").then((ok) => { if (!ok) c.closing = false; });   // retried next bar
    }
  }

  trackContract(id, meta) {
    id = String(id);
    if (this.contracts.has(id)) return;
    const c = { side: "?", profit: 0, buyPrice: NaN, horizon: 0, entryEpoch: 0, opened: 0, ...meta };
    this.contracts.set(id, c);
    if ((meta.side || meta.horizon) && !c.stale) {
      this.state.openMeta[id] = { side: c.side, entryEpoch: c.entryEpoch, horizon: c.horizon, symbol: c.symbol, ...(c.barSec && { barSec: c.barSec }),
                                  ...(c.source && { source: c.source }), ...(c.scan && { scan: c.scan }) };
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
      if (!sold) { try { c.plan = tradePlan(poc, c, c.plan); } catch { /* chart only */ } }
      if (sold) {
        this.#forget(id, c);
        const soldAt = Number(poc.sell_time) > 0 ? Math.min(Number(poc.sell_time) * 1000, this.now()) : this.now();
        this.guard?.recordClose(c.profit, soldAt);
        this.log(c.profit >= 0 ? "WIN" : "LOSS", `Closed ${c.side}${c.symbol ? ` ${c.symbol}` : ""}: ${c.profit >= 0 ? "+" : ""}${this.#money(c.profit)}`,
                 [c.source === "scanner" ? "from the scanner" : "", c.stale ? "it closed while the bot wasn't watching" : "",
                  poc.exit_tick_display_value ? `exit ${poc.exit_tick_display_value}` : ""].filter(Boolean).join(" · "));
        // The payout may reach the balance stream after this message: wait for it before the loss check.
        if (!c.stale) this.settling = this.now();
      }
      this.checkGuard();
    });
    if (!c.opened) c.opened = c.entryEpoch ? (c.entryEpoch + (c.barSec || 60)) * 1000 : 0;
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
    // Time limits count candles of the timeframe the trade was opened on (checked at each candle close).
    for (const [id, c] of this.contracts) {
      const sec = c.barSec || 60;
      if (c.horizon && last.epoch - c.entryEpoch >= c.horizon * sec && !c.closing && !c.stale) {
        c.closing = true;
        this.closeContract(id, `${spanText(c.horizon, sec)} time limit`).then((ok) => { if (!ok) c.closing = false; });   // retried next bar
      }
    }
  }

  closeAll(why) { return Promise.all([...this.contracts].filter(([, c]) => !c.stale).map(([id]) => this.closeContract(id, why))); }

  // ------------------------------------------------------------- run/stop
  #describeRun() {
    return this.settings.mode === "auto" ? "Auto trade: the scanner's ready setups are traded (demo only)"
                                         : "Signals only: the scanner shows setups, nothing is traded";
  }

  #setRunning(on) {
    this.running = on;
    this.state.running = on;
    if (on) this.state.startedAt = this.now();
    this.#saveState();
  }

  /** Start: in Auto trade the scanner's ready setups are traded (demo only); in Signals only nothing is. */
  start() {
    if (this.running) return;
    const s = this.settings;
    if (s.mode === "auto") {
      if (!this.secret) throw new UserError("Add your Deriv token first, so the bot can trade on your demo account.");
      if (this.needsToken) throw new UserError(this.error || TOKEN_MSG[401]);
      if (!this.trading || !this.account) throw new UserError("The bot isn't connected to your Deriv account yet. Please wait a moment and try again.");
      if (this.account.type !== "demo") {
        this.log("ERROR", "Did not start: auto trade is demo only", "Switch to a demo account, or use Signals only.");
        throw new UserError(`${SCAN_REAL_MSG} Switch to a demo account, or use Signals only.`, 403, "scanner_demo_only");
      }
    }
    this.#setRunning(true);
    this.log("INFO", `Bot started. ${this.#describeRun()}`,
             this.account ? `${this.account.type === "demo" ? "Demo" : "REAL"} account ${this.account.id}` : "Prices only, no account");
  }

  /** Stop: no new trades. Open trades keep their stop loss and take profit (and are still watched). */
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
    const next = { ...prev, ...partial };
    if (next.mode === "auto" && prev.mode !== "auto" && this.account && this.account.type !== "demo") {
      this.log("ERROR", "Auto trade was not turned on: it is demo only", `Account ${this.account.id} is a real money account.`);
      throw new UserError(`${SCAN_REAL_MSG} Switch to a demo account first.`, 403, "scanner_demo_only");
    }
    Object.assign(this.settings, partial, { v: SETTINGS_VERSION });
    this.store.saveSettings(this.settings);
    if (this.guard) this.guard.limits = this.limits();
    if (next.mode !== prev.mode)
      this.log("INFO", next.mode === "auto" ? "Mode: Auto trade (demo only)" : "Mode: Signals only",
               next.mode === "auto" ? `${this.running ? "The bot" : "Once you press Start, the bot"} takes the scanner's "Ready now" setups, at most ${next.scanAutoMaxDay} a day and ${next.scanAutoMaxOpen} open at once.`
                                    : "The scanner shows setups. Nothing new is traded; open trades keep their stop loss and take profit.");
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
      mode: s.mode,
      marketsLoaded: this.markets.length > 0,
      connection: this.connection, feed: this.feed,
      account: this.publicAccount(),
      balance: Number.isFinite(this.balance) ? this.balance : null,
      equity: Number.isFinite(eq) ? eq : null,
      currency: this.currency,
      dayPL: g && Number.isFinite(eq) && g.state.startBalance > 0 ? g.dayPL(eq) : null,
      tradesToday: g ? g.state.trades || 0 : 0,
      halted, haltReason: halted ? g.state.haltReason || "" : "",
      cooldownUntil,
      syncing: this.syncing,
      marks: this.marks.map(({ t, side, symbol }) => ({ t, side, symbol })),
      lastCost: this.lastCost,
      open: [...this.contracts.entries()].filter(([, c]) => !c.stale).map(([id, c]) => ({
        id, side: c.side, symbol: c.symbol || null, name: c.symbol ? this.marketName(c.symbol) : "", stake: Number.isFinite(c.buyPrice) ? c.buyPrice : null, profit: Number.isFinite(c.profit) ? c.profit : null,
        opened: c.opened || null, horizon: c.horizon || 0, barSec: c.barSec || 60, closing: !!c.closing, plan: planView(c.plan),
        source: c.source === "scanner" ? "scanner" : "bot", ...(c.scan && { scan: { strategy: c.scan.strategy, tf: c.scan.tf, name: c.scan.name } }),
      })),
      hasToken: !!token,
      needsToken: this.needsToken,
      tokenHint: token.length >= 8 ? token.slice(-4) : token ? "set" : "",
      appId: this.secret?.appId || "",
      error: this.error,
      modelLoaded: !!this.model,
      accounts: this.publicAccounts(),
      scanAuto: this.scanAutoView(),
      scanAutoBlocked: this.scanAutoBlocked(),
      settings: { ...s },
      limits: this.limits(),
      startedAt: this.running ? this.state.startedAt || null : null,
      resumedAt: this.running ? this.resumedAt || null : null,
      lastLogSeq: this.seq,
    };
  }

  #mark(t, side, symbol) { this.marks = [...this.marks, { t: Math.floor(t), side, symbol }].slice(-50); }

  // ------------------------------------------------------------ watchdog
  /**
   * Runs every 30 s. A socket can stay "online" while Deriv's side has stalled and sends nothing.
   * Then no bar closes, so no time exits, no loss checks and no trades. If the price feed has
   * been quiet for 3 minutes, connect again from scratch (fresh login link, open trades re-loaded).
   */
  watchdog() {
    if (this.closed || this.connection !== "online") return;
    if (this.now() - this.marketsAt >= MARKETS_REFRESH_MS) this.loadMarkets();
    if (this.marketClosed()) return;   // a closed market sends no prices; that is not a stuck feed
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
