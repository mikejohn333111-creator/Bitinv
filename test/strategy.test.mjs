// Checks the browser strategy code against Python/ONNX and sanity-checks indicators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiFeatures, mlpPredict, evaluateAI, evaluateRules, rulesMinBars, aggregate,
         emaSeries, rsiSeries, adxSeries, RULES_DEFAULTS, AI_FAST, AI_DEFAULTS, aiParams, fastModeOn } from "../public/js/strategy.js";

const fx = JSON.parse(readFileSync(new URL("./fixture-ai.json", import.meta.url)));
const model = JSON.parse(readFileSync(new URL("../public/model/tbotai-model.json", import.meta.url)));

test("AI features match features.py and probabilities match onnxruntime", () => {
  fx.idx.forEach((t, k) => {
    const f = aiFeatures(fx.bars.slice(0, t + 1));
    assert.ok(f, `features at ${t}`);
    f.x.forEach((v, j) => assert.ok(Math.abs(v - fx.features[k][j]) < 1e-4, `feature ${j} at ${t}: ${v} vs ${fx.features[k][j]}`));
    const p = mlpPredict(model, f.x);
    p.forEach((v, j) => assert.ok(Math.abs(v - fx.probs[k][j]) < 1e-4, `prob ${j} at ${t}`));
  });
});

test("AI needs enough history and returns SL = TP = barrier x ATR", () => {
  assert.equal(evaluateAI(fx.bars.slice(0, 200), model).action, null);
  const r = evaluateAI(fx.bars, model, { threshold: 0.0, margin: -1, barrierATR: 3, horizonBars: 60 });
  assert.ok(r.action === "BUY" || r.action === "SELL");
  assert.ok(Math.abs(r.slDist - 3 * r.atr) < 1e-12 && r.slDist === r.tpDist);
});

test("indicators behave", () => {
  const up = Array.from({ length: 100 }, (_, i) => 100 + i);
  assert.equal(emaSeries(up, 10)[9], 104.5);
  assert.equal(rsiSeries(up, 14)[99], 100);
  const bars = up.map((c, i) => ({ epoch: i * 60, open: c - 0.5, high: c + 0.5, low: c - 1, close: c }));
  const { adx, pdi, mdi } = adxSeries(bars, 14);
  assert.ok(adx[99] > 50 && pdi[99] > mdi[99], "strong uptrend gives high ADX with +DI > -DI");
});

test("aggregate drops the unfinished higher-timeframe bar", () => {
  const bars = Array.from({ length: 31 }, (_, i) => ({ epoch: 900 + i * 60, open: i, high: i + 1, low: i - 1, close: i }));
  const h = aggregate(bars, 15);
  assert.equal(h.length, 2);
  assert.deepEqual([h[0].open, h[0].close, h[0].high, h[0].low], [0, 14, 15, -1]);
});

test("rules strategy runs on real data and produces sane stops", () => {
  const bars = fx.bars;
  assert.ok(bars.length >= rulesMinBars());
  let signals = 0;
  for (let t = rulesMinBars(); t < bars.length; t += 1) {
    const r = evaluateRules(bars.slice(Math.max(0, t - 1000), t + 1), RULES_DEFAULTS);
    assert.ok(["TREND", "RANGE", "UNCLEAR"].includes(r.info.regime) || r.info.note);
    if (r.action) {
      signals++;
      assert.ok(r.slDist > 0 && r.tpDist > r.slDist * 0.9);
    }
  }
  assert.ok(signals > 0, "at least one signal on 2,000 real bars");
});

test("AI_FAST is a frozen preset with the fast values, used only for the AI strategy", () => {
  assert.deepEqual({ ...AI_FAST }, { threshold: 0.45, margin: 0.05, barrierATR: 1, horizonBars: 10, maxOpen: 3 });
  assert.ok(Object.isFrozen(AI_FAST));
  const own = { strategy: "ai", aiFast: false, aiThreshold: 0.6, aiBarrier: 2, aiHorizon: 30 };
  assert.deepEqual(aiParams(own), { threshold: 0.6, margin: AI_DEFAULTS.margin, barrierATR: 2, horizonBars: 30 });
  assert.deepEqual(aiParams({ ...own, aiFast: true }), { threshold: 0.45, margin: 0.05, barrierATR: 1, horizonBars: 10 });
  assert.equal(fastModeOn({ ...own, aiFast: true }), true);
  assert.equal(fastModeOn({ ...own, aiFast: true, strategy: "rules" }), false);
  assert.equal(fastModeOn({ ...own, aiFast: "true" }), false, "only a real true turns it on");
  const r = evaluateAI(fx.bars.slice(0, 464), model, aiParams({ ...own, aiFast: true }));
  assert.equal(r.action, "SELL");
  assert.equal(r.horizonBars, 10);
  assert.ok(Math.abs(r.slDist - r.atr) < 1e-12 && r.tpDist === r.slDist);
});
