// Backtests the web bot's strategies with Multiplier economics.
//
//   node tools/backtest.mjs                       # simulated Volatility 75, 60 days, all strategies
//   node tools/backtest.mjs --days 120 --seed 3
//   node tools/backtest.mjs --seeds 1,2,3         # several simulated runs, trades pooled
//   node tools/backtest.mjs --strategy ict        # only one strategy: rules, ai or ict
//   node tools/backtest.mjs --strategy ict --sweep  # ICT parameter grid (R multiple x horizon x kill zone)
//   node tools/backtest.mjs --csv R_75_M1.csv     # real history (Settings > Download CSV)
//   node tools/backtest.mjs --csv DAT_ASCII_EURUSD_M1_2024.csv,DAT_ASCII_EURUSD_M1_2025.csv --spread 0.00008
//   node tools/backtest.mjs --tf 15 ...            # resample M1 to 15-minute (or 60) bars first
//   node tools/backtest.mjs --train 2022.csv,2023.csv --test 2024.csv,2025.csv --tf 60 --spreads 0.00008,0.00015
//                                                  # walk-forward: pick settings on --train, report --test only
//
// --csv takes the bot's own CSV (time,open,high,low,close in UTC) or HistData
// ASCII files (YYYYMMDD HHMMSS;o;h;l;c;v), whose times are EST without daylight
// saving and are shifted +5 h to UTC so the kill-zone filter sees UTC hours.
//
// Results are in R (1R = the amount risked per trade). A Multiplier trade sized
// by the bot loses 1R at its stop loss, and the commission Deriv charges when it
// opens is shown here as a share of R. The page shows the real commission for
// each trade, so you can read off which row applies to you. --spread (in price
// units, round trip) is charged on every trade as spread / stop distance.
import { readFileSync } from "node:fs";
import { evaluateRules, evaluateAI, evaluateICT, RULES_DEFAULTS, AI_DEFAULTS, ICT_DEFAULTS,
         rulesMinBars, AI_MIN_BARS, ictMinBars } from "../public/js/strategy.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) =>
  (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : a), []));
const COSTS = [0, 0.02, 0.05, 0.1];        // commission as a fraction of R
const SPREAD = Number(args.spread || 0);

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
  const lines = readFileSync(path, "utf8").trim().split("\n");
  if (/^\d{8} \d{6};/.test(lines[0])) {                        // HistData: EST (UTC-5, no DST)
    return lines.map((line) => {
      const [t, o, h, l, c] = line.split(";");
      const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:00Z`;
      return { epoch: Date.parse(iso) / 1000 + 5 * 3600, open: +o, high: +h, low: +l, close: +c };
    });
  }
  return lines.slice(1).map((line) => {
    const [t, o, h, l, c] = line.split(",");
    return { epoch: Date.parse(t.replace(" ", "T") + "Z") / 1000, open: +o, high: +h, low: +l, close: +c };
  });
}

/** Walks the bars one trade at a time; returns each trade's result in R (before costs) and its stop distance. */
function trade(bars, evaluate, minBars, window) {
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
    trades.push({ r, sl: sig.slDist });
    i = j;                                                 // one trade at a time
  }
  return trades;
}

/** Summary in R after charging `spread` (price units, round trip) as spread / stop distance on each trade. */
function stats(raw, days, spread = SPREAD) {
  const trades = raw.map((t) => t.r - spread / t.sl);
  const n = trades.length, wins = trades.filter((r) => r > 0).length;
  const avg = n ? trades.reduce((a, b) => a + b, 0) / n : 0;
  const se = n > 1 ? Math.sqrt(trades.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1) / n) : 0;
  return { n, perDay: n / days, win: n ? wins / n : NaN, avg, ci: 1.96 * se, total: n * avg };
}
const sgn = (v, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

function report(name, s) {
  console.log(`\n${name}: ${s.n} trades (${s.perDay.toFixed(1)} a day), win rate ${s.n ? (100 * s.win).toFixed(1) : "-"}%, ` +
              `average ${sgn(s.avg)}R per trade before commission (±${s.ci.toFixed(3)} at 95%)`);
  for (const c of COSTS) console.log(`  commission ${String(c * 100).padStart(3)}% of R  ->  ${sgn(s.avg - c)}R per trade, total ${(s.n * (s.avg - c)).toFixed(1)}R`);
}

/** Resamples M1 bars to `tf` minutes. Each bar is stamped with the start of its LAST
 *  minute, so aggregate() inside the rules strategy sees a finished group as finished
 *  (it assumes M1 stamps) and the kill-zone hour is the hour the bar closes in. */
function resample(bars, tf) {
  if (tf <= 1) return bars;
  const sec = tf * 60, out = [];
  for (const b of bars) {
    const start = Math.floor(b.epoch / sec) * sec, last = out[out.length - 1];
    if (last && last.start === start) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close;
    } else out.push({ start, epoch: start + sec - 60, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out.map(({ start, ...b }) => b);
}
const loadFiles = (list) => String(list).split(",").flatMap(loadCsv).sort((a, b) => a.epoch - b.epoch);
const spanDays = (bars) => (bars.at(-1).epoch - bars[0].epoch + 60) / 86400;
const TF = Number(args.tf || 1);

// ------------------------------------------------------------- strategies
// Each strategy has a default and a small grid of candidate settings. The rules
// strategy's higher timeframe follows TbotAdaptive: M1 -> M15, M15 -> H1, H1 -> H4.
function strategies(tf) {
  const htf = tf <= 1 ? 15 : tf * 4;
  const rules = { ...RULES_DEFAULTS, htfMinutes: htf, barMinutes: tf };
  const rMin = rulesMinBars(rules);
  const ictGrid = [];
  for (const killZone of [false, true]) for (const rMultiple of [1.5, 2, 3]) for (const horizonBars of [15, 30, 60])
    ictGrid.push({ label: `${rMultiple}R, ${horizonBars} bars, kill zone ${killZone ? "on" : "off"}`, p: { ...ICT_DEFAULTS, rMultiple, horizonBars, killZone } });
  ictGrid.push({ label: "liquidity target, 30 bars, kill zone off", p: { ...ICT_DEFAULTS, target: "liquidity" } });
  let model = null;
  const ai = () => model ??= JSON.parse(readFileSync(new URL("../public/model/tbotai-model.json", import.meta.url)));
  return {
    rules: {
      name: "Rules", minBars: rMin, window: rMin + 50,
      grid: [{ label: "trend and range", p: rules }, { label: "trend only", p: { ...rules, useRange: false } },
             { label: "range only", p: { ...rules, useTrend: false } }],
      evaluate: (p) => (b) => evaluateRules(b, p),
    },
    ai: {
      name: "AI", minBars: AI_MIN_BARS, window: AI_MIN_BARS + 5,
      grid: [0.5, 0.55, 0.6].map((t) => ({ label: `threshold ${t}`, p: { ...AI_DEFAULTS, threshold: t } })),
      evaluate: (p) => (b) => evaluateAI(b, ai(), p),
    },
    ict: {
      name: "ICT", minBars: ictMinBars(), window: ictMinBars(),
      grid: ictGrid, defaultIndex: 4,       // 2R, 30 bars, kill zone off = ICT_DEFAULTS
      evaluate: (p) => (b) => evaluateICT(b, p),
    },
  };
}
const want = (s) => !args.strategy || String(args.strategy).split(",").includes(s);
const fmtRow = (s) => `${String(s.n).padStart(6)} ${s.perDay.toFixed(2).padStart(6)}/day  win ${(100 * s.win).toFixed(1).padStart(5)}%  ` +
  `${sgn(s.avg)}R ±${s.ci.toFixed(3)}  total ${sgn(s.total, 1)}R`;

if (args.train) {
  // ---------------------------------------------------------- walk-forward
  //   node tools/backtest.mjs --train 2022.csv,2023.csv --test 2024.csv,2025.csv --tf 15 --spreads 0.00008,0.00015
  // Every candidate setting is run on the training years; the one with the best
  // average R after the FIRST spread is then run once on the test years. Only the
  // test numbers are an honest estimate; the training table shows how much picking helps.
  const spreads = String(args.spreads || "0.00008,0.00015").split(",").map(Number);
  const train = resample(loadFiles(args.train), TF), test = resample(loadFiles(args.test), TF);
  const dTrain = spanDays(train), dTest = spanDays(test);
  console.log(`walk-forward on ${TF}-minute bars: train ${train.length.toLocaleString()} bars (${dTrain.toFixed(0)} days), ` +
              `test ${test.length.toLocaleString()} bars (${dTest.toFixed(0)} days); costs: spread ${spreads.join(" and ")} per round trip`);
  const S = strategies(TF);
  for (const key of ["rules", "ai", "ict"]) {
    if (!want(key)) continue;
    const st = S[key];
    console.log(`\n== ${st.name}, ${TF}-minute bars. Training years, every candidate (avg R after ${spreads[0]} spread):`);
    let best = null;
    for (const c of st.grid) {
      const raw = trade(train, st.evaluate(c.p), st.minBars, st.window);
      const s = stats(raw, dTrain, spreads[0]);
      console.log(`  ${c.label.padEnd(40)} ${fmtRow(s)}`);
      if (s.n >= 30 && (!best || s.avg > best.s.avg)) best = { c, s };
    }
    if (!best) { console.log("  no candidate made 30 trades in training; nothing to test"); continue; }
    const raw = trade(test, st.evaluate(best.c.p), st.minBars, st.window);
    console.log(`  picked: ${best.c.label}`);
    console.log(`  TEST (out of sample):`);
    console.log(`    before costs          ${fmtRow(stats(raw, dTest, 0))}`);
    for (const sp of spreads) console.log(`    after ${String(sp).padEnd(15)} ${fmtRow(stats(raw, dTest, sp))}`);
    if (args.json) console.log("JSON " + JSON.stringify({ strategy: key, tf: TF, picked: best.c.label,
      test: [0, ...spreads].map((sp) => ({ spread: sp, ...stats(raw, dTest, sp) })) }));
  }
} else {
  // ------------------------------------------------------- single data set
  const datasets = [];
  if (args.csv) {
    datasets.push({ label: String(args.csv).split(",").join(" + "), bars: resample(loadFiles(args.csv), TF) });
  } else {
    const days = Number(args.days || 60);
    const seeds = String(args.seeds || args.seed || 1).split(",").map(Number);
    for (const seed of seeds) datasets.push({ label: `simulated Volatility 75, seed ${seed}`, bars: resample(simulate(days, seed), TF) });
  }
  // calendar days covered, for trades per day (weekends count as days, as on the 24/7 synthetics)
  const totalDays = datasets.reduce((a, d) => a + spanDays(d.bars), 0);
  for (const d of datasets) console.log(`${d.bars.length.toLocaleString()} ${TF}-minute bars (${d.label})`);
  if (SPREAD) console.log(`spread ${SPREAD} per round trip charged on every trade`);
  const pooled = (evaluate, minBars, window) => datasets.flatMap((d) => trade(d.bars, evaluate, minBars, window));
  const S = strategies(TF);

  if (want("rules")) report("Rules strategy", stats(pooled(S.rules.evaluate(S.rules.grid[0].p), S.rules.minBars, S.rules.window), totalDays));
  if (want("ai")) {
    const aiP = { ...AI_DEFAULTS, threshold: Number(args.threshold || 0.55) };
    report(`AI model (threshold ${aiP.threshold})`, stats(pooled(S.ai.evaluate(aiP), S.ai.minBars, S.ai.window), totalDays));
  }
  if (want("ict")) {
    const runIct = (p) => stats(pooled(S.ict.evaluate(p), S.ict.minBars, S.ict.window), totalDays);
    if (!args.sweep) {
      report("ICT (sweep, structure shift, fair value gap)", runIct(ICT_DEFAULTS));
    } else {
      // Every row is shown. Picking the best row afterwards is curve fitting: with
      // 19 tries, one of them looks good by luck alone even on pure noise.
      console.log("\nICT parameter sweep (all rows, same data):");
      for (const c of S.ict.grid) {
        const s = runIct(c.p);
        console.log(`  ${c.label.padEnd(40)} ${fmtRow(s)}  after 2% ${sgn(s.avg - 0.02)}  after 5% ${sgn(s.avg - 0.05)}`);
      }
    }
  }
}
