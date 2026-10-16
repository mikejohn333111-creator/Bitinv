// ICT upgrades: higher-timeframe bias, premium / discount, order block entries (SMC style)
// and the timeframe- and market-aware settings (ictParamsFor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateICT, ictMinBars, ictHtfBias, ictParamsFor, minBarsFor, htfName, ICT_DEFAULTS } from "../public/js/strategy.js";

const T0 = 1767225600;   // 2026-01-01 00:00 UTC
const mk = (rows, sec = 60) => rows.map(([o, h, l, c], k) => ({ epoch: T0 + k * sec, open: o, high: h, low: l, close: c }));
const flat = (n) => Array.from({ length: n }, () => [100, 100.5, 99.5, 100]);
// a steady ramp from `from` to `to`: no swing highs or lows inside it
const ramp = (n, from, to) => Array.from({ length: n }, (_, k) => { const b = from + ((to - from) * k) / n; return [b, b + 0.5, b - 0.5, b + 0.05 * Math.sign(to - from)]; });
const SETUP = [
  [100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2],
  [98.2, 98.4, 96.5, 97.5],       // sweep of the 97 low; also the last down candle: the order block (96.5 to 98.4)
  [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6],     // displacement above the 101 swing high
  [101.6, 102.5, 101.2, 102.2],   // fair value gap 99 to 101.2
  [102.2, 102.4, 101.6, 101.8],
];
const ENTRY = [101.8, 101.9, 100.8, 101.0];     // back into the gap, high in the range (premium)
const DEEP = [101.8, 101.9, 99.1, 99.3];        // back into the gap, low in the range (discount)
const mirror = (bars) => bars.map((b) => ({ epoch: b.epoch, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
const BIAS = { ...ICT_DEFAULTS, htfBias: "ema", htfMinutes: 15, htfEMA: 5, htfSlopeBars: 1 };

test("ictParamsFor: filters only on real markets, 4h trend on 1 hour, kill zones on 15 minutes", () => {
  for (const g of [60, 900, 3600]) {
    const p = ictParamsFor(g);
    assert.equal(p.htfBias, "off"); assert.equal(p.killZone, false); assert.equal(p.pdFilter, "off");
    assert.equal(p.barMinutes, g / 60);
    assert.equal(p.rMultiple, 2); assert.equal(p.horizonBars, 30);
  }
  assert.deepEqual(ictParamsFor(60, { real: true }), { ...ICT_DEFAULTS, barMinutes: 1 });
  const m15 = ictParamsFor(900, { real: true });
  assert.equal(m15.killZone, true); assert.equal(m15.htfBias, "off");
  const h1 = ictParamsFor(3600, { real: true });
  assert.equal(h1.htfBias, "ema"); assert.equal(h1.htfMinutes, 240); assert.equal(h1.killZone, false); assert.equal(h1.pdFilter, "off");
  assert.equal(ictMinBars(h1), 4 * (50 + 3 + 2), "55 four-hour candles of one-hour bars");
  assert.equal(minBarsFor("ict", 3600), ictMinBars(h1), "history is enough for the real-market filter");
  assert.equal(minBarsFor("ict", 60), ictMinBars());
  assert.deepEqual([15, 60, 240, 1440].map(htfName), ["15m", "1h", "4h", "daily"]);
});

test("higher-timeframe bias reads closed higher-timeframe candles only", () => {
  const up = mk(ramp(150, 90, 100));
  assert.equal(ictHtfBias(up, BIAS), "up");
  assert.equal(ictHtfBias(mirror(up), BIAS), "down");
  assert.equal(ictHtfBias(mk(flat(150)), BIAS), null, "flat: no trend");
  // a crash inside a 15-minute candle that has not closed yet changes nothing
  const crash = [...ramp(150, 90, 100), ...Array.from({ length: 5 }, () => [60, 60.5, 59.5, 60])];
  assert.equal(ictHtfBias(mk(crash), BIAS), "up");
  const closed = [...ramp(150, 90, 100), ...Array.from({ length: 15 }, () => [60, 60.5, 59.5, 60])];
  assert.notEqual(ictHtfBias(mk(closed), BIAS), "up", "once that candle closes, it counts");
  assert.equal(ictHtfBias(up, { ...BIAS, htfBias: "off" }), null);
});

test("structure bias follows the last break of a higher-timeframe swing", () => {
  // 1-hour zigzag on M1 bars: higher highs and higher lows, then a close above the last high
  const legs = [[100, 104], [104, 102], [102, 106], [106, 104], [104, 108], [108, 106], [106, 110]];
  const rows = legs.flatMap(([a, b]) => ramp(120, a, b));
  const p = { ...ICT_DEFAULTS, htfBias: "structure", htfMinutes: 60, htfSwingLookback: 30 };
  assert.equal(ictHtfBias(mk(rows), p), "up");
  assert.equal(ictHtfBias(mirror(mk(rows)), p), "down");
});

test("4h-style bias: a buy with the trend fires and says so; against the trend it does not", () => {
  const withTrend = mk([...ramp(150, 90, 100), ...SETUP, ENTRY]);
  const r = evaluateICT(withTrend, BIAS);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  assert.match(r.reason, /; 15m trend is up$/);
  assert.equal(r.info.htfBias, "up");
  // the same setup without the filter is the plain ICT buy
  assert.equal(evaluateICT(withTrend).action, "BUY");
  const against = mk([...ramp(150, 110, 100), ...SETUP, ENTRY]);
  const a = evaluateICT(against, BIAS);
  assert.notEqual(a.action, "BUY");
  assert.equal(a.pending, undefined);
  assert.equal(evaluateICT(against).action, "BUY", "the plain strategy would have bought");
  // mirrored: a sell with a falling trend
  const s = evaluateICT(mirror(withTrend), BIAS);
  assert.equal(s.action, "SELL");
  assert.match(s.reason, /15m trend is down/);
});

test("no clear higher-timeframe trend: no trades and a note", () => {
  const r = evaluateICT(mk([...flat(150), ...SETUP.slice(0, 5)]), BIAS);
  assert.equal(r.action, null);
  assert.equal(r.info.note, "no clear 15m trend");
});

test("waiting plans obey the bias too", () => {
  const withTrend = mk([...ramp(150, 90, 100), ...SETUP]);
  const r = evaluateICT(withTrend, BIAS);
  assert.equal(r.pending?.side, "BUY");
  assert.match(r.pending.reason, /fair value gap.*15m trend is up$/);
  assert.equal(evaluateICT(mk([...ramp(150, 110, 100), ...SETUP]), BIAS).pending, undefined);
});

test("premium / discount: a buy only in the lower half of the swept low to high range", () => {
  const p = { ...ICT_DEFAULTS, pdFilter: "discount" };
  const lead = flat(ictMinBars());
  assert.equal(evaluateICT(mk([...lead, ...SETUP, ENTRY]), p).action, null, "101.0 is 75% up the 96.5 to 102.5 range");
  const r = evaluateICT(mk([...lead, ...SETUP, DEEP]), p);
  assert.equal(r.action, "BUY");
  assert.match(r.reason, /entry in discount \(47% of the range\)$/);
  const s = evaluateICT(mirror(mk([...lead, ...SETUP, DEEP])), p);
  assert.equal(s.action, "SELL");
  assert.match(s.reason, /entry in premium \(53% of the range\)$/);
  // OTE: 62% to 79% back from the high
  assert.equal(evaluateICT(mk([...lead, ...SETUP, DEEP]), { ...ICT_DEFAULTS, pdFilter: "ote" }).action, null, "53% back is not deep enough");
  // the waiting plan enters at the gap's top (101.2, 78% up): no discount, no plan
  assert.equal(evaluateICT(mk([...lead, ...SETUP]), p).pending, undefined);
});

test("order block entry (SMC): waits for the last down candle before the displacement", () => {
  const p = { ...ICT_DEFAULTS, entryZone: "ob" };
  const lead = flat(ictMinBars());
  const w = evaluateICT(mk([...lead, ...SETUP, ENTRY]), p);
  assert.equal(w.action, null, "101.0 is not back in the order block");
  assert.equal(w.pending.side, "BUY");
  assert.deepEqual(w.pending.zone, [96.5, 98.4]);
  assert.match(w.pending.reason, /Waiting for price to come back to the bullish order block \(96\.500 to 98\.400\)/);
  assert.match(w.pending.id, /^smc:BUY:/);
  const bars = mk([...lead, ...SETUP, ENTRY, [101.0, 101.1, 98.2, 98.6]]);
  const r = evaluateICT(bars, p);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  assert.match(r.reason, /entering the bullish order block \(96\.500 to 98\.400\)/);
  assert.ok(r.slDist > 98.6 - 96.5 && r.slDist < 98.6 - 96.5 + 0.2 * r.atr, `stop beyond the block: ${r.slDist}`);
  const s = evaluateICT(mirror(bars), p);
  assert.equal(s.action, "SELL");
  assert.match(s.reason, /bearish order block/);
  assert.ok(Math.abs(s.slDist - r.slDist) < 1e-9);
  // the gap entry is unchanged by default
  assert.equal(evaluateICT(mk([...lead, ...SETUP, ENTRY])).action, "BUY");
});
