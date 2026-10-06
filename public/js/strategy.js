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

export function rulesMinBars(p = RULES_DEFAULTS) {
  return Math.max(p.htfMinutes * (p.htfEMA + p.htfSlopeBars + 2), p.slowEMA * 3, 2 * p.adxPeriod + 2, 60);
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
