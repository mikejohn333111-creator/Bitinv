// The control page's live chart: the website's candlestick chart and trade plan (green target
// box, red stop box, labelled lines, the dashed "Waiting for price" zone), drawn with the same
// code (public/js/plan.js and the vendored Lightweight Charts, served under /lib/).
//
// The page never talks to Deriv: candles come from GET /api/candles (only the new ones after
// the first load), and the plans from the status the page already polls. control.js loads this
// module once the control page shows and calls update(status) after every poll, so the chart
// pauses with the polling while the page is hidden.
import { createChart, CrosshairMode } from "./lib/lightweight-charts.mjs";
import { TradePlanLayer, drawable } from "./lib/plan.js";

const $ = (id) => document.getElementById(id);
const TIMEFRAMES = [[60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"], [14400, "4h"], [86400, "1D"]];
const TF_WORD = { 60: "1-minute", 300: "5-minute", 900: "15-minute", 3600: "1-hour", 14400: "4-hour", 86400: "1-day" };
const TF_KEY = "tbot:server:chartTf", PLAN_KEY = "tbot:server:plan";
const MIN_GAP_MS = 2000;           // render() also runs after button presses: ask for candles at most this often
const SIGNAL_DIM_MS = 5 * 60000;   // a signal goes dim after 5 minutes, or once the bot is stopped (like the website)

// Per-device choices (timeframe, plan on or off). The page works the same without storage.
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
};

// Colours follow the page's light and dark themes (control.css) and the device setting live.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const PALETTE = {
  light: { text: "#5d6878", grid: "#eef1f5", cross: "#9aa5b4", label: "#354151", up: "#0f8a5f", down: "#cc3a4f",
           tpFill: "rgba(15, 138, 95, 0.13)", tpLine: "#0f8a5f", slFill: "rgba(204, 58, 79, 0.12)", slLine: "#cc3a4f", entry: "#354151", dim: "#9aa5b4" },
  dark: { text: "#93a0b0", grid: "#1a222c", cross: "#4a5668", label: "#2a3340", up: "#3ccf95", down: "#ff7d8c",
          tpFill: "rgba(60, 207, 149, 0.16)", tpLine: "#3ccf95", slFill: "rgba(255, 125, 140, 0.15)", slLine: "#ff7d8c", entry: "#c5cdd8", dim: "#4a5668" },
};
const pal = () => PALETTE[darkQuery.matches ? "dark" : "light"];
const chartTheme = (p) => ({
  layout: { background: { color: "transparent" }, textColor: p.text, fontSize: 11, attributionLogo: false,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  grid: { vertLines: { visible: false }, horzLines: { color: p.grid } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: p.cross, labelBackgroundColor: p.label }, horzLine: { color: p.cross, labelBackgroundColor: p.label } },
});
const seriesTheme = (p) => ({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false });
const axisPrice = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function mountChart() {
  const view = {
    tf: TIMEFRAMES.some(([g]) => g === store.get(TF_KEY, 60)) ? store.get(TF_KEY, 60) : 60,
    symbol: null, first: 0, last: 0,    // what the chart shows now
    status: null, loading: false, askedAt: 0, again: false, tradeIds: new Set(), markSig: "",
  };
  const botTf = () => view.status?.botTf || 60;
  const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v))} ${view.status?.currency || ""}`.trim();

  const chart = createChart($("chart"), {
    autoSize: true,
    ...chartTheme(pal()),
    handleScroll: { vertTouchDrag: false },   // a finger on the chart still scrolls the page
    localization: { priceFormatter: axisPrice },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
  });
  const series = chart.addCandlestickSeries(seriesTheme(pal()));
  const planLabel = (p, kind) => kind === "entry" ? "Entry"
    : kind === "sl" ? `SL${Number.isFinite(p.slMoney) ? " " + signed(-p.slMoney) : ""}`
    : `TP${Number.isFinite(p.tpMoney) ? " " + signed(p.tpMoney) : ""}`;
  // While a plan shows, leave room right of the last candle so its boxes can reach the planned close.
  let roomShown = 3;
  const planRoom = (layer) => {
    const room = layer.active() ? (view.tf <= 60 ? 12 : 4) : 3;
    if (room !== roomShown) { roomShown = room; chart.timeScale().applyOptions({ rightOffset: room }); }
    // The plans drawn now, such as "signal pending 12345" (the end-to-end test reads it).
    $("chart").dataset.plans = !layer.visible ? "" : [...layer.plans].filter(([, p]) => !p.closedAt && drawable(p)).map(([id]) => id).join(" ");
  };
  const plans = new TradePlanLayer({ chart, series, palette: pal, label: planLabel, lastTime: () => view.last || null, tf: () => view.tf, onChange: planRoom });
  darkQuery.addEventListener?.("change", () => {
    chart.applyOptions(chartTheme(pal()));
    series.applyOptions(seriesTheme(pal()));
    view.markSig = "";
    paintMarkers();
    plans.restyle();
  });

  // ------------------------------------------------------------- candles
  const toBar = (c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] });
  function empty(text) {
    $("chartEmpty").textContent = text || "";
    $("chartEmpty").hidden = !text;
  }

  /** Asks the server for the candles the chart doesn't have yet (all of them after a change). */
  async function load() {
    if (view.loading) { view.again = true; return; }
    view.loading = true; view.askedAt = Date.now();
    const tf = view.tf, after = view.symbol === view.status?.symbol ? view.last : 0;
    try {
      const res = await fetch(`/api/candles?tf=${tf}${after ? `&after=${after}` : ""}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      if (d.tf !== view.tf) return;                                       // the timeframe changed meanwhile
      if (!d.full && d.symbol !== view.symbol) { view.symbol = null; view.again = true; return; }   // the market changed: load all
      if (d.full) {
        series.setData(d.candles.map(toBar));
        view.symbol = d.symbol; view.first = d.candles[0]?.[0] || 0; view.last = d.candles.at(-1)?.[0] || 0;
        view.markSig = "";
      } else {
        for (const c of d.candles) if (c[0] >= view.last) { series.update(toBar(c)); view.last = c[0]; }
      }
      $("chart").dataset.candles = String(series.data().length);
      empty(view.last ? "" : d.message || "Loading prices.");
      paintMarkers(); plans.redraw();
    } catch { /* offline: control.js shows that; tried again on the next poll */ }
    finally {
      view.loading = false;
      if (view.again) { view.again = false; load(); }
    }
  }

  // ------------------------------------------------------------ markers
  /** An arrow for every recent signal and trade, on the candle of the chart's timeframe that holds it. */
  function paintMarkers() {
    const marks = view.status?.marks || [];
    const sig = JSON.stringify([marks, view.first, view.tf]);
    if (sig === view.markSig) return;
    view.markSig = sig;
    const p = pal();
    try {
      series.setMarkers(marks.map((m) => ({ time: Math.floor(m.t / view.tf) * view.tf, position: m.side === "BUY" ? "belowBar" : "aboveBar",
                                            color: m.side === "BUY" ? p.up : p.down, shape: m.side === "BUY" ? "arrowUp" : "arrowDown", text: m.side }))
        .filter((m) => m.time >= view.first).sort((a, b) => a.time - b.time));
    } catch { /* display only */ }
  }

  // -------------------------------------------------------------- plans
  /** Open trades, the latest signal and the waiting plan from the status, as plans on the chart. */
  function showPlans(s) {
    const ids = new Set();
    for (const t of s.open || []) {
      if (!t.plan || t.symbol !== s.symbol) continue;
      ids.add(t.id);
      plans.set(t.id, { ...t.plan, stale: false });
    }
    for (const id of view.tradeIds) if (!ids.has(id)) plans.close(id);   // closed: fades out
    view.tradeIds = ids;
    // A signal that wasn't traded (signals only): a traded one shows as its trade's plan.
    const sig = s.lastSignal;
    if (sig && !sig.traded && sig.symbol === s.symbol) {
      const stale = !s.running || Date.now() - sig.at >= SIGNAL_DIM_MS;
      plans.set("signal", { side: sig.action, entry: sig.entry, sl: sig.sl, tp: sig.tp, slMoney: sig.slMoney ?? NaN, tpMoney: sig.tpMoney ?? NaN,
                            start: sig.barEpoch, end: sig.end ?? null, stale });
    } else plans.remove("signal");
    const w = s.pending;
    if (w && w.symbol === s.symbol) {
      plans.set("pending", { kind: "pending", side: w.side, zone: w.zone, sl: w.sl, tp: w.tp, slMoney: w.slMoney ?? NaN, tpMoney: w.tpMoney ?? NaN,
                             start: w.start ?? plans.get("pending")?.start ?? view.last, end: w.expiresAt, stale: false });
    } else plans.remove("pending");
  }

  // ---------------------------------------------------------- timeframe
  function renderTimeframe() {
    document.querySelectorAll("[data-tf]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.tf === view.tf)));
    $("tfNote").hidden = view.tf === botTf();
    $("tfNote").textContent = `The bot trades on ${TF_WORD[botTf()]} candles; this only changes the chart.`;
    $("tfName").textContent = TF_WORD[view.tf];
    $("chart").setAttribute("aria-label", `${TIMEFRAMES.find(([g]) => g === view.tf)[1]} candlestick chart`);
  }
  document.querySelectorAll("[data-tf]").forEach((b) => b.addEventListener("click", () => {
    if (+b.dataset.tf === view.tf) return;
    view.tf = +b.dataset.tf; store.set(TF_KEY, view.tf);
    view.symbol = null; view.first = view.last = 0;
    series.setData([]);
    empty("Loading prices.");
    renderTimeframe();
    load();
  }));
  $("planToggle").checked = store.get(PLAN_KEY, true) !== false;
  plans.setVisible($("planToggle").checked);
  $("planToggle").addEventListener("change", (e) => { store.set(PLAN_KEY, e.target.checked); plans.setVisible(e.target.checked); });
  $("chartCard").hidden = false;

  return {
    /** Called with every status the page gets. */
    update(s) {
      view.status = s;
      $("chartMarket").textContent = s.symbolName || s.symbol;
      renderTimeframe();
      showPlans(s);
      paintMarkers();
      if (view.symbol !== s.symbol || Date.now() - view.askedAt >= MIN_GAP_MS) load();
    },
  };
}
