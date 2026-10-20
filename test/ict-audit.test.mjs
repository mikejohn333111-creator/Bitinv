// ICT options added in the October 2026 audit: session liquidity (previous day, Asian range),
// breaker block and OTE entries, MSS by close, and a later fair value gap when the first is missed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateICT, ictMinBars, ictParamsFor, ICT_DEFAULTS } from "../public/js/strategy.js";

const T0 = 1767225600;   // 2026-01-01 00:00 UTC, a Thursday
const mk = (rows, sec = 60, t0 = T0) => rows.map(([o, h, l, c], k) => ({ epoch: t0 + k * sec, open: o, high: h, low: l, close: c }));
const flat = (n) => Array.from({ length: n }, () => [100, 100.5, 99.5, 100]);
const mirror = (bars) => bars.map((b) => ({ epoch: b.epoch, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
const SETUP = [
  [100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8],   // swing low 97
  [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2],       // swing high 101, an up-close candle: the breaker (99.5 to 101)
  [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2],
  [98.2, 98.4, 96.5, 97.5],       // sweep of 97
  [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6],     // displacement above 101
  [101.6, 102.5, 101.2, 102.2],   // fair value gap 99 to 101.2
  [102.2, 102.4, 101.6, 101.8],
];
const ENTRY = [101.8, 101.9, 100.8, 101.0];
const lead = () => flat(ictMinBars());

test("the new options are off by default and change nothing until switched on", () => {
  for (const k of ["liqPrevDay", "liqAsia", "mssClose"]) assert.equal(ICT_DEFAULTS[k], false, k);
  assert.equal(ICT_DEFAULTS.fvgAfterBars, 0);
  assert.equal(ICT_DEFAULTS.entryZone, "fvg");
  assert.deepEqual(ICT_DEFAULTS.asiaHours, [0, 5]);
  for (const g of [60, 900, 3600]) for (const real of [false, true]) {
    const p = ictParamsFor(g, { real });
    if (real && g === 3600) continue;
    assert.equal(p.liqPrevDay || p.liqAsia || p.mssClose || p.fvgAfterBars > 0 || p.entryZone !== "fvg", false);
  }
  // real markets on 1 hour: MSS by close and a later gap (not worse out of sample, 2022-2025)
  const h1 = ictParamsFor(3600, { real: true });
  assert.equal(h1.mssClose, true); assert.equal(h1.fvgAfterBars, 10);
  assert.equal(h1.liqPrevDay || h1.liqAsia, false); assert.equal(h1.entryZone, "fvg"); assert.equal(h1.dispATR, 1);
  assert.equal(ictMinBars(h1), 4 * (50 + 3 + 2), "no extra history needed");
  assert.equal(ictMinBars(), 109, "the default history need is unchanged");
  // session liquidity needs the previous trading day (Friday for a Monday): 4 days of bars
  assert.equal(ictMinBars({ ...ICT_DEFAULTS, liqPrevDay: true, barMinutes: 15 }), 4 * 96 + 10 + 15 + 5);
  assert.equal(ictMinBars({ ...ICT_DEFAULTS, liqAsia: true, barMinutes: 15 }), 96 + 10 + 15 + 5);
  assert.equal(ictMinBars({ ...ICT_DEFAULTS, liqPrevDay: true, barMinutes: 1 }), 4000, "capped below Deriv's 5000 candles");
});

// 15-minute bars. Only a session level is swept: the nearest swing low (98.8) is wicked
// through but the sweep bar closes below it, so the swing-only strategy sees no sweep.
const SESSION_SETUP = [
  [100, 100.5, 99, 99.2], [99.2, 100, 98.8, 99.8],       // swing low 98.8
  [99.8, 101, 99.5, 100.2],                              // swing high 101
  [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2],
  [98.2, 98.4, 96.5, 97.5],                              // sweep of the 96.8 session low, close back above
  [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6],                            // displacement above 101
  [101.6, 102.5, 101.2, 102.2], [102.2, 102.4, 101.6, 101.8], ENTRY,
];
const M15 = { ...ICT_DEFAULTS, barMinutes: 15 };

test("previous day's low: swept, structure shift, gap revisit -> BUY; off -> nothing", () => {
  // Thu 1 Jan to Wed 7 Jan flat with one dip to 96.8 on Wed 03:00; the setup on Thursday from 08:00.
  const rows = flat(7 * 96 + 32);
  rows[6 * 96 + 12] = [100, 100.5, 96.8, 100];
  const bars = mk([...rows, ...SESSION_SETUP], 900);
  assert.equal(new Date(bars.at(-1).epoch * 1000).getUTCDay(), 4, "setup on a Thursday");
  const p = { ...M15, liqPrevDay: true };
  assert.equal(evaluateICT(bars, M15).action, null, "swing liquidity alone: no setup");
  const r = evaluateICT(bars, p);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  assert.match(r.reason, /^Swept the previous day's low at 96\.800, broke structure up above 101\.000/);
  assert.ok(r.slDist > 101 - 96.5 && r.slDist < 101 - 96.5 + 0.2 * r.atr);
  const s = evaluateICT(mirror(bars), p);
  assert.equal(s.action, "SELL");
  assert.match(s.reason, /^Swept the previous day's high at 103\.200/);
  // a dip on the same day is not the previous day's low
  const same = flat(7 * 96 + 32); same[7 * 96 + 4] = [100, 100.5, 96.8, 100];
  assert.equal(evaluateICT(mk([...same, ...SESSION_SETUP], 900), p).action, null);
  // the low was already taken out before the sweep: no longer liquidity
  const taken = [...rows]; taken[7 * 96 + 4] = [100, 100.5, 96.7, 100];
  assert.equal(evaluateICT(mk([...taken, ...SESSION_SETUP], 900), p).action, null);
});

test("Monday's previous day is Friday (weekend bars skipped)", () => {
  // Fri 2 Jan 00:00 ... Mon 5 Jan; the Friday low 96.8, a Sunday-evening bar stays above it.
  const t0 = T0 - 4 * 86400;                          // Sun 28 Dec, so Friday is complete in the window
  const rows = flat(8 * 96 + 32);
  rows[5 * 96 + 40] = [100, 100.5, 96.8, 100];        // Friday 2 Jan 10:00
  const bars = mk([...rows, ...SESSION_SETUP], 900, t0);
  assert.equal(new Date(bars.at(-1).epoch * 1000).getUTCDay(), 1, "setup on a Monday");
  assert.equal(evaluateICT(bars, { ...M15, liqPrevDay: true }).action, "BUY");
});

test("Asian session low (relative equal lows 00:00-05:00 UTC) swept after the session -> BUY", () => {
  const rows = flat(96 + 32);                          // Thu flat, Fri 00:00 to 08:00 (sweep at 09:15)
  rows[96 + 8] = [100, 100.5, 96.8, 100]; rows[96 + 9] = [100, 100.5, 96.8, 100];   // Fri 02:00-02:30, equal lows: no fractal
  const bars = mk([...rows, ...SESSION_SETUP], 900);
  const p = { ...M15, liqAsia: true };
  assert.equal(evaluateICT(bars, M15).action, null);
  const r = evaluateICT(bars, p);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  assert.match(r.reason, /^Swept the Asian session low at 96\.800/);
  assert.match(evaluateICT(mirror(bars), p).reason, /^Swept the Asian session high at 103\.200/);
  // the sweep is at 09:15: a session running to 10:00 has not ended, so its low is not liquidity yet
  assert.equal(evaluateICT(bars, { ...p, asiaHours: [0, 9] }).action, "BUY");
  assert.equal(evaluateICT(bars, { ...p, asiaHours: [0, 10] }).action, null);
  // same lows at 06:00 are outside the session
  const late = flat(96 + 32); late[96 + 24] = [100, 100.5, 96.8, 100]; late[96 + 25] = [100, 100.5, 96.8, 100];
  assert.equal(evaluateICT(mk([...late, ...SESSION_SETUP], 900), p).action, null);
});

test("breaker block: the last up-close candle before the sweep, entered on the way back", () => {
  const p = { ...ICT_DEFAULTS, entryZone: "breaker" };
  const w = evaluateICT(mk([...lead(), ...SETUP]), p);
  assert.equal(w.pending?.side, "BUY");
  assert.deepEqual(w.pending.zone, [99.5, 101]);
  assert.match(w.pending.reason, /bullish breaker block \(99\.500 to 101\.000\)/);
  const r = evaluateICT(mk([...lead(), ...SETUP, ENTRY]), p);
  assert.equal(r.action, "BUY");
  assert.match(r.reason, /entering the bullish breaker block/);
  assert.ok(r.slDist > 101 - 96.5 && r.slDist < 101 - 96.5 + 0.2 * r.atr, "stop beyond the sweep's low");
  const s = evaluateICT(mirror(mk([...lead(), ...SETUP, ENTRY])), p);
  assert.equal(s.action, "SELL");
  assert.match(s.reason, /bearish breaker block/);
  // closing back below the breaker: no trade
  assert.equal(evaluateICT(mk([...lead(), ...SETUP, [101.8, 101.9, 99.0, 99.3]]), p).action, null);
});

test("OTE entry: 62% to 79% back from the high toward the swept low", () => {
  const p = { ...ICT_DEFAULTS, entryZone: "ote" };
  // range 96.5 to 102.5: 62% back = 98.78, 79% back = 97.76
  const w = evaluateICT(mk([...lead(), ...SETUP, ENTRY]), p);
  assert.equal(w.action, null, "101.0 is only 25% back");
  assert.ok(Math.abs(w.pending.zone[0] - 97.76) < 1e-9 && Math.abs(w.pending.zone[1] - 98.78) < 1e-9, JSON.stringify(w.pending.zone));
  assert.match(w.pending.reason, /optimal trade entry zone/);
  const r = evaluateICT(mk([...lead(), ...SETUP, ENTRY, [101.0, 101.1, 98.5, 98.9]]), p);
  assert.equal(r.action, "BUY");
  assert.ok(r.slDist > 98.9 - 96.5 && r.slDist < 98.9 - 96.5 + 0.2 * r.atr);
  assert.equal(evaluateICT(mirror(mk([...lead(), ...SETUP, ENTRY, [101.0, 101.1, 98.5, 98.9]])), p).action, "SELL");
  // closing deeper than 79%: no trade; a second dip into the zone: no trade
  assert.equal(evaluateICT(mk([...lead(), ...SETUP, ENTRY, [101.0, 101.1, 97.2, 97.5]]), p).action, null);
  assert.equal(evaluateICT(mk([...lead(), ...SETUP, ENTRY, [101.0, 101.1, 98.5, 99.5], [99.5, 99.6, 98.4, 98.9]]), p).action, null);
});

test("MSS by close: a small breaking candle counts when the leg has displacement", () => {
  const rows = [...lead(), ...SETUP, ENTRY];
  rows[ictMinBars() + 10] = [100.9, 101.8, 98.7, 101.6];    // breaks 101 with a body of 0.7 only
  const bars = mk(rows);
  assert.equal(evaluateICT(bars).action, null);
  assert.equal(evaluateICT(bars, { ...ICT_DEFAULTS, dispATR: 0.7 }).action, null, "0.7 x ATR is still more than 0.7");
  assert.equal(evaluateICT(bars, { ...ICT_DEFAULTS, mssClose: true }).action, null, "the leg's biggest body (1.3) is under 1 ATR");
  const r = evaluateICT(bars, { ...ICT_DEFAULTS, mssClose: true, dispATR: 0.7 });
  assert.equal(r.action, "BUY");
  assert.equal(evaluateICT(mirror(bars), { ...ICT_DEFAULTS, mssClose: true, dispATR: 0.7 }).action, "SELL");
  // no displacement anywhere in the leg: still nothing
  const weak = [...rows]; weak[ictMinBars() + 9] = [98.2, 99, 97.3, 98.4];
  assert.equal(evaluateICT(mk(weak), { ...ICT_DEFAULTS, mssClose: true, dispATR: 0.7 }).action, null);
});

test("a later gap is used when the first was missed, never after the first was revisited", () => {
  // price runs on without touching the first gap (99 to 101.2), leaves a second gap 103.0 to 103.8
  const RUN = [[101.8, 103.0, 101.7, 102.9], [102.9, 104.5, 102.8, 104.3], [104.3, 105, 103.8, 104.8]];
  const BACK = [104.8, 104.9, 103.5, 103.9];
  const p = { ...ICT_DEFAULTS, fvgAfterBars: 10 };
  const bars = mk([...lead(), ...SETUP, ...RUN, BACK]);
  assert.equal(evaluateICT(bars).action, null, "default: only the first gap");
  const r = evaluateICT(bars, p);
  assert.equal(r.action, "BUY", JSON.stringify(r.info));
  assert.equal(r.info.gapLow, 103.0); assert.equal(r.info.gapHigh, 103.8);
  const first = evaluateICT(mk([...lead(), ...SETUP, ENTRY]));
  assert.notEqual(r.setupId, first.setupId, "a new plan, not the used one");
  assert.ok(r.setupId.startsWith(first.setupId + ":"));
  assert.equal(evaluateICT(mirror(bars), p).action, "SELL");
  // waiting: the plan moves to the newer gap
  assert.deepEqual(evaluateICT(mk([...lead(), ...SETUP, ...RUN]), p).pending.zone, [103.0, 103.8]);
  // the first gap was revisited (and traded) before the run: no second entry
  const used = mk([...lead(), ...SETUP, ENTRY, ...RUN, BACK]);
  assert.equal(evaluateICT(used, p).action, null);
  // with the option on, the first gap still works as before
  assert.equal(evaluateICT(mk([...lead(), ...SETUP, ENTRY]), p).action, "BUY");
});
