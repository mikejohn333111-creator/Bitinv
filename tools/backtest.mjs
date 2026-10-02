// Backtests the web bot's strategies with Multiplier economics.
//
//   node tools/backtest.mjs                       # simulated Volatility 75, 60 days
//   node tools/backtest.mjs --days 120 --seed 3
//   node tools/backtest.mjs --csv R_75_M1.csv     # real history (Settings > Download CSV)
//
// Results are in R (1R = the amount risked per trade). A Multiplier trade sized
// by the bot loses 1R at its stop loss, and the commission Deriv charges when it
// opens is shown here as a share of R. The page shows the real commission for
// each trade, so you can read off which row applies to you.
import { readFileSync } from "node:fs";
import { evaluateRules, evaluateAI, RULES_DEFAULTS, AI_DEFAULTS, rulesMinBars, AI_MIN_BARS } from "../public/js/strategy.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) =>
  (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : a), []));
const COSTS = [0, 0.02, 0.05, 0.1];        // commission as a fraction of R

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function simulate(days, seed) {
  const r = rng(seed), g = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const sigmaTick = 0.75 / Math.sqrt(365 * 1440 * 30);         // Volatility 75: 75%/yr, a tick every 2 s
  let p = 400000; const bars = [];
  for (let i = 0; i < days * 1440; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 30; k++) { p *= Math.exp(sigmaTick * g()); h = Math.max(h, p); l = Math.min(l, p); }
    bars.push({ epoch: 1767225600 + i * 60, open: o, high: h, low: l, close: p });
  }
  return bars;
}
function loadCsv(path) {
  return readFileSync(path, "utf8").trim().split("\n").slice(1).map((line) => {
    const [t, o, h, l, c] = line.split(",");
    return { epoch: Date.parse(t.replace(" ", "T") + "Z") / 1000, open: +o, high: +h, low: +l, close: +c };
  });
}

function run(bars, name, evaluate, minBars, window) {
  const trades = [];
  for (let i = minBars; i < bars.length - 1; i++) {
    const sig = evaluate(bars.slice(Math.max(0, i - window), i + 1));
    if (!sig.action) continue;
    const entry = bars[i].close, up = sig.action === "BUY";
    const sl = up ? entry - sig.slDist : entry + sig.slDist, tp = up ? entry + sig.tpDist : entry - sig.tpDist;
    const maxHold = sig.horizonBars || 100000;
    let r = null, j = i + 1;
    for (; j < bars.length && j - i <= maxHold; j++) {
      const b = bars[j];
      const hitSL = up ? b.low <= sl : b.high >= sl, hitTP = up ? b.high >= tp : b.low <= tp;
      if (hitSL) { r = -1; break; }                       // both in one bar counts as a loss
      if (hitTP) { r = sig.tpDist / sig.slDist; break; }
    }
    if (r === null) { j = Math.min(j, bars.length - 1); r = ((bars[j].close - entry) * (up ? 1 : -1)) / sig.slDist; }
    trades.push(r);
    i = j;                                                 // one trade at a time
  }
  const n = trades.length, wins = trades.filter((r) => r > 0).length;
  const gross = n ? trades.reduce((a, b) => a + b, 0) / n : 0;
  const se = n > 1 ? Math.sqrt(trades.reduce((a, b) => a + (b - gross) ** 2, 0) / (n - 1) / n) : 0;
  console.log(`\n${name}: ${n} trades, win rate ${n ? ((100 * wins) / n).toFixed(1) : "-"}%, ` +
              `average ${gross >= 0 ? "+" : ""}${gross.toFixed(3)}R per trade before costs (±${(1.96 * se).toFixed(3)} at 95%)`);
  for (const c of COSTS) console.log(`  commission ${String(c * 100).padStart(3)}% of R  ->  ${(gross - c) >= 0 ? "+" : ""}${(gross - c).toFixed(3)}R per trade, total ${(n * (gross - c)).toFixed(1)}R`);
  return { n, wins, gross };
}

const bars = args.csv ? loadCsv(args.csv) : simulate(Number(args.days || 60), Number(args.seed || 1));
console.log(`${bars.length.toLocaleString()} one-minute bars (${args.csv ? args.csv : "simulated Volatility 75"})`);
run(bars, "Rules strategy", (b) => evaluateRules(b, RULES_DEFAULTS), rulesMinBars(), rulesMinBars() + 50);
const model = JSON.parse(readFileSync(new URL("../public/model/tbotai-model.json", import.meta.url)));
const aiP = { ...AI_DEFAULTS, threshold: Number(args.threshold || 0.55) };
run(bars, `AI model (threshold ${aiP.threshold})`, (b) => evaluateAI(b, model, aiP), AI_MIN_BARS, AI_MIN_BARS + 5);
