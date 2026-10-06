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

/** Groups M1 bars into higher-timeframe bars; drops the last group if it is incomplete. */
export function aggregate(bars, minutes) {
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
  if (last && last.lastEpoch < last.epoch + sec - 60) out.pop();
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

  const htf = aggregate(bars, p.htfMinutes);
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
};

export function ictMinBars(p = ICT_DEFAULTS) {
  return p.atrPeriod + p.liqLookback + p.sweepWindow + p.entryWindow + 2 * p.swingLen + 6;
}

const flipBar = (b) => ({ epoch: b.epoch, open: -b.open, high: -b.low, low: -b.high, close: -b.close });

/** Looks for a bullish setup that enters on the last bar. Returns null or the setup. */
function ictBullish(bars, tr, p) {
  const i = bars.length - 1, L = p.swingLen;
  const H = (j) => bars[j].high, Lo = (j) => bars[j].low;
  const isHigh = (j) => { if (j - L < 0 || j + L > i) return false;
    for (let k = 1; k <= L; k++) if (!(H(j) > H(j - k) && H(j) > H(j + k))) return false; return true; };
  const isLow = (j) => { if (j - L < 0 || j + L > i) return false;
    for (let k = 1; k <= L; k++) if (!(Lo(j) < Lo(j - k) && Lo(j) < Lo(j + k))) return false; return true; };
  const atrI = atrAt(tr, p.atrPeriod, i);
  if (!(atrI > 0)) return null;

  // d = structure-shift (displacement) bar; the gap needs bar d+1 closed, entry at i >= d+2
  for (let d = i - 2; d >= Math.max(p.atrPeriod, i - p.entryWindow); d--) {
    const bd = bars[d], atrD = atrAt(tr, p.atrPeriod, d - 1);
    if (!(atrD > 0) || bd.close - bd.open < p.dispATR * atrD) continue;
    // sweep bar s in [d - sweepWindow, d - 1], most recent first
    for (let s = d - 1; s >= Math.max(1, d - p.sweepWindow); s--) {
      // the swing low being swept: most recent one already confirmed before s
      let pv = -1;
      for (let j = s - 1 - L; j >= Math.max(L, s - p.liqLookback); j--) if (isLow(j)) { pv = j; break; }
      if (pv < 0) continue;
      const level = Lo(pv);
      if (!(Lo(s) < level && bars[s].close > level)) continue;
      // the pool must still be untouched until the sweep bar
      let untaken = true;
      for (let j = pv + 1; j < s; j++) if (Lo(j) < level) { untaken = false; break; }
      if (!untaken) continue;
      // internal swing high after the swept low, confirmed before d
      let q = -1;
      for (let j = d - 1 - L; j > pv; j--) if (isHigh(j)) { q = j; break; }
      if (q < 0) continue;
      const mss = H(q);
      if (!(bd.close > mss)) continue;
      let firstBreak = true;
      for (let j = Math.max(q + 1, s); j < d; j++) if (bars[j].close > mss) { firstBreak = false; break; }
      if (!firstBreak) continue;
      let sweepLow = Infinity;
      for (let j = s; j <= d; j++) sweepLow = Math.min(sweepLow, Lo(j));
      // fair value gap from the displacement leg: centre c in [s+1, d], nearest to d
      let gap = null;
      for (let c = d; c >= s + 1; c--) {
        const bot = H(c - 1), top = Lo(c + 1);
        if (top - bot > p.fvgMinATR * atrD && top > bot) { gap = { c, bot, top }; break; }
      }
      if (!gap) continue;
      // first revisit must be the last bar; stop must not have been hit since
      let ok = i >= gap.c + 2;
      for (let j = gap.c + 2; ok && j < i; j++) if (Lo(j) <= gap.top) ok = false;
      for (let j = d + 1; ok && j <= i; j++) if (Lo(j) <= sweepLow) ok = false;
      const b = bars[i];
      if (!ok || !(Lo(i) <= gap.top && b.close > gap.bot)) return null;  // most recent shift decides
      const entry = b.close;
      const slDist = entry - sweepLow + p.stopBufferATR * atrI;
      if (slDist < p.minStopATR * atrI) return null;
      let tpDist = p.rMultiple * slDist, targetNote = `${p.rMultiple}R`;
      if (p.target === "liquidity") {
        let best = Infinity;
        for (let j = i - L; j >= Math.max(L, i - p.liqLookback); j--) if (isHigh(j) && H(j) > entry) best = Math.min(best, H(j));
        if (Number.isFinite(best)) { tpDist = best - entry; targetNote = "the nearest swing high"; }
      }
      return { level, mss, sweepLow, gap, entry, slDist, tpDist, targetNote, sweepAgo: i - s, atr: atrI };
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
  const bull = ictBullish(bars, tr, p);
  if (bull) {
    return { ...res, action: "BUY", slDist: bull.slDist, tpDist: bull.tpDist, horizonBars: p.horizonBars,
      info: { ...res.info, sweptLevel: bull.level, structureLevel: bull.mss, gapLow: bull.gap.bot, gapHigh: bull.gap.top },
      reason: `Swept the low at ${fmt(bull.level)}, broke structure up above ${fmt(bull.mss)}, ` +
              `entering the fair value gap (${fmt(bull.gap.bot)} to ${fmt(bull.gap.top)}); target ${bull.targetNote}` };
  }
  const bear = ictBullish(bars.map(flipBar), tr, p);   // true ranges are identical on flipped bars
  if (bear) {
    return { ...res, action: "SELL", slDist: bear.slDist, tpDist: bear.tpDist, horizonBars: p.horizonBars,
      info: { ...res.info, sweptLevel: -bear.level, structureLevel: -bear.mss, gapLow: -bear.gap.top, gapHigh: -bear.gap.bot },
      reason: `Swept the high at ${fmt(-bear.level)}, broke structure down below ${fmt(-bear.mss)}, ` +
              `entering the fair value gap (${fmt(-bear.gap.top)} to ${fmt(-bear.gap.bot)}); target ` +
              bear.targetNote.replace("swing high", "swing low") };
  }
  return res;
}
