import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeMultiplier, RiskGuard } from "../public/js/risk.js";

test("stake makes the stop loss equal the risk amount", () => {
  // V75-like: price 400,000, stop 0.2% away, x100 -> each 1 of stake loses 0.2 at the stop
  const r = sizeMultiplier({ balance: 10000, riskPct: 1, entry: 400000, slDist: 800, tpDist: 1600, multiplier: 100 });
  assert.ok(r.ok);
  assert.equal(r.stake, 500);
  assert.equal(r.stopLoss, 100);
  assert.equal(r.takeProfit, 200);
});

test("refuses a multiplier that would stop out before the stop loss", () => {
  const r = sizeMultiplier({ balance: 10000, riskPct: 1, entry: 100, slDist: 1, tpDist: 2, multiplier: 100 });
  assert.equal(r.ok, false);
});

test("respects minimum stake and the stake cap", () => {
  const small = sizeMultiplier({ balance: 20, riskPct: 1, entry: 400000, slDist: 800, tpDist: 800, multiplier: 100, minStake: 1 });
  assert.equal(small.ok, true); assert.equal(small.stake, 1); // risks 0.2, limit 0.2
  const tiny = sizeMultiplier({ balance: 5, riskPct: 1, entry: 400000, slDist: 800, tpDist: 800, multiplier: 100, minStake: 1 });
  assert.equal(tiny.ok, false);
  const capped = sizeMultiplier({ balance: 1000, riskPct: 5, entry: 400000, slDist: 80, tpDist: 80, multiplier: 10 });
  assert.equal(capped.stake, 500); // 50% of balance cap
});

test("guard: daily loss halt, trade count, cooldown, new day reset", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const limits = { maxDailyLossPct: 3, maxOpen: 1, maxTradesPerDay: 2, maxConsecLosses: 2, cooldownMinutes: 10 };
  const t0 = Date.UTC(2026, 9, 2, 10);
  const g = new RiskGuard(storage, "DEMO1", limits);
  g.update(1000, t0);
  assert.equal(g.blockReason(0, t0), "");
  assert.match(g.blockReason(1, t0), /open/);
  g.recordEntry(); g.recordEntry();
  assert.match(g.blockReason(0, t0), /today/);
  g.recordClose(-5, t0); g.recordClose(-5, t0);
  assert.match(g.blockReason(0, t0 + 60000), /cooling/);
  assert.equal(g.update(969, t0).justHalted, true);
  assert.match(g.blockReason(0, t0 + 3600000), /daily loss/);
  const g2 = new RiskGuard(storage, "DEMO1", limits);   // survives a page reload
  assert.match(g2.blockReason(0, t0 + 3600000), /daily loss/);
  g2.update(969, t0 + 86400000);                          // next UTC day
  assert.equal(g2.blockReason(0, t0 + 86400000), "");
});
