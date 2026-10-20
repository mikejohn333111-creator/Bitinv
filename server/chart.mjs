// The control page's chart data. The page never talks to Deriv (it has no token): it asks
// GET /api/candles?tf=…&after=… and draws what comes back with the website's chart code.
//
// On the clock market's 1-minute candles they are the engine's own (its clock stream, plus
// the forming one). Other timeframes are loaded on the engine's Deriv connection with a
// one-off ticks_history, kept per timeframe and asked again at most every 15 seconds; between
// loads the newest candle follows the clock's live price. With a symbol (a scanner setup or an
// open trade) the chart shows that market the same way, loaded on the same connection. The open
// trades' plans come with /api/status.
import { planFromContract } from "../public/js/plan.js";

/** The chart's timeframes in seconds, as on the website (1m, 5m, 15m, 1h, 4h, 1D). */
export const CHART_TIMEFRAMES = [60, 300, 900, 3600, 14400, 86400];
export const CHART_BARS = 500;
const MIN_GAP_MS = 15000;          // one Deriv request per timeframe at most this often
const MAX_AGE_MS = 5 * 60000;      // a timeframe the live price can't keep up to date is loaded again after this
const WAIT_MS = 8000;              // a first load answers "loading" after this; the page asks again
const CACHE_KEEP = 8;              // markets and timeframes kept (the bot's own, and a few scanner setups)

/** A candle as the page gets it: [epoch, open, high, low, close]. */
const row = (b) => [b.epoch, b.open, b.high, b.low, b.close];
const bar = (c) => ({ epoch: Number(c.epoch ?? c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close });

/**
 * The candles the page doesn't have yet. `after` is the time of the newest candle the page
 * has: it gets that one again (it may have changed) and every newer one. With no `after`,
 * or when there would be a gap, it gets them all (full: true) and starts again.
 */
export function candlesAfter(list, after) {
  const t = Number(after);
  if (!(t > 0) || !list.length || list[0].epoch > t) return { full: true, candles: list.map(row) };
  return { full: false, candles: list.filter((b) => b.epoch >= t).map(row) };
}

/**
 * An open trade's plan for the chart, from Deriv's own numbers (entry spot, limit orders) and
 * what the bot knows (c: entryEpoch, horizon, barSec). Like showTradePlan on the website.
 */
export function tradePlan(poc, c, prev = {}) {
  const p = planFromContract(poc, prev);
  const sec = c.barSec || 60;
  if (!p.start && c.entryEpoch) p.start = c.entryEpoch + sec;
  if (c.horizon && c.entryEpoch && !p.end) p.end = c.entryEpoch + (c.horizon + 1) * sec;
  return p;
}

/** The plan fields the page needs (no stake, multiplier or internal state). */
export function planView(p) {
  if (!p) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return { side: p.side, entry: num(p.entry), sl: num(p.sl), tp: num(p.tp), slMoney: num(p.slMoney), tpMoney: num(p.tpMoney),
           start: num(p.start), end: num(p.end) };
}

export class ChartFeed {
  /**
   * @param {TradingEngine} engine  its settings, tf(), bars, forming, socket and connection are read
   * @param {object} [o]            now (clock in ms), minGapMs, waitMs: for tests
   */
  constructor(engine, { now = Date.now, minGapMs = MIN_GAP_MS, waitMs = WAIT_MS } = {}) {
    Object.assign(this, { engine, now, minGapMs, waitMs });
    this.cache = new Map();          // "symbol:tf" -> {symbol, bars, forming, at, loading, failed}
  }

  /**
   * The answer for GET /api/candles. Throws a RangeError for a timeframe the chart doesn't have.
   * `symbol` is another market than the bot's (a scanner setup); the caller checks it is a known one.
   */
  async candles(tf, after, symbol) {
    tf = Number(tf);
    if (!CHART_TIMEFRAMES.includes(tf)) throw new RangeError("Unknown chart timeframe.");
    const e = this.engine, own = e.symbol, botTf = e.tf();
    symbol = symbol || own;
    let list, failed = false;
    if (symbol === own && tf === botTf) list = [...e.bars.slice(-(CHART_BARS - 1)), ...(e.forming ? [e.forming] : [])];
    else ({ list, failed } = await this.#other(tf, symbol, symbol === own ? botTf : 0));
    const online = e.connection === "online";
    const message = list.length ? ""
      : !online ? "Not connected to Deriv right now. The chart shows once the bot is connected."
      : failed ? "Deriv didn't send these candles. Trying again shortly."
      : "Loading prices from Deriv.";
    return { symbol, tf, botTf, live: online, ...candlesAfter(list, after), message };
  }

  /** botTf is 0 for a market the bot isn't watching: then nothing follows the live price between loads. */
  async #other(tf, symbol, botTf) {
    const key = `${symbol}:${tf}`;
    let c = this.cache.get(key);
    const e = this.engine, now = this.now();
    // A bigger timeframe than the bot's follows the live price: the bot's forming candle lies inside the chart's.
    const follows = botTf > 0 && tf > botTf && tf % botTf === 0;
    if (c?.forming && follows && e.forming) {
      const start = Math.floor(e.forming.epoch / tf) * tf, f = c.forming;
      if (start === f.epoch) c.forming = { ...f, high: Math.max(f.high, e.forming.high), low: Math.min(f.low, e.forming.low), close: e.forming.close };
      else if (start > f.epoch) c.rolled = true;   // a new candle began: load again
    }
    const due = !c || (now - c.at >= this.minGapMs && (!follows || c.rolled || now - c.at >= MAX_AGE_MS || !c.forming));
    if (due && !c?.loading && e.socket && e.connection === "online") {
      if (!c) {
        c = { symbol, bars: [], forming: null, at: 0 };
        this.cache.set(key, c);
        // Old markets and timeframes are dropped (the oldest first), so the cache stays small.
        for (const [k, v] of this.cache) if (this.cache.size > CACHE_KEEP && v !== c && !v.loading) this.cache.delete(k);
      }
      c.at = now;
      c.loading = this.#load(tf, symbol, c, key).finally(() => { c.loading = null; });
    }
    // The first load is waited for (a little); later ones happen behind the cached candles.
    if (c?.loading && !c.bars.length && !c.forming) {
      let timer;
      await Promise.race([c.loading, new Promise((r) => { timer = setTimeout(r, this.waitMs); })]);
      clearTimeout(timer);
    }
    if (!c) return { list: [], failed: false };
    return { list: [...c.bars, ...(c.forming ? [c.forming] : [])], failed: !!c.failed && !c.loading };
  }

  async #load(tf, symbol, c, key) {
    try {
      const msg = await this.engine.socket.send({ ticks_history: symbol, style: "candles", granularity: tf, count: CHART_BARS,
                                                  end: "latest", adjust_start_time: 1 });
      if (this.cache.get(key) !== c) return;   // dropped meanwhile
      const all = (msg.candles || []).map(bar).filter((b) => Number.isFinite(b.epoch));
      c.forming = all.pop() || null;
      c.bars = all;
      c.failed = false; c.rolled = false;
      c.at = this.now();
    } catch {
      c.failed = true;   // tried again after minGapMs
    }
  }
}
