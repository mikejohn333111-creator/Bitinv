// The trade plan helpers (public/js/plan.js): Deriv's limit orders as prices, from price or money.
import { test } from "node:test";
import assert from "node:assert/strict";
import { limitLevel, planFromContract, drawable } from "../public/js/plan.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("a limit order's price is used when Deriv sends one", () => {
  const l = limitLevel({ order_amount: -12.4, value: "39012.50" }, { side: "BUY", kind: "sl", entry: 39100, stake: 10, multiplier: 100 });
  assert.deepEqual(l, { price: 39012.5, money: 12.4 });
});

test("money only: distance = amount / (stake x multiplier) x entry, on the right side", () => {
  const ctx = { entry: 40000, stake: 10, multiplier: 100 };
  near(limitLevel({ order_amount: 5 }, { ...ctx, side: "BUY", kind: "tp" }).price, 40200);
  near(limitLevel({ order_amount: -5 }, { ...ctx, side: "BUY", kind: "sl" }).price, 39800);
  near(limitLevel({ order_amount: 5 }, { ...ctx, side: "SELL", kind: "tp" }).price, 39800);
  near(limitLevel({ order_amount: -5 }, { ...ctx, side: "SELL", kind: "sl" }).price, 40200);
  assert.equal(limitLevel({ order_amount: 5 }, { ...ctx, stake: 0, side: "BUY", kind: "tp" }), null, "not enough to work it out");
  assert.equal(limitLevel(undefined, { ...ctx, side: "BUY", kind: "tp" }), null);
});

test("planFromContract merges Deriv's numbers into what the bot knew, also for a trade found after a reload", () => {
  const poc = { contract_type: "MULTDOWN", entry_spot: 40000, entry_tick_time: 1700000030, buy_price: 10, multiplier: 100,
                limit_order: { stop_loss: { order_amount: -5 }, take_profit: { order_amount: 10, value: "39600" } } };
  const p = planFromContract(poc, {});
  assert.equal(p.side, "SELL");
  assert.equal(p.start, 1699999980, "the entry candle (minute start)");
  near(p.sl, 40200); assert.equal(p.slMoney, 5);
  assert.equal(p.tp, 39600); assert.equal(p.tpMoney, 10);
  assert.ok(drawable(p));
  const known = planFromContract({ contract_type: "MULTUP" }, { side: "BUY", entry: 1, sl: 0.9, tp: 1.2, start: 60, end: 600 });
  assert.deepEqual([known.sl, known.tp, known.start, known.end], [0.9, 1.2, 60, 600], "kept when Deriv sends nothing new");
  assert.equal(drawable({ side: "BUY", entry: 1, sl: 1.1, tp: 1.2 }), false, "a stop loss above a buy is not drawn");
});
