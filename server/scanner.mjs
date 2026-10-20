// The scanner: the bot's own strategies run over many markets at once, for the control page's
// "Scanner" list. It only reads market data. With "Auto-trade scanner setups" on (demo only),
// the engine may take its "Ready now" setups (TradingEngine.autoScan does every check and the order).
//
// Every 15-minute and 1-hour candle close (plus "Scan now", with a cooldown) it asks Deriv for
// each market's candles with a one-off ticks_history on the engine's connection (no
// subscriptions), one request at a time and a couple of seconds apart, so the bot's own
// trading requests always get through. It waits while an order is in flight, and backs off
// when Deriv says to slow down. Each answer is checked with the strategies exactly as the bot
// would on that timeframe:
//   ICT    evaluateICT(bars, ictParamsFor(tf, {real}))  -> a setup ready now, or one waiting for price
//   Rules  evaluateRules(bars, rulesParamsFor(tf))       -> a setup ready now
//   AI     evaluateAI(bars, model, aiParams(settings))   -> a setup ready now (if the model is loaded)
// The stop loss and take profit are the prices the bot would use (handleSignal, the pending plan).
// The list is sorted by status (ready first), then freshness, then a plain agreement count
// (the 4-hour trend, and the other strategies on the same market). No win rates or confidence
// numbers: the backtests found no proven edge after fees, and the page says so.
import { evaluateRules, evaluateAI, evaluateICT, aiParams, rulesParamsFor, ictParamsFor, ictHtfBias, ICT_DEFAULTS } from "../public/js/strategy.js";
import { makePending, pendingCheck, firstTouch } from "../public/js/pending.js";
import { FALLBACK_MARKETS, isSynthetic, marketName } from "../public/js/markets.js";
import { UserError } from "./engine.mjs";

export const SCAN_TIMEFRAMES = [900, 3600];
export const MAX_MARKETS = 20;
/** Candles asked for: enough for every strategy and for the 4-hour trend on 15-minute candles (16 x 55). */
export const SCAN_BARS = { 900: 1000, 3600: 500 };
export const SCANNER_DEFAULTS = Object.freeze({ on: true, synthetics: false, timeframes: Object.freeze([...SCAN_TIMEFRAMES]) });
const GAP_MS = 2000;                 // one Deriv request at most this often (30 a minute)
const COOLDOWN_MS = 2 * 60000;       // between two "Scan now"
const CLOSE_DELAY_S = 30;            // after a candle closes, wait this long so Deriv has it
const BACKOFF_MS = [60000, 120000, 300000, 600000, 900000];   // when Deriv says to slow down
const MAX_ITEMS = 40;
const STRATEGY_NAMES = { ict: "ICT", rules: "Rules", ai: "AI model" };
const TF_NAMES = { 900: "15m", 3600: "1h" };
// Which markets come first when there are more than MAX_MARKETS.
const PRIORITY = [["forex", "major_pairs"], ["commodities", "metals"], ["indices", ""], ["forex", "minor_pairs"], ["forex", ""],
                  ["commodities", ""], ["cryptocurrency", ""], ["stocks", ""], ["synthetic_index", ""]];

// ---------------------------------------------------------------- settings
/** Checks a partial scanner settings update ({on, synthetics, timeframes}). Returns {settings, errors}. */
export function cleanScannerSettings(input, current = SCANNER_DEFAULTS) {
  const out = {}, errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { settings: { ...current }, errors: ["Settings must be an object."] };
  for (const k of ["on", "synthetics"]) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== "boolean") errors.push(`${k === "on" ? "Scanner" : "Synthetic indices"} must be on or off.`);
    else out[k] = input[k];
  }
  if (input.timeframes !== undefined) {
    const t = Array.isArray(input.timeframes) ? [...new Set(input.timeframes.map(Number))] : null;
    if (!t || !t.length || t.some((v) => !SCAN_TIMEFRAMES.includes(v))) errors.push("Pick 15m, 1h or both.");
    else out.timeframes = SCAN_TIMEFRAMES.filter((v) => t.includes(v));
  }
  return { settings: { ...current, ...out }, errors };
}

/** Saved settings: anything odd falls back to the default. */
export function loadScannerSettings(raw) {
  const s = { ...SCANNER_DEFAULTS, timeframes: [...SCANNER_DEFAULTS.timeframes] };
  if (!raw || typeof raw !== "object") return s;
  for (const k of ["on", "synthetics", "timeframes"]) {
    const { settings, errors } = cleanScannerSettings({ [k]: raw[k] }, s);
    if (!errors.length) Object.assign(s, settings);
  }
  return s;
}

// ----------------------------------------------------------------- markets
/**
 * The markets to scan: open, not suspended, real markets first (forex majors, metals, stock
 * indices, ...), synthetic indices only when asked for, at most MAX_MARKETS.
 * `markets` is Deriv's list of Multiplier markets (parseMarkets); empty means not loaded.
 */
export function pickMarkets(markets, { synthetics = false, max = MAX_MARKETS } = {}) {
  const list = markets?.length ? markets : synthetics ? FALLBACK_MARKETS : [];
  const rank = (m) => {
    const i = PRIORITY.findIndex(([mk, sub]) => mk === m.market && (!sub || sub === m.submarket));
    return i < 0 ? PRIORITY.length - 1 : i;   // unknown groups just before the synthetic indices
  };
  return list.filter((m) => m.open && !m.suspended && (synthetics || m.market !== "synthetic_index"))
    .map((m, k) => ({ m, k, r: rank(m) }))
    .sort((a, b) => a.r - b.r || (a.m.order ?? 0) - (b.m.order ?? 0) || a.k - b.k)
    .slice(0, max).map(({ m }) => m);
}

// -------------------------------------------------------------- scheduling
/** When the newest candle of `tf` seconds that closed at least `delay` seconds ago closed (epoch seconds). */
export function closedBoundary(nowMs, tf, delay = CLOSE_DELAY_S) {
  return Math.floor((nowMs / 1000 - delay) / tf) * tf;
}
/** True for Deriv's "slow down" answers. */
export const isRateLimit = (e) => /rate.?limit|too many|throttl/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
/** True when the request never got an answer because of the connection: tried again later. */
const isConnection = (e) => /not connected|connection closed|timed out/i.test(String(e?.message ?? ""));

// --------------------------------------------------------------- evaluation
const bar = (c) => ({ epoch: Number(c.epoch ?? c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close });
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v) => (fin(v) ? +v.toPrecision(10) : null);

/** The 4-hour trend from these candles ("up", "down" or null): EMA 50 of 4-hour candles, as ICT's filter on 1h. */
export function trend4h(bars, tf) {
  return ictHtfBias(bars, { ...ICT_DEFAULTS, htfBias: "ema", htfMinutes: 240, htfEMA: 50, htfSlopeBars: 3, barMinutes: Math.round(tf / 60) });
}

const RULES_WORDS = {
  "trend pullback": "In a strong trend, price pulled back to its average and turned with the trend again",
  "range reversion": "In a quiet market, price went outside its usual range and came back inside",
};
function plainReason(strategy, res, side) {
  if (strategy === "ai") return `The AI model leans ${side === "BUY" ? "up" : "down"} on the last candle. It was trained on 1-minute candles and is untested on 15m and 1h.`;
  if (strategy === "rules") {
    const key = Object.keys(RULES_WORDS).find((k) => String(res.reason).startsWith(k));
    return key ? `${RULES_WORDS[key]}.` : String(res.reason || "");
  }
  return String(res.reason || "");
}

/**
 * One market and timeframe: Deriv's candles (the last one still forming) through the
 * strategies. Returns {items, trend, last} where items are setups ready now (on the last
 * closed candle) and ICT plans waiting for price (still valid at the latest price).
 * @param {object} o  {symbol, name, tf, candles, synthetic, model, aiSettings, nowMs}
 */
export function scanSeries({ symbol, name = symbol, tf, candles, synthetic = false, model = null, aiSettings = null, nowMs = Date.now() }) {
  const all = (candles || []).map(bar).filter((b) => fin(b.epoch) && fin(b.close));
  const forming = all.pop() || null;
  const bars = all;
  const out = { items: [], trend: null, last: bars.at(-1)?.epoch ?? null };
  if (bars.length < 60) return out;
  const last = bars.at(-1);
  const closedAt = Math.min((last.epoch + tf) * 1000, nowMs);   // the newest candle closed then (never in the future)
  const trend = trend4h(bars, tf);
  out.trend = trend;
  const base = { symbol, name, tf, at: closedAt };
  const results = [
    ["ict", evaluateICT(bars, ictParamsFor(tf, { real: !synthetic }))],
    ["rules", evaluateRules(bars, rulesParamsFor(tf))],
    ...(model && aiSettings ? [["ai", evaluateAI(bars, model, aiParams(aiSettings))]] : []),
  ];
  for (const [strategy, res] of results) {
    if (res.action && fin(res.slDist) && fin(res.tpDist) && res.slDist > 0 && res.tpDist > 0) {
      // As the bot's handleSignal: entry at the last close, stop and target at the strategy's distances.
      const up = res.action === "BUY", entry = last.close;
      // id is the setup's id (market, timeframe, strategy, side, candle): auto-trade takes each one once.
      // slDist / tpDist / horizonBars are what the bot's order needs; price is the latest price when scanned.
      out.items.push({ ...base, id: `${symbol}:${tf}:${strategy}:${res.action}:${last.epoch}`, strategy, side: res.action, status: "ready",
        entry: round(entry), sl: round(up ? entry - res.slDist : entry + res.slDist), tp: round(up ? entry + res.tpDist : entry - res.tpDist),
        slDist: round(res.slDist), tpDist: round(res.tpDist), horizonBars: res.horizonBars || 0, price: round(forming?.close ?? entry),
        rr: round(res.tpDist / res.slDist), reason: plainReason(strategy, res, res.action),
        start: last.epoch, end: res.horizonBars ? last.epoch + (res.horizonBars + 1) * tf : null, validUntil: closedAt + tf * 1000 });
    }
    if (strategy === "ict" && res.pending) {
      // As the bot's waiting plan: the same checks, and not shown once price has cancelled it.
      const plan = makePending(res.pending, { strategy, symbol, barSec: tf, horizonBars: res.pending.horizonBars || 0 });
      if (!plan) continue;
      const check = pendingCheck(plan, forming?.close ?? last.close, Math.max(nowMs / 1000, (forming?.epoch ?? last.epoch)));
      if (check.kind === "cancel") continue;
      const ref = firstTouch(plan), risk = Math.abs(ref - plan.sl), reward = Math.abs(plan.tp - ref);
      out.items.push({ ...base, id: `${symbol}:${tf}:${plan.id}`, strategy, side: plan.side, status: "waiting",
        entry: round(ref), sl: round(plan.sl), tp: round(plan.tp), zone: plan.zone.map(round), rr: risk > 0 ? round(reward / risk) : null,
        reason: plan.reason, inZone: check.kind === "enter", start: plan.since ?? last.epoch, end: plan.expiresAt,
        validUntil: plan.expiresAt * 1000 });
    }
  }
  return out;
}

// ------------------------------------------------------------------ ranking
/**
 * Adds a plain agreement count to each setup and sorts the list: ready now first, then the
 * freshest, then the most agreement. Agreement: +1 when the 4-hour trend points the same way,
 * +1 for each other strategy or timeframe on the same market on the same side; -1 for each
 * that points the other way. `trends` maps "symbol:tf" to "up" / "down" / null.
 */
export function rankItems(items, trends = new Map()) {
  const ranked = items.map((it) => {
    const agree = [], against = [];
    const t = trends.get(`${it.symbol}:${it.tf}`);
    const dir = it.side === "BUY" ? "up" : "down";
    if (t === dir) agree.push(`4h trend is ${t}`);
    else if (t) against.push(`4h trend is ${t}`);
    for (const o of items) {
      if (o === it || o.symbol !== it.symbol || (o.strategy === it.strategy && o.tf === it.tf)) continue;
      const what = `${STRATEGY_NAMES[o.strategy]} ${TF_NAMES[o.tf] || ""}`.trim();
      if (agree.includes(what) || against.includes(what)) continue;
      (o.side === it.side ? agree : against).push(what);
    }
    return { ...it, agree, against, score: agree.length - against.length };
  });
  const minute = (ms) => Math.floor(ms / 60000);
  return ranked.sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1) ||
    minute(b.at) - minute(a.at) || b.score - a.score || a.name.localeCompare(b.name) || a.tf - b.tf);
}

// --------------------------------------------------------------- auto-trade
/** How far price may be from a ready setup's entry (in R, the stop distance) and still be taken. */
export const FRESH_R = 0.25;

/**
 * Why a setup is no longer good to take now, or "" when it is: it must be ready now, found on
 * the newest closed candle of its timeframe, and the latest price must still be inside the
 * plan (not past the stop loss or take profit, and within FRESH_R of the entry either way).
 */
export function staleReason(it, nowMs) {
  if (it.status !== "ready") return "it is waiting for price, and auto-trade only takes setups that are ready now";
  if ((it.start + it.tf) * 1000 < closedBoundary(nowMs, it.tf, 0) * 1000) return "a newer candle has closed since it was found";
  const up = it.side === "BUY", p = it.price, risk = it.slDist;
  if (!fin(p) || !fin(risk) || !(risk > 0)) return "no price to check it with";
  if (up ? p <= it.sl : p >= it.sl) return "price is already past its stop loss";
  if (up ? p >= it.tp : p <= it.tp) return "price is already past its take profit";
  if (Math.abs(p - it.entry) > FRESH_R * risk) return `price moved more than ${FRESH_R}R away from the entry`;
  return "";
}

// ------------------------------------------------------------------ scanner
export class Scanner {
  /**
   * @param {TradingEngine} engine  its socket, connection, markets, model and settings are read; nothing is changed
   * @param {object} o  store (getScanner/saveScanner), now, gapMs, cooldownMs, closeDelay: for tests
   */
  constructor(engine, { store = null, now = Date.now, gapMs = GAP_MS, cooldownMs = COOLDOWN_MS, closeDelay = CLOSE_DELAY_S } = {}) {
    Object.assign(this, { engine, store, now, gapMs, cooldownMs, closeDelay });
    this.settings = loadScannerSettings(store?.getScanner?.());
    this.series = new Map();      // "symbol:tf" -> {at, items, trend, error}
    this.queue = [];              // [{symbol, tf, tries}]
    this.batch = { total: 0, done: 0 };
    this.done = new Map();        // tf -> the candle close already queued for
    this.firstSeen = new Map();   // waiting-plan id -> when the scanner first saw it (its age)
    this.inflight = false; this.lastSentAt = 0; this.pausedUntil = 0; this.backoff = 0;
    this.cooldownUntil = 0; this.lastScanAt = 0;
    this.timer = null; this.stopped = false;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try { this.step(); } catch { /* the next step tries again */ }
      if (!this.stopped) { this.timer = setTimeout(loop, Math.max(250, this.gapMs)); this.timer.unref?.(); }
    };
    this.timer = setTimeout(loop, 1000);
    this.timer.unref?.();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }

  online() { const e = this.engine; return !!e.socket && e.connection === "online"; }
  /** The markets being scanned now. */
  watchList() { return pickMarkets(this.engine.markets, { synthetics: this.settings.synthetics }); }
  /** Deriv's market list has loaded (or failed to, after a while: then the built-in synthetic indices). */
  marketsReady() { const e = this.engine; return e.markets.length > 0 || (e.marketsAt > 0 && this.now() - e.marketsAt > 60000); }

  /** Queues every market for these timeframes (a market already waiting is not queued twice). */
  enqueue(tfs) {
    const list = this.watchList();
    if (!this.queue.length && !this.inflight) this.batch = { total: 0, done: 0 };
    for (const tf of tfs) for (const m of list) {
      if (this.queue.some((j) => j.symbol === m.symbol && j.tf === tf)) continue;
      this.queue.push({ symbol: m.symbol, tf, tries: 0 });
      this.batch.total++;
    }
    return list.length;
  }

  /** New candles closed: queue their timeframes. Called by step(). */
  #schedule() {
    if (!this.settings.on || !this.online() || !this.marketsReady()) return;
    const due = [];
    for (const tf of this.settings.timeframes) {
      const b = closedBoundary(this.now(), tf, this.closeDelay);
      if (b > (this.done.get(tf) || 0)) { this.done.set(tf, b); due.push(tf); }
    }
    if (due.length) this.enqueue(due);
  }

  /**
   * One turn: queue what is due, then send at most one request if the gap since the last one
   * has passed, nothing is paused, and the bot isn't placing an order or reloading its trades.
   * Returns true when it sent one (the answer is handled when it comes).
   */
  step() {
    this.#schedule();
    // A finished scan: the bot may take the best ready setup (engine.autoScan does every check).
    if (!this.inflight && !this.queue.length && this.settings.on && this.engine.autoScan) {
      try { this.engine.autoScan(this.ranked().filter((it) => it.status === "ready")); } catch { /* tried again next step */ }
    }
    const e = this.engine, now = this.now();
    if (!this.settings.on || this.inflight || !this.queue.length) return false;
    if (now < this.pausedUntil || now - this.lastSentAt < this.gapMs) return false;
    if (!this.online() || e.busy || (e.trading && e.syncing)) return false;
    const job = this.queue.shift();
    this.inflight = true; this.lastSentAt = now;
    this.#ask(job);
    return true;
  }

  async #ask(job) {
    const e = this.engine;
    try {
      const msg = await e.socket.send({ ticks_history: job.symbol, style: "candles", granularity: job.tf, count: SCAN_BARS[job.tf] || 500,
                                        end: "latest", adjust_start_time: 1 });
      this.backoff = 0;
      this.#store(job, msg.candles || []);
      this.batch.done++;
    } catch (err) {
      if (isRateLimit(err)) {
        // Deriv asked to slow down: this market goes back to the front, and nothing is sent for a while.
        const wait = BACKOFF_MS[Math.min(this.backoff++, BACKOFF_MS.length - 1)];
        this.pausedUntil = this.now() + wait;
        this.queue.unshift(job);
        e.logOnce?.("INFO", "Scanner paused: Deriv asked to slow down", `It carries on in ${Math.round(wait / 60000)} min. The bot's trading is not affected.`);
      } else if (isConnection(err) && job.tries < 2) {
        job.tries++;
        this.queue.unshift(job);
        this.pausedUntil = this.now() + this.gapMs * 5;
      } else {
        this.series.set(`${job.symbol}:${job.tf}`, { at: this.now(), items: [], trend: null, error: String(err?.message || "no answer").slice(0, 120) });
        this.batch.done++;
      }
    } finally {
      this.inflight = false;
      if (!this.queue.length) this.lastScanAt = this.now();
    }
  }

  #store(job, candles) {
    const e = this.engine;
    const synthetic = isSynthetic(e.markets, job.symbol);
    const r = scanSeries({ symbol: job.symbol, name: marketName(e.markets, job.symbol), tf: job.tf, candles, synthetic,
                           model: e.model, aiSettings: e.settings, nowMs: this.now() });
    for (const it of r.items) {
      if (it.status !== "waiting") continue;
      if (!this.firstSeen.has(it.id)) this.firstSeen.set(it.id, it.at);
      it.at = this.firstSeen.get(it.id);
    }
    if (this.firstSeen.size > 500) this.firstSeen.delete(this.firstSeen.keys().next().value);
    this.series.set(`${job.symbol}:${job.tf}`, { at: this.now(), items: r.items, trend: r.trend, error: "" });
  }

  /** "Scan now": every market on every chosen timeframe, at most once per cooldown. */
  scanNow() {
    if (!this.settings.on) throw new UserError("The scanner is off. Turn it on under Settings first.", 409, "scanner_off");
    const wait = this.cooldownUntil - this.now();
    if (wait > 0) throw new UserError(`The scanner just ran. You can scan again in ${Math.ceil(wait / 60000)} min.`, 429, "scanner_cooldown");
    if (!this.online()) throw new UserError("The bot isn't connected to Deriv right now. The scanner carries on once it is.", 409, "not_connected");
    if (!this.marketsReady()) throw new UserError("Deriv's market list is still loading. Please try again in a moment.", 409, "markets_loading");
    const n = this.enqueue(this.settings.timeframes);
    if (!n) throw new UserError(this.#emptyText(), 409, "no_markets");
    this.cooldownUntil = this.now() + this.cooldownMs;
    return this.view();
  }

  /** Applies already cleaned settings, saves them, and scans what is new. */
  updateSettings(next) {
    const prev = this.settings;
    this.settings = { on: !!next.on, synthetics: !!next.synthetics, timeframes: [...next.timeframes] };
    try { this.store?.saveScanner?.(this.settings); } catch { /* disk full: the setting still applies until a restart */ }
    if (!this.settings.on) { this.queue = []; this.batch = { total: 0, done: 0 }; this.done.clear(); return this.view(); }
    // Turned on, more markets, or another timeframe: scan at the next step (not counted as "Scan now").
    if (!prev.on) this.done.clear();
    else {
      const added = this.settings.timeframes.filter((tf) => !prev.timeframes.includes(tf));
      if (this.settings.synthetics && !prev.synthetics) for (const tf of this.settings.timeframes) this.done.delete(tf);
      for (const tf of added) this.done.delete(tf);
      this.queue = this.queue.filter((j) => this.settings.timeframes.includes(j.tf));
    }
    return this.view();
  }

  #emptyText() {
    if (!this.marketsReady()) return "Waiting for Deriv's market list.";
    return this.settings.synthetics ? "Every market the scanner watches is closed right now."
      : "The real markets (forex, gold, stock indices) are closed right now. They open again on weekdays. Turn on synthetic indices to scan them around the clock.";
  }

  /** The setups still valid on the markets and timeframes watched now, ranked as on the page. */
  ranked(watch = this.watchList()) { return this.#collect(watch).items; }

  #collect(watch) {
    const now = this.now(), s = this.settings, symbols = new Set(watch.map((m) => m.symbol));
    const items = [], trends = new Map();
    let failed = 0;
    for (const [key, v] of this.series) {
      const [symbol, tf] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      if (!symbols.has(symbol) || !s.timeframes.includes(tf)) continue;
      if (v.error) failed++;
      trends.set(key, v.trend);
      for (const it of v.items) if (it.validUntil > now) items.push(it);
    }
    return { items: rankItems(items, trends), failed };
  }

  /** What GET /api/scanner returns. */
  view() {
    const now = this.now(), s = this.settings;
    const watch = this.watchList();
    const { items, failed } = this.#collect(watch);
    const scanning = s.on && (this.inflight || this.queue.length > 0);
    const next = s.on ? Math.min(...s.timeframes.map((tf) => ((this.done.get(tf) || closedBoundary(now, tf, this.closeDelay)) + tf + this.closeDelay) * 1000)) : null;
    let message = "";
    if (!s.on) message = "The scanner is off. Turn it on under Settings.";
    else if (!this.online()) message = "Not connected to Deriv right now. The scanner carries on once the bot is connected.";
    else if (!watch.length) message = this.#emptyText();
    else if (now < this.pausedUntil) message = `Deriv asked to slow down, so the scanner waits until ${new Date(this.pausedUntil).toISOString().slice(11, 16)} UTC.`;
    return {
      settings: { ...s, timeframes: [...s.timeframes] }, now, scanning,
      progress: { done: Math.min(this.batch.done, this.batch.total), total: this.batch.total },
      lastScanAt: this.lastScanAt || null, nextScanAt: next, cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : null,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null,
      markets: watch.length, failed, modelLoaded: !!this.engine.model, message,
      auto: this.engine.scanAutoView?.() ?? null,
      items: items.slice(0, MAX_ITEMS).map(({ validUntil, ...it }) => ({ ...it, traded: !!this.engine.scanTraded?.(it.id) })),
    };
  }
}
