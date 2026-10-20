// Strategies for the Tbot web bot. Pure functions: no DOM, no network, so they
// run the same in the browser, in the backtester and in the tests.
//
// Bars are {epoch, open, high, low, close}, oldest first, and only CLOSED bars
// are passed in: the last element is the bar that just finished.

// ---------------------------------------------------------------- indicators
export function trueRanges(bars) {
  return bars.map((b, i) =>
    i === 0 ? b.high - b.low
            : Math.max(b.high, bars[i - 1].close) - Math.min(b.low, bars[i - 1].close));
}

export function emaSeries(values, n) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  out[n - 1] = s / n;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

const mean = (a, from, to) => { let s = 0; for (let i = from; i <= to; i++) s += a[i]; return s / (to - from + 1); };

/** Average true range as a simple mean of the last n true ranges (MT5 iATR style). */
export function atrAt(tr, n, i) { return i + 1 >= n ? mean(tr, i - n + 1, i) : NaN; }

/** Wilder RSI series. */
export function rsiSeries(close, n) {
  const out = new Array(close.length).fill(NaN);
  if (close.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = close[i] - close[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Wilder ADX with +DI / -DI. */
export function adxSeries(bars, n) {
  const len = bars.length;
  const adx = new Array(len).fill(NaN), pdi = new Array(len).fill(NaN), mdi = new Array(len).fill(NaN);
  if (len < 2 * n + 1) return { adx, pdi, mdi };
  const tr = trueRanges(bars);
  let sTR = 0, sP = 0, sM = 0;
  const dx = new Array(len).fill(NaN);
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high, dn = bars[i - 1].low - bars[i].low;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { sTR += tr[i]; sP += p; sM += m; if (i < n) continue; }
    else { sTR = sTR - sTR / n + tr[i]; sP = sP - sP / n + p; sM = sM - sM / n + m; }
    pdi[i] = sTR > 0 ? (100 * sP) / sTR : 0;
    mdi[i] = sTR > 0 ? (100 * sM) / sTR : 0;
    const s = pdi[i] + mdi[i];
    dx[i] = s > 0 ? (100 * Math.abs(pdi[i] - mdi[i])) / s : 0;
  }
  let a = 0;
  for (let i = n; i < 2 * n; i++) a += dx[i];
  adx[2 * n - 1] = a / n;
  for (let i = 2 * n; i < len; i++) adx[i] = (adx[i - 1] * (n - 1) + dx[i]) / n;
  return { adx, pdi, mdi };
}

export function bollingerAt(close, n, dev, i) {
  if (i + 1 < n) return null;
  const m = mean(close, i - n + 1, i);
  let v = 0;
  for (let j = i - n + 1; j <= i; j++) v += (close[j] - m) ** 2;
  const sd = Math.sqrt(v / n);
  return { mid: m, upper: m + dev * sd, lower: m - dev * sd };
}

/**
 * Groups bars of barMinutes (default M1) into higher-timeframe bars; drops the last group if
 * it is incomplete. Bars are stamped with their start time, as Deriv sends them.
 */
export function aggregate(bars, minutes, barMinutes = 1) {
  const sec = minutes * 60, out = [];
  for (const b of bars) {
    const start = Math.floor(b.epoch / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.epoch === start) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low);
      last.close = b.close; last.lastEpoch = b.epoch;
    } else out.push({ epoch: start, open: b.open, high: b.high, low: b.low, close: b.close, lastEpoch: b.epoch });
  }
  const last = out[out.length - 1];
  if (last && last.lastEpoch < last.epoch + sec - Math.max(60, barMinutes * 60)) out.pop();
  return out;
}

// ---------------------------------------------------------- rules strategy
// A port of TbotAdaptive.mq5: ADX regime filter, trend pullback entries in the
// direction of the higher timeframe, Bollinger mean reversion in ranges.
export const RULES_DEFAULTS = {
  htfMinutes: 15, adxPeriod: 14, adxTrend: 25, adxRange: 20,
  useTrend: true, fastEMA: 21, slowEMA: 50, htfEMA: 50, htfSlopeBars: 3, pullbackATR: 0.3,
  rsiPeriod: 14, rsiTrendMin: 50, rsiTrendMax: 70, trendSL: 1.5, trendTP: 3.0,
  useRange: true, bbPeriod: 20, bbDev: 2.0, rsiOversold: 30, rangeSL: 1.2, rangeTP: 1.5,
  atrPeriod: 14, maxATRSpike: 2.5,
};

/** How long a "Waiting for price" plan stays valid, in bars of the strategy's timeframe. */
export const PENDING_BARS = 30;
/** Seconds per bar, read from the bars themselves (the last two closed bars). */
export function barSeconds(bars) {
  const n = bars?.length || 0;
  const d = n >= 2 ? bars[n - 1].epoch - bars[n - 2].epoch : 0;
  return d > 0 ? d : 60;
}

// ------------------------------------------------------- strategy timeframe
// "Bot trades on": the candles the strategy reads. The chart's own timeframe is separate.
export const BOT_TIMEFRAMES = [60, 900, 3600];
export const botTfOf = (s) => (BOT_TIMEFRAMES.includes(+s?.botTf) ? +s.botTf : 60);
/** Rules settings for a bot timeframe: the higher timeframe follows TbotAdaptive (M1 -> M15, M15 -> H1, H1 -> H4). */
export function rulesParamsFor(granularity = 60) {
  const m = Math.max(1, Math.round(granularity / 60));
  return { ...RULES_DEFAULTS, barMinutes: m, htfMinutes: m <= 1 ? 15 : m * 4 };
}
/**
 * ICT settings for a bot timeframe and market. The extra filters are only on for real markets
 * (forex, commodities and the like): Deriv's synthetic indices are a random number generator
 * around the clock, with no sessions and no higher-timeframe trend that means anything.
 * Chosen on EURUSD 2018-2025 (docs/strategy-results.md, 16 October 2026):
 *   1 hour:     4h trend filter (EMA 50 on 4-hour candles): it was not worse out of sample.
 *   15 minutes: kill zones (London 07-10, New York 12-15 UTC): not worse out of sample.
 * Neither is proof of an edge; premium/discount and the OTE tested worse and stay off.
 * Audit of 20 October 2026 (11 markets, 2010-2021 to choose, 2022-2025 to test once):
 *   1 hour: also MSS by close (mssClose) and a later gap when the first is missed
 *   (fvgAfterBars 10). About 60% more trades and not worse out of sample, though still
 *   below zero after costs. On 15 minutes the pick (fvgAfterBars) was worse out of sample: off.
 */
export function ictParamsFor(granularity = 60, { real = false } = {}) {
  const m = Math.max(1, Math.round(granularity / 60));
  const p = { ...ICT_DEFAULTS, barMinutes: m };
  if (!real) return p;
  if (m === 60) return { ...p, htfBias: "ema", htfMinutes: 240, htfEMA: 50, mssClose: true, fvgAfterBars: 10 };
  if (m === 15) return { ...p, killZone: true };
  return p;
}
/** Closed bars a strategy needs before it can decide anything, on this timeframe. */
export function minBarsFor(strategy, granularity = 60) {
  if (strategy === "ai") return AI_MIN_BARS;
  if (strategy === "ict") return ictMinBars(ictParamsFor(granularity, { real: true }));   // enough for either market
  return rulesMinBars(rulesParamsFor(granularity));
}
/**
 * How many candles to ask Deriv for: the strategy's minimum with room to spare, at least
 * 1200 on the 1-minute chart (the chart shows them), and never more than Deriv's 5000.
 */
export function historyCount(strategy, granularity = 60) {
  const need = Math.ceil(minBarsFor(strategy, granularity) * 1.5) + 50;
  return Math.min(5000, Math.max(need, granularity <= 60 ? 1200 : 300));
}

// p.barMinutes (default 1) lets the backtester feed M15 or H1 bars instead of M1.
export function rulesMinBars(p = RULES_DEFAULTS) {
  const perHtf = Math.ceil(p.htfMinutes / (p.barMinutes || 1));
  return Math.max(perHtf * (p.htfEMA + p.htfSlopeBars + 2), p.slowEMA * 3, 2 * p.adxPeriod + 2, 60);
}

export function evaluateRules(bars, p = RULES_DEFAULTS) {
  const res = { action: null, info: {} };
  if (bars.length < rulesMinBars(p)) { res.info.note = "loading history"; return res; }
  const i = bars.length - 1;
  const close = bars.map((b) => b.close);
  const tr = trueRanges(bars);
  const atr = atrAt(tr, p.atrPeriod, i);
  const fast = emaSeries(close, p.fastEMA)[i], slow = emaSeries(close, p.slowEMA)[i];
  const { adx, pdi, mdi } = adxSeries(bars, p.adxPeriod);
  const rsi = rsiSeries(close, p.rsiPeriod);
  const bb1 = bollingerAt(close, p.bbPeriod, p.bbDev, i), bb2 = bollingerAt(close, p.bbPeriod, p.bbDev, i - 1);

  const htf = aggregate(bars, p.htfMinutes, p.barMinutes || 1);
  const htfClose = htf.map((b) => b.close);
  const htfEma = emaSeries(htfClose, p.htfEMA);
  const h = htf.length - 1;
  const htf1 = htfEma[h], htfN = htfEma[h - p.htfSlopeBars], htfC1 = htfClose[h];

  const regime = adx[i] >= p.adxTrend ? "TREND" : adx[i] <= p.adxRange ? "RANGE" : "UNCLEAR";
  res.atr = atr;
  res.info = { regime, adx: adx[i], rsi: rsi[i], atr };
  if (![atr, fast, slow, adx[i], pdi[i], mdi[i], rsi[i], rsi[i - 1], htf1, htfN].every(Number.isFinite) || !bb1 || !bb2) {
    res.info.note = "loading history"; return res;
  }
  if (p.maxATRSpike > 0) {
    const avg = mean(tr, i - 49, i);
    if (atr > p.maxATRSpike * avg) { res.info.note = "volatility spike"; return res; }
  }
  const htfUp = htfC1 > htf1 && htf1 > htfN, htfDown = htfC1 < htf1 && htf1 < htfN;
  const b1 = bars[i], c2 = bars[i - 1].close;

  if (p.useTrend && regime === "TREND") {
    const buy = htfUp && fast > slow && pdi[i] > mdi[i] && b1.low <= fast + p.pullbackATR * atr &&
      b1.close > fast && b1.close > b1.open && rsi[i] > p.rsiTrendMin && rsi[i] < p.rsiTrendMax;
    const sell = htfDown && fast < slow && mdi[i] > pdi[i] && b1.high >= fast - p.pullbackATR * atr &&
      b1.close < fast && b1.close < b1.open && rsi[i] < 100 - p.rsiTrendMin && rsi[i] > 100 - p.rsiTrendMax;
    if (buy || sell)
      return { ...res, action: buy ? "BUY" : "SELL", slDist: p.trendSL * atr, tpDist: p.trendTP * atr,
               reason: `trend pullback ${buy ? "buy" : "sell"} (ADX ${adx[i].toFixed(0)})` };
  }
  if (p.useRange && regime === "RANGE") {
    const buy = c2 < bb2.lower && b1.close > bb1.lower && rsi[i - 1] < p.rsiOversold && rsi[i] > rsi[i - 1] &&
      b1.close > b1.open && !htfDown;
    const sell = c2 > bb2.upper && b1.close < bb1.upper && rsi[i - 1] > 100 - p.rsiOversold && rsi[i] < rsi[i - 1] &&
      b1.close < b1.open && !htfUp;
    if (buy || sell)
      return { ...res, action: buy ? "BUY" : "SELL", slDist: p.rangeSL * atr, tpDist: p.rangeTP * atr,
               reason: `range reversion ${buy ? "buy" : "sell"} (ADX ${adx[i].toFixed(0)})` };
  }
  return res;
}

// --------------------------------------------------------------- AI strategy
// Same 17 features as mt5/ai/features.py and TbotAI.mq5, then a small neural
// network (weights in public/model/tbotai-model.json, exported from train.py).
export const AI_DEFAULTS = { threshold: 0.5, margin: 0.1, barrierATR: 3.0, horizonBars: 60 };
// Fast mode (demo only): a looser AI preset that trades every few minutes with small targets.
// It replaces only these values, and only while it is on and the strategy is AI; the user's
// own AI settings and open-trade limit are kept and come back when it is turned off.
// In our tests it was a coin flip and lost money after Deriv's fee. Both bots refuse to use
// it on a real money account.
export const AI_FAST = Object.freeze({ threshold: 0.45, margin: 0.05, barrierATR: 1, horizonBars: 10, maxOpen: 3 });

/** True when fast mode applies to these settings (it only applies to the AI strategy). */
export const fastModeOn = (s) => s?.strategy === "ai" && s?.aiFast === true;

/** The AI parameters for these settings: the fast preset while fast mode is on, else the user's own. */
export function aiParams(s) {
  if (fastModeOn(s)) { const { threshold, margin, barrierATR, horizonBars } = AI_FAST; return { threshold, margin, barrierATR, horizonBars }; }
  return { threshold: +s.aiThreshold, margin: AI_DEFAULTS.margin, barrierATR: +s.aiBarrier, horizonBars: +s.aiHorizon };
}

export const AI_MIN_BARS = 243;
const LAGS = [1, 2, 3, 5, 10, 15, 30, 60];
const clip = (v) => Math.max(-50, Math.min(50, v));

export function aiFeatures(bars) {
  const t = bars.length - 1;
  if (t < AI_MIN_BARS - 1) return null;
  const c = (k) => bars[t - k].close;
  const TR = (j) => Math.max(bars[j].high, bars[j - 1].close) - Math.min(bars[j].low, bars[j - 1].close);
  let s14 = 0, s240 = 0;
  for (let k = 0; k < 240; k++) { const tr = TR(t - k); s240 += tr; if (k < 14) s14 += tr; }
  const atr = s14 / 14, trAvg = s240 / 240;
  if (!(atr > 0) || !(trAvg > 0)) return null;
  const b = bars[t], f = [];
  for (const k of LAGS) f.push((b.close - c(k)) / atr);
  let s20 = 0, s60 = 0;
  for (let k = 0; k < 60; k++) { s60 += c(k); if (k < 20) s20 += c(k); }
  f.push((b.close - s20 / 20) / atr, (b.close - s60 / 60) / atr);
  f.push((b.high - b.low) / atr, (b.close - b.open) / atr,
         (b.high - Math.max(b.open, b.close)) / atr, (Math.min(b.open, b.close) - b.low) / atr);
  let g = 0, l = 0;
  for (let k = 0; k < 14; k++) { const d = c(k) - c(k + 1); if (d > 0) g += d; else l -= d; }
  f.push((g + l > 0 ? g / (g + l) : 0.5) - 0.5);
  f.push(atr / trAvg);
  let hh = -Infinity, ll = Infinity;
  for (let k = 0; k < 60; k++) { hh = Math.max(hh, bars[t - k].high); ll = Math.min(ll, bars[t - k].low); }
  f.push((hh > ll ? (b.close - ll) / (hh - ll) : 0.5) - 0.5);
  return { x: f.map(clip), atr };
}

/** Forward pass of the exported scikit-learn MLP: scaler, ReLU layers, softmax. */
export function mlpPredict(model, x) {
  let a = x.map((v, i) => (v - model.offset[i]) * model.scale[i]);
  model.layers.forEach((L, li) => {
    const out = new Array(L.out).fill(0);
    for (let j = 0; j < L.out; j++) {
      let s = L.b[j];
      for (let i = 0; i < L.in; i++) s += a[i] * L.W[i * L.out + j];
      out[j] = s;
    }
    a = li < model.layers.length - 1 ? out.map((v) => Math.max(0, v)) : out;
  });
  const m = Math.max(...a), e = a.map((v) => Math.exp(v - m)), s = e.reduce((p, v) => p + v, 0);
  return e.map((v) => v / s);   // [P(down), P(none), P(up)]
}

export function evaluateAI(bars, model, p = AI_DEFAULTS) {
  const res = { action: null, info: {} };
  if (!model) { res.info.note = "model not loaded"; return res; }
  const feat = aiFeatures(bars);
  if (!feat) { res.info.note = "loading history"; return res; }
  const [pDn, pNone, pUp] = mlpPredict(model, feat.x);
  res.atr = feat.atr;
  res.info = { pUp, pDn, pNone, atr: feat.atr };
  const dist = p.barrierATR * feat.atr;
  if (pUp >= p.threshold && pUp - pDn >= p.margin)
    return { ...res, action: "BUY", slDist: dist, tpDist: dist, horizonBars: p.horizonBars,
             reason: `AI ${Math.round(pUp * 100)}% up`, confidence: pUp };
  if (pDn >= p.threshold && pDn - pUp >= p.margin)
    return { ...res, action: "SELL", slDist: dist, tpDist: dist, horizonBars: p.horizonBars,
             reason: `AI ${Math.round(pDn * 100)}% down`, confidence: pDn };
  return res;
}

// -------------------------------------------------------------- ICT strategy
// A mechanical version of a common "ICT" one-minute setup:
//   1. liquidity: the most recent swing low (or high) within liqLookback bars,
//      not yet traded through;
//   2. sweep: a bar wicks below that low and closes back above it;
//   3. market structure shift: within sweepWindow bars, a bar with a big body
//      (>= dispATR x ATR) closes above the most recent swing high that formed
//      after the swept low;
//   4. fair value gap: a 3-bar gap left by that up move (bar 3 low > bar 1 high);
//   5. entry: the first time a later closed bar trades back into the gap, at that
//      bar's close, within entryWindow bars of the structure shift.
// Stop goes beyond the sweep extreme plus a small ATR buffer; target is a fixed
// R multiple or the nearest opposite swing ("liquidity"); time exit horizonBars.
// Sells are the exact mirror (the detector runs on price-flipped bars).
// Options (all off in ICT_DEFAULTS; see ictParamsFor for what real markets use): session
// liquidity (previous day, Asian range), breaker block / order block / OTE entries instead of
// the gap, MSS by close with displacement anywhere in the leg, and a later gap when the
// first is missed. Tested in docs/strategy-results.md (20 October 2026).
export const ICT_DEFAULTS = {
  swingLen: 2,          // fractal: a swing high is higher than swingLen bars on each side
  liqLookback: 60,      // the swept swing must be at most this many bars before the sweep
  sweepWindow: 10,      // bars from the sweep to the structure shift
  dispATR: 1.0,         // displacement: body of the breaking bar >= dispATR x ATR
  fvgMinATR: 0.0,       // smallest gap worth trading, in ATR
  entryWindow: 15,      // bars after the structure shift during which the gap may be revisited
  atrPeriod: 14,
  stopBufferATR: 0.1,   // extra stop distance beyond the sweep extreme
  minStopATR: 0.5,      // skip setups with a stop tighter than this (noise)
  target: "R",          // "R" = rMultiple x stop, "liquidity" = nearest opposite swing
  rMultiple: 2,
  horizonBars: 30,
  // Kill zones (UTC London 07-10, New York 12-15). Off by default: Deriv's
  // synthetic indices are generated by a random number generator 24/7, so they
  // have no sessions, no session liquidity and nothing special about these hours.
  killZone: false,
  killZones: [[7, 10], [12, 15]],
  // Higher-timeframe bias: only buy when the higher timeframe trends up, only sell when it
  // trends down. "off", "ema" (last closed higher-timeframe candle above its EMA and the EMA
  // rising) or "structure" (the last higher-timeframe break of a swing was upward).
  // Built from the same bars, closed higher-timeframe candles only.
  htfBias: "off",
  htfMinutes: 240,
  htfEMA: 50,
  htfSlopeBars: 3,
  htfSwingLookback: 60, // higher-timeframe candles searched for swings ("structure")
  barMinutes: 1,        // minutes per bar fed in (the backtester and the bots' timeframe)
  // Premium / discount: "off", "discount" (a buy enters in the lower half of the range from the
  // swept low to the highest high since; sells in the upper half) or "ote" (62% to 79% back).
  pdFilter: "off",
  oteLow: 0.62,
  oteHigh: 0.79,
  // Where price must come back to:
  //   "fvg"     fair value gap (ICT), the default;
  //   "ob"      order block: the last opposite (down) candle before the displacement, as in
  //             Smart Money Concepts; stop beyond it;
  //   "breaker" breaker block (ICT): the last up-close candle before the down move that ran the
  //             swept low. Once displacement closes above it, that candle flips from resistance
  //             to support; entry when price comes back to it, stop beyond the sweep's low;
  //   "ote"     optimal trade entry (ICT): price retraces 62% to 79% (oteLow / oteHigh) of the
  //             dealing range from the swept low to the highest high since; stop beyond the low.
  entryZone: "fvg",
  // Extra liquidity pools besides swing points (both ICT "draws on liquidity"), checked after
  // the swing low:
  //   liqPrevDay: the previous trading day's low (high for sells); Monday looks at Friday;
  //   liqAsia:    today's Asian session low (high), asiaHours in UTC, swept after the session ends.
  liqPrevDay: false,
  liqAsia: false,
  asiaHours: [0, 5],
  // Market structure shift by a close beyond structure: the first close above the internal
  // swing high is the shift whatever its size, and the displacement (a body of at least
  // dispATR x ATR) may be any bar of the leg from the sweep to that close. Off: the breaking
  // bar itself must be the displacement candle (stricter).
  mssClose: false,
  // Re-entry on a later gap: fair value gaps that form up to fvgAfterBars bars after the shift
  // count too. The newest gap is the entry as long as no gap of the setup has been revisited, so
  // when price runs on without coming back to the first gap ("missed"), the next gap of the
  // same leg is used instead. 0 = only gaps of the displacement leg up to the shift (as before).
  fvgAfterBars: 0,
};

/** Closed bars needed for the higher-timeframe bias (0 when it is off). */
function htfBarsNeeded(p) {
  if (!p.htfBias || p.htfBias === "off") return 0;
  const per = Math.ceil(p.htfMinutes / (p.barMinutes || 1));
  return per * ((p.htfBias === "ema" ? p.htfEMA + p.htfSlopeBars : p.htfSwingLookback) + 2);
}

/** Closed bars needed for session liquidity: back past the start of the previous trading day (Friday on a Monday). */
function sessionBarsNeeded(p) {
  if (!p.liqPrevDay && !p.liqAsia) return 0;
  const days = p.liqPrevDay ? 4 : 1;
  return Math.min(4000, Math.ceil((days * 1440) / (p.barMinutes || 1)) + p.sweepWindow + p.entryWindow + 5);
}

export function ictMinBars(p = ICT_DEFAULTS) {
  return Math.max(p.atrPeriod + p.liqLookback + p.sweepWindow + p.entryWindow + 2 * p.swingLen + 6, htfBarsNeeded(p), sessionBarsNeeded(p));
}

/** Plain-words name of a higher timeframe in minutes: "4h", "daily", "15m". */
export const htfName = (m) => (m >= 1440 && m % 1440 === 0 ? (m === 1440 ? "daily" : `${m / 1440}-day`) : m >= 60 ? `${m / 60}h` : `${m}m`);

/**
 * The higher-timeframe trend from closed higher-timeframe candles only: "up", "down" or null.
 *   ema:       last closed candle above EMA(htfEMA) and the EMA higher than htfSlopeBars candles ago (mirror for down).
 *   structure: the most recent close beyond a confirmed swing (fractal of 2) decides: above a swing high = up.
 */
export function ictHtfBias(bars, p = ICT_DEFAULTS) {
  if (!p.htfBias || p.htfBias === "off") return null;
  const htf = aggregate(bars, p.htfMinutes, p.barMinutes || 1);
  const h = htf.length - 1;
  if (p.htfBias === "ema") {
    const ema = emaSeries(htf.map((b) => b.close), p.htfEMA);
    const e1 = ema[h], eN = ema[h - p.htfSlopeBars], c = htf[h]?.close;
    if (![e1, eN, c].every(Number.isFinite)) return null;
    return c > e1 && e1 > eN ? "up" : c < e1 && e1 < eN ? "down" : null;
  }
  // structure: walk forward; a swing is known 2 candles after it formed
  const L = 2, from = Math.max(0, h - p.htfSwingLookback);
  let hi = NaN, lo = NaN, trend = null;
  for (let k = from + 2 * L; k <= h; k++) {
    const j = k - L;
    let isH = true, isL = true;
    for (let m = 1; m <= L; m++) {
      if (!(htf[j].high > htf[j - m].high && htf[j].high > htf[j + m].high)) isH = false;
      if (!(htf[j].low < htf[j - m].low && htf[j].low < htf[j + m].low)) isL = false;
    }
    if (isH) hi = htf[j].high;
    if (isL) lo = htf[j].low;
    if (htf[k].close > hi) { trend = "up"; hi = NaN; }
    else if (htf[k].close < lo) { trend = "down"; lo = NaN; }
  }
  return trend;
}

const flipBar = (b) => ({ epoch: b.epoch, open: -b.open, high: -b.low, low: -b.high, close: -b.close });

// UTC calendar helpers for session liquidity. Bars are stamped anywhere inside the candle
// (Deriv: its open; the backtester: its last minute), so the hour and day of the stamp are the candle's.
const utcDay = (e) => Math.floor(e / 86400);
const utcHour = (e) => Math.floor((((e % 86400) + 86400) % 86400) / 3600);
const isWeekend = (e) => { const w = (utcDay(e) + 4) % 7; return w === 0 || w === 6; };   // 1970-01-01 was a Thursday

/**
 * Looks for a bullish setup. Returns null, a setup that enters on the last bar
 * ({kind: "entry"}), or one that has formed and waits for price to come back to the gap
 * ({kind: "pending"}).
 */
function ictBullish(bars, tr, p, waiting = false) {
  const i = bars.length - 1, L = p.swingLen, zoneKind = p.entryZone || "fvg", ob = zoneKind === "ob";
  // A gap is known one bar after the displacement bar closes; an order block, breaker or OTE
  // range when the displacement bar closes.
  const newest = i - (zoneKind === "fvg" ? 2 : 1) + (waiting ? 1 : 0);
  const H = (j) => bars[j].high, Lo = (j) => bars[j].low;
  const isHigh = (j) => { if (j - L < 0 || j + L > i) return false;
    for (let k = 1; k <= L; k++) if (!(H(j) > H(j - k) && H(j) > H(j + k))) return false; return true; };
  const isLow = (j) => { if (j - L < 0 || j + L > i) return false;
    for (let k = 1; k <= L; k++) if (!(Lo(j) < Lo(j - k) && Lo(j) < Lo(j + k))) return false; return true; };
  const atrI = atrAt(tr, p.atrPeriod, i);
  if (!(atrI > 0)) return null;

  // Session liquidity for a sweep at bar s (previous day's low, today's Asian low), worked out
  // once per day. A level counts only when the window holds the whole session it comes from.
  const sessions = new Map();
  const sessionPools = (s) => {
    if (!p.liqPrevDay && !p.liqAsia) return [];
    const day = utcDay(bars[s].epoch);
    let e = sessions.get(day);
    if (!e) {
      e = {};
      let t0 = s;
      while (t0 > 0 && utcDay(bars[t0 - 1].epoch) === day) t0--;
      if (t0 > 0 && p.liqAsia) {
        let lo = Infinity, at = -1;
        for (let j = t0; j <= i && utcDay(bars[j].epoch) === day; j++) {
          const h = utcHour(bars[j].epoch);
          if (h >= p.asiaHours[1]) break;
          if (h >= p.asiaHours[0] && Lo(j) < lo) { lo = Lo(j); at = j; }
        }
        if (at >= 0) e.asia = { level: lo, bar: at, pool: "asia" };
      }
      if (t0 > 0 && p.liqPrevDay) {
        let j = t0 - 1;
        while (j >= 0 && isWeekend(bars[j].epoch)) j--;     // Monday looks at Friday
        if (j >= 0) {
          const pd = utcDay(bars[j].epoch);
          let lo = Infinity, at = -1;
          for (; j >= 0 && utcDay(bars[j].epoch) === pd; j--) if (Lo(j) <= lo) { lo = Lo(j); at = j; }
          if (j >= 0) e.prev = { level: lo, bar: at, pool: "prevDay" };   // j >= 0: the whole day is in the window
        }
      }
      sessions.set(day, e);
    }
    const out = [];
    if (e.prev) out.push(e.prev);
    if (e.asia && utcHour(bars[s].epoch) >= p.asiaHours[1]) out.push(e.asia);
    return out;
  };

  // d = structure-shift (displacement) bar; the gap needs bar d+1 closed, entry at i >= d+2.
  // Entries scan from d = i - 2 (as backtested). Waiting setups also look at d = i - 1,
  // where the gap has only just formed on the last bar.
  for (let d = newest; d >= Math.max(p.atrPeriod, i - p.entryWindow); d--) {
    const bd = bars[d], atrD = atrAt(tr, p.atrPeriod, d - 1);
    if (!(atrD > 0)) continue;
    // Default: the breaking bar itself is the displacement. mssClose: any close beyond structure
    // is the shift; the displacement is checked on the whole leg below.
    if (!p.mssClose && bd.close - bd.open < p.dispATR * atrD) continue;
    // sweep bar s in [d - sweepWindow, d - 1], most recent first
    for (let s = d - 1; s >= Math.max(1, d - p.sweepWindow); s--) {
      // The pools that may be swept: the most recent swing low already confirmed before s,
      // then (options) the previous day's low and the Asian session low.
      const pools = [];
      for (let j = s - 1 - L; j >= Math.max(L, s - p.liqLookback); j--) if (isLow(j)) { pools.push({ level: Lo(j), bar: j, pool: "swing" }); break; }
      pools.push(...sessionPools(s));
      for (const { level, bar: pv, pool } of pools) {
        if (!(Lo(s) < level && bars[s].close > level)) continue;
        // the pool must still be untouched until the sweep bar
        let untaken = true;
        for (let j = pv + 1; j < s; j++) if (Lo(j) < level) { untaken = false; break; }
        if (!untaken) continue;
        // internal swing high after the swept low, confirmed before d
        let q = -1;
        for (let j = d - 1 - L; j > Math.max(pv, s - p.liqLookback); j--) if (isHigh(j)) { q = j; break; }
        if (q < 0) continue;
        const mss = H(q);
        if (!(bd.close > mss)) continue;
        let firstBreak = true;
        for (let j = Math.max(q + 1, s); j < d; j++) if (bars[j].close > mss) { firstBreak = false; break; }
        if (!firstBreak) continue;
        if (p.mssClose) {   // displacement somewhere in the leg from the sweep to the shift
          let body = -Infinity;
          for (let j = s; j <= d; j++) body = Math.max(body, bars[j].close - bars[j].open);
          if (body < p.dispATR * atrD) continue;
        }
        let sweepLow = Infinity;
        for (let j = s; j <= d; j++) sweepLow = Math.min(sweepLow, Lo(j));
        // The zone price must come back to. from = first bar that may revisit, formed = bar that completes it.
        //   FVG: the gap from the displacement leg, centre c in [s+1, d], nearest to d; with
        //        fvgAfterBars also gaps centred up to fvgAfterBars bars after d (newest wins).
        //   Order block: the last down candle before the displacement (from the sweep on).
        //   Breaker: the last up-close candle before the sweep (from the swing high on).
        //   OTE: 62% to 79% back from the highest high since the sweep toward the swept low.
        let gap = null, gaps = null;
        if (zoneKind === "ob") {
          for (let k = d - 1; k >= s; k--) if (bars[k].close < bars[k].open) { gap = { bot: Lo(k), top: H(k), start: k, from: d + 1, formed: d }; break; }
        } else if (zoneKind === "breaker") {
          for (let k = s - 1; k >= Math.max(pv + 1, Math.min(q, s - 1) - L); k--) if (bars[k].close > bars[k].open) { gap = { bot: Lo(k), top: H(k), start: k, from: d + 1, formed: d }; break; }
        } else if (zoneKind === "ote") {
          gap = { bot: NaN, top: NaN, start: s, from: d + 1, formed: d, ote: true };
        } else {
          const fvgAt = (c) => { const bot = H(c - 1), top = Lo(c + 1);
            return top - bot > p.fvgMinATR * atrD && top > bot ? { bot, top, start: c - 1, from: c + 2, formed: c + 1 } : null; };
          for (let c = d; c >= s + 1; c--) if ((gap = fvgAt(c))) break;
          if (p.fvgAfterBars > 0) {
            gaps = gap ? [gap] : [];
            for (let c = d + 1; c <= Math.min(d + p.fvgAfterBars, i - 2 + (waiting ? 1 : 0)); c++) { const g = fvgAt(c); if (g) gaps.push(g); }
            gap = gaps.at(-1) || null;
          }
        }
        if (!gap || ((ob || zoneKind === "breaker") && !(gap.top < bd.close))) continue;
        // the stop goes beyond the order block's low (it is at or above the sweep's low), else the sweep's
        const stopLevel = ob ? gap.bot : sweepLow;
        // OTE levels from the dealing range: the swept low to the highest high of bars s..t
        let rh = -Infinity, rhAt = s - 1;
        const oteAt = (t) => { for (; rhAt < t; ) rh = Math.max(rh, H(++rhAt));
          gap.top = rh - p.oteLow * (rh - sweepLow); gap.bot = rh - p.oteHigh * (rh - sweepLow); };
        // first revisit must be the last bar; stop must not have been hit since
        // (the most recent structure shift decides: a used or broken setup means no trade).
        // With later gaps, every gap of the setup must still be untouched ("missed").
        let ok = true;
        for (const g of gaps || [gap]) for (let j = g.from; ok && j < i; j++) {
          if (g.ote) oteAt(j - 1);
          if (Lo(j) <= g.top) ok = false;
        }
        for (let j = d + 1; ok && j <= i; j++) if (Lo(j) <= stopLevel) ok = false;
        if (!ok) return null;
        const b = bars[i];
        if (gap.ote) oteAt(i - 1);
        const touched = i >= gap.from && Lo(i) <= gap.top;
        if (touched && !(b.close > gap.bot)) return null;
        if (gap.ote && !touched) oteAt(i);   // waiting: the zone from every closed bar
        // Waiting: price is still above the gap. The plan enters at the gap's top, the price
        // reaches first, so stop and target are worked out from there.
        const entry = touched ? b.close : gap.top;
        const slDist = entry - stopLevel + p.stopBufferATR * atrI;
        if (slDist < p.minStopATR * atrI) return null;
        // dealing range: the swept low to the highest high since the sweep (closed bars only)
        let rangeHigh = -Infinity;
        for (let j = s; j <= i; j++) rangeHigh = Math.max(rangeHigh, H(j));
        const depth = rangeHigh > sweepLow ? (entry - sweepLow) / (rangeHigh - sweepLow) : 1;   // 0 = the low, 1 = the high
        if (p.pdFilter === "discount" && !(depth <= 0.5)) return null;
        if (p.pdFilter === "ote" && !(depth >= 1 - p.oteHigh && depth <= 1 - p.oteLow)) return null;
        let tpDist = p.rMultiple * slDist, targetNote = `${p.rMultiple}R`;
        if (p.target === "liquidity") {
          let best = Infinity;
          for (let j = i - L; j >= Math.max(L, i - p.liqLookback); j--) if (isHigh(j) && H(j) > entry) best = Math.min(best, H(j));
          if (Number.isFinite(best)) { tpDist = best - entry; targetNote = "the nearest swing high"; }
        }
        return { kind: touched ? "entry" : "pending", level, mss, sweepLow, stopLevel, gap, entry, slDist, tpDist, targetNote,
                 sweepAgo: i - s, atr: atrI, d, gapBar: gap.formed, depth, pool, later: gap.formed > d + 1 };
      }
    }
  }
  return null;
}

export function evaluateICT(bars, p = ICT_DEFAULTS) {
  const res = { action: null, info: {} };
  if (!bars || bars.length < ictMinBars(p)) { res.info.note = "loading history"; return res; }
  const tr = trueRanges(bars);
  const atr = atrAt(tr, p.atrPeriod, bars.length - 1);
  res.atr = atr; res.info = { atr };
  if (p.killZone) {
    const h = new Date(bars[bars.length - 1].epoch * 1000).getUTCHours();
    if (!p.killZones.some(([a, b]) => h >= a && h < b)) { res.info.note = "outside kill zone"; return res; }
  }
  const fmt = (v) => { const a = Math.abs(v); return v.toFixed(a >= 1000 ? 2 : a >= 10 ? 3 : 5); };
  const sec = barSeconds(bars);
  // Higher-timeframe bias: which sides may trade at all.
  const biasOn = p.htfBias && p.htfBias !== "off";
  const bias = biasOn ? ictHtfBias(bars, p) : null;
  if (biasOn) {
    res.info.htfBias = bias || "none";
    if (!bias) { res.info.note = `no clear ${htfName(p.htfMinutes)} trend`; return res; }
    res.info.htfText = `${htfName(p.htfMinutes)} trend is ${bias}, so ${bias === "up" ? "buys" : "sells"} only`;
  }
  const canBuy = !biasOn || bias === "up", canSell = !biasOn || bias === "down";
  // The extra checks in plain words, added to every reason.
  const checks = (q, side) => {
    const out = [];
    if (biasOn) out.push(`${htfName(p.htfMinutes)} trend is ${side === "BUY" ? "up" : "down"}`);
    if (p.pdFilter === "discount" || p.pdFilter === "ote") {
      const pct = Math.round(100 * q.depth), where = side === "BUY" ? "discount" : "premium";
      out.push(p.pdFilter === "ote" ? `entry in the optimal trade entry zone (${100 - pct}% back)`
                                    : `entry in ${where} (${side === "BUY" ? pct : 100 - pct}% of the range)`);
    }
    return out.length ? `; ${out.join("; ")}` : "";
  };
  const ob = p.entryZone === "ob", tag = ob ? "smc" : "ict";
  const zoneName = (side) => { const dir = side === "BUY" ? "bullish" : "bearish";
    return ob ? `${dir} order block` : p.entryZone === "breaker" ? `${dir} breaker block`
         : p.entryZone === "ote" ? "optimal trade entry zone (62% to 79% back)" : "fair value gap"; };
  // What was swept: a swing point, the previous day's low/high or the Asian session's.
  const pooled = (q, side) => { const w = side === "BUY" ? "low" : "high";
    return q.pool === "prevDay" ? `the previous day's ${w}` : q.pool === "asia" ? `the Asian session ${w}` : `the ${w}`; };
  // A setup is named after its structure shift; a later gap (fvgAfterBars) is a new plan.
  const idOf = (q, side) => `${tag}:${side}:${bars[q.d].epoch}${q.later ? `:${bars[q.gapBar].epoch}` : ""}`;
  // A setup that has formed but waits for price: a plan the bot can enter on a later tick.
  const waiting = (q, side) => {
    const s = side === "BUY" ? 1 : -1, v = (x) => s * x;   // mirror prices back for sells
    const sl = v(q.entry - q.slDist), tp = v(q.entry + q.tpDist);
    const zone = side === "BUY" ? [q.gap.bot, q.gap.top] : [-q.gap.top, -q.gap.bot];
    return { ...res, setupId: idOf(q, side),
      info: { ...res.info, sweptLevel: v(q.level), structureLevel: v(q.mss), gapLow: zone[0], gapHigh: zone[1] },
      pending: { id: idOf(q, side), side, zone, sl, tp, sticky: true, since: bars[q.gap.start].epoch,
        expiresAt: bars[q.gapBar].epoch + sec * (1 + (p.pendingBars ?? PENDING_BARS)), invalidateAt: v(q.stopLevel),
        horizonBars: p.horizonBars,
        reason: `Swept ${pooled(q, side)} at ${fmt(v(q.level))} and broke structure ${side === "BUY" ? "up above" : "down below"} ` +
                `${fmt(v(q.mss))}. Waiting for price to come back to the ${zoneName(side)} (${fmt(zone[0])} to ${fmt(zone[1])}); ` +
                `target ${side === "BUY" ? q.targetNote : q.targetNote.replace("swing high", "swing low")}${checks(q, side)}` } };
  };
  const flipped = bars.map(flipBar);   // true ranges are identical on flipped bars
  const bull = canBuy ? ictBullish(bars, tr, p) : null;
  const bear = bull?.kind === "entry" || !canSell ? null : ictBullish(flipped, tr, p);
  if (bull?.kind === "entry") {
    return { ...res, action: "BUY", slDist: bull.slDist, tpDist: bull.tpDist, horizonBars: p.horizonBars, setupId: idOf(bull, "BUY"),
      info: { ...res.info, sweptLevel: bull.level, structureLevel: bull.mss, gapLow: bull.gap.bot, gapHigh: bull.gap.top },
      reason: `Swept ${pooled(bull, "BUY")} at ${fmt(bull.level)}, broke structure up above ${fmt(bull.mss)}, ` +
              `entering the ${zoneName("BUY")} (${fmt(bull.gap.bot)} to ${fmt(bull.gap.top)}); target ${bull.targetNote}${checks(bull, "BUY")}` };
  }
  if (bear?.kind === "entry") {
    return { ...res, action: "SELL", slDist: bear.slDist, tpDist: bear.tpDist, horizonBars: p.horizonBars, setupId: idOf(bear, "SELL"),
      info: { ...res.info, sweptLevel: -bear.level, structureLevel: -bear.mss, gapLow: -bear.gap.top, gapHigh: -bear.gap.bot },
      reason: `Swept ${pooled(bear, "SELL")} at ${fmt(-bear.level)}, broke structure down below ${fmt(-bear.mss)}, ` +
              `entering the ${zoneName("SELL")} (${fmt(-bear.gap.top)} to ${fmt(-bear.gap.bot)}); target ` +
              bear.targetNote.replace("swing high", "swing low") + checks(bear, "SELL") };
  }
  const bullWait = canBuy ? ictBullish(bars, tr, p, true) : null;
  if (bullWait?.kind === "pending") return waiting(bullWait, "BUY");
  const bearWait = canSell ? ictBullish(flipped, tr, p, true) : null;
  if (bearWait?.kind === "pending") return waiting(bearWait, "SELL");
  return res;
}
