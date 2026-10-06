// Hand-built bar sequences for the ICT strategy (sweep, structure shift, fair value gap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateICT, ictMinBars, ICT_DEFAULTS } from "../public/js/strategy.js";

const T0 = 1767225600;   // 2026-01-01 00:00 UTC
const mk = (rows) => rows.map(([o, h, l, c], k) => ({ epoch: T0 + k * 60, open: o, high: h, low: l, close: c }));
// Flat filler: equal highs and lows, so the fractal finds no swings in it. Range 1, so ATR is about 1.
const flat = (n) => Array.from({ length: n }, () => [100, 100.5, 99.5, 100]);

const SETUP = [
  [100, 100.5, 99, 99.2],
  [99.2, 99.4, 98, 98.2],
  [98.2, 98.5, 97, 97.8],     // swing low 97 (the liquidity)
  [97.8, 99, 97.6, 98.8],
  [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2],   // internal swing high 101
  [100.2, 100.4, 99, 99.2],
  [99.2, 99.5, 98, 98.2],
  [98.2, 98.4, 96.5, 97.5],   // sweep: wicks to 96.5, closes back above 97
  [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6], // displacement: body 2.8, closes above 101
  [101.6, 102.5, 101.2, 102.2], // leaves a gap between 99 and 101.2
  [102.2, 102.4, 101.6, 101.8], // does not touch the gap
];
const ENTRY = [101.8, 101.9, 100.8, 101.0];   // trades back into the gap
const bull = (tail = [ENTRY], lead = ictMinBars()) => mk([...flat(lead), ...SETUP, ...tail]);
const mirror = (bars) => bars.map((b) => ({ epoch: b.epoch, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));

test("clean bullish setup fires BUY with the stop below the sweep and a 2R target", () => {
  const bars = bull();
  const r = evaluateICT(bars);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  const entry = bars.at(-1).close;
  assert.ok(r.slDist > entry - 96.5 && r.slDist < entry - 96.5 + 0.2 * r.atr, `slDist ${r.slDist}`);
  assert.ok(Math.abs(r.tpDist - 2 * r.slDist) < 1e-9);
  assert.equal(r.horizonBars, 30);
  assert.match(r.reason, /Swept the low at 97\.000, broke structure up/);
  assert.match(r.reason, /fair value gap/);
  assert.equal(r.info.sweptLevel, 97);
  assert.equal(r.info.structureLevel, 101);
});

test("bearish mirror fires SELL with the same distances", () => {
  const up = evaluateICT(bull());
  const r = evaluateICT(mirror(bull()));
  assert.equal(r.action, "SELL");
  assert.ok(Math.abs(r.slDist - up.slDist) < 1e-9 && Math.abs(r.tpDist - up.tpDist) < 1e-9);
  assert.match(r.reason, /Swept the high at 103\.000, broke structure down/);
});

test("no sweep means no signal", () => {
  const rows = [...flat(ictMinBars()), ...SETUP, ENTRY];
  const k = ictMinBars() + 8;
  rows[k] = [98.2, 98.4, 97.2, 97.5];          // dips to 97.2: never trades below the 97 low
  assert.equal(evaluateICT(mk(rows)).action, null);
});

test("no displacement means no signal", () => {
  const rows = [...flat(ictMinBars()), ...SETUP, ENTRY];
  rows[ictMinBars() + 10] = [100.9, 101.8, 98.7, 101.6];   // closes above 101 but body only 0.7
  assert.equal(evaluateICT(mk(rows)).action, null);
});

test("gap not revisited means no signal, and only the first revisit counts", () => {
  assert.equal(evaluateICT(bull([[101.8, 102.6, 101.5, 102.4]])).action, null);
  assert.equal(evaluateICT(bull([ENTRY, ENTRY])).action, null, "second touch is ignored");
});

test("closing through the gap or hitting the sweep low cancels the setup", () => {
  assert.equal(evaluateICT(bull([[101.8, 101.9, 98.5, 98.7]])).action, null);
});

test("liquidity target uses the nearest swing high above entry", () => {
  const tail = [[102.2, 103, 101.9, 102.8], [102.8, 102.9, 102.1, 102.3], [102.3, 102.5, 101.9, 102.1], ENTRY];
  const r = evaluateICT(bull(tail), { ...ICT_DEFAULTS, target: "liquidity" });
  assert.equal(r.action, "BUY");
  assert.ok(Math.abs(r.tpDist - (103 - 101.0)) < 1e-9, `tpDist ${r.tpDist}`);
});

test("kill zone filter blocks signals outside London and New York hours", () => {
  const bars = bull();                                  // last bar is around 02:00 UTC
  assert.equal(evaluateICT(bars, { ...ICT_DEFAULTS, killZone: true }).info.note, "outside kill zone");
  const shift = 8 * 3600;                               // move it to about 10:00 UTC: still outside
  assert.equal(evaluateICT(bars.map((b) => ({ ...b, epoch: b.epoch + shift })), { ...ICT_DEFAULTS, killZone: true }).action, null);
  const shift2 = 6 * 3600;                              // about 08:00 UTC: London
  assert.equal(evaluateICT(bars.map((b) => ({ ...b, epoch: b.epoch + shift2 })), { ...ICT_DEFAULTS, killZone: true }).action, "BUY");
});

test("short history returns no action with a note", () => {
  const r = evaluateICT(bull().slice(-50));
  assert.equal(r.action, null);
  assert.equal(r.info.note, "loading history");
  assert.equal(evaluateICT([]).action, null);
});
