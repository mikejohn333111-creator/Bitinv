// Tbot web bot: wires the Deriv connection, the strategies, risk limits and the page.
import { CONFIG, SYMBOLS } from "./config.js";
import { evaluateRules, evaluateAI, RULES_DEFAULTS, AI_DEFAULTS, rulesMinBars } from "./strategy.js";
import { sizeMultiplier, RiskGuard } from "./risk.js";
import { startOAuth, finishOAuth, getAccounts, createDemoAccount, getTradingSocketUrl, DerivSocket, redirectUri,
         cleanAppId, hasScope, FULL_SCOPE } from "./deriv.js";
import { createChart, CrosshairMode } from "../vendor/lightweight-charts.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const HISTORY_BARS = 1200;
const DEFAULT_MULTIPLIERS = [10, 20, 30, 40, 50, 100, 200, 300, 400];

// ------------------------------------------------------------- settings
const cfg = { ...CONFIG };
if (isLocal) {   // test hooks: only honoured when the page runs on this machine
  const q = new URLSearchParams(location.search);
  const dev = JSON.parse(sessionStorage.getItem("tbot:dev") || "{}");
  for (const [k, p] of [["apiUrl", "api"], ["authUrl", "auth"], ["publicWs", "ws"]]) if (q.get(p)) dev[k] = q.get(p);
  sessionStorage.setItem("tbot:dev", JSON.stringify(dev));
  Object.assign(cfg, dev);
}
const DEFAULT_SETTINGS = {
  appId: "", symbol: "R_75", strategy: "rules", mode: "signals",
  riskPct: 1, maxDailyLossPct: 3, maxOpen: 1, maxTradesPerDay: 20, maxConsecLosses: 3, cooldownMinutes: 15,
  multiplier: 0, signalGap: 8, notify: true, sound: true,
  aiThreshold: 0.55, aiBarrier: AI_DEFAULTS.barrierATR, aiHorizon: AI_DEFAULTS.horizonBars,
  redirectNoSlash: false,
};
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const settings = { ...DEFAULT_SETTINGS, ...store.get("tbot:settings", {}) };
const saveSettings = () => store.set("tbot:settings", settings);
cfg.appId = cleanAppId(settings.appId) || CONFIG.appId;
cfg.redirectNoSlash = !!settings.redirectNoSlash;
const saveAuth = (auth) => { try { sessionStorage.setItem("tbot:auth", JSON.stringify(auth)); } catch { /* blocked */ } };
cfg.onAuthChange = (auth) => { if (auth === st.auth) saveAuth(auth); };   // keeps a refreshed token, unless logged out meanwhile
// Deriv only returns logins to the registered address, so other addresses of this site can't log in.
const onOtherHost = !!CONFIG.siteUrl && location.hostname.endsWith(".vercel.app") && location.origin !== new URL(CONFIG.siteUrl).origin;
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Telegram|Snapchat|; wv\)/i.test(navigator.userAgent);

// ---------------------------------------------------------------- state
const st = {
  auth: null, accounts: [], account: null, socket: null, trading: false,
  bars: [], forming: null, balance: NaN, currency: "USD",
  multipliers: DEFAULT_MULTIPLIERS, minStake: 1, maxStake: Infinity,
  running: false, model: null, guard: null,
  contracts: new Map(),          // contract_id -> {side, entryEpoch, horizon, profit, buyPrice, sub}
  lastSignalEpoch: 0, lastCost: null, wakeLock: null, busy: false,
};

// ---------------------------------------------------------------- chart
// Colours match the page's light and dark themes (css/app.css) and follow the device setting live.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const PALETTE = {
  light: { text: "#5b6778", grid: "#eef1f5", cross: "#9aa5b4", label: "#354151", up: "#0c9466", down: "#d63c3c" },
  dark: { text: "#7f8b9d", grid: "#171d26", cross: "#4a5668", label: "#2a3340", up: "#2ad595", down: "#ff6166" },
};
const pal = () => PALETTE[darkQuery.matches ? "dark" : "light"];
const chartTheme = (p) => ({
  layout: { background: { color: "transparent" }, textColor: p.text, fontSize: 11,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  grid: { vertLines: { visible: false }, horzLines: { color: p.grid } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: p.cross, labelBackgroundColor: p.label }, horzLine: { color: p.cross, labelBackgroundColor: p.label } },
});
const seriesTheme = (p) => ({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false });
// Two decimals with thousands separators on the price axis, like the price above the chart.
const axisPrice = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chart = createChart($("chart"), {
  autoSize: true,
  ...chartTheme(pal()),
  // The TradingView credit is a text link under the chart (index.html), so no logo sits on the candles.
  layout: { ...chartTheme(pal()).layout, attributionLogo: false },
  handleScroll: { vertTouchDrag: false },   // a finger on the chart still scrolls the page
  localization: { priceFormatter: axisPrice },
  rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
});
const series = chart.addCandlestickSeries(seriesTheme(pal()));
let markers = [], priceLines = [];
darkQuery.addEventListener?.("change", () => {
  const p = pal();
  const t = chartTheme(p);
  chart.applyOptions({ ...t, layout: { ...t.layout, attributionLogo: false } });
  series.applyOptions(seriesTheme(p));
  markers = markers.map((m) => ({ ...m, color: m.position === "belowBar" ? p.up : p.down }));
  series.setMarkers(markers);
  priceLines.forEach((l) => l.applyOptions({ color: l.options().title === "TP" ? p.up : p.down }));
});
function showLevels(sig, entry) {
  priceLines.forEach((l) => series.removePriceLine(l));
  const up = sig.action === "BUY";
  const p = pal();
  priceLines = [
    series.createPriceLine({ price: up ? entry - sig.slDist : entry + sig.slDist, color: p.down, lineStyle: 2, lineWidth: 1, title: "SL" }),
    series.createPriceLine({ price: up ? entry + sig.tpDist : entry - sig.tpDist, color: p.up, lineStyle: 2, lineWidth: 1, title: "TP" }),
  ];
}
function addMarker(epoch, side, text) {
  markers.push({ time: epoch, position: side === "BUY" ? "belowBar" : "aboveBar", color: side === "BUY" ? pal().up : pal().down,
                 shape: side === "BUY" ? "arrowUp" : "arrowDown", text });
  markers = markers.filter((m) => m.time >= (st.bars[0]?.epoch ?? 0)).slice(-100);
  series.setMarkers(markers);
}

// ------------------------------------------------------------------ log
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ICON = {
  BUY: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>', SELL: '<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>',
  WIN: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', LOSS: '<path d="M7 7l10 10M17 7L7 17"/>',
  ERROR: '<path d="M12 6v8M12 18.5h.01"/>', INFO: '<path d="M12 10.5v8M12 6h.01"/>',
};
const icon = (k, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" stroke-width="2.4" aria-hidden="true">${ICON[k] || ICON.INFO}</svg>`;
const TAG_WORD = { BUY: "Buy", SELL: "Sell", WIN: "Win", LOSS: "Loss", ERROR: "Problem", INFO: "Info" };
const symbolName = (code) => SYMBOLS.find(([v]) => v === code)?.[1] || code;
// Display only: the feed shows "Volatility 75 Index" where the message has the code "R_75".
const friendly = (text) => (settings.symbol ? String(text ?? "").split(settings.symbol).join(symbolName(settings.symbol)) : String(text ?? ""));
// Wins and losses closed while this page was open, per account and UTC day (display only).
const resultsKey = () => (st.account ? `tbot:ui:results:${st.account.id}` : "");
function todayResults() {
  const day = new Date().toISOString().slice(0, 10);
  const r = resultsKey() ? store.get(resultsKey(), {}) : {};
  return r.day === day ? r : { day, won: 0, lost: 0 };
}
function countResult(tag) {
  if (!resultsKey()) return;
  const r = todayResults();
  if (tag === "WIN") r.won++; else r.lost++;
  store.set(resultsKey(), r);
}
function log(tag, title, detail = "") {
  if (tag === "WIN" || tag === "LOSS") countResult(tag);
  title = friendly(title); detail = friendly(detail);
  const el = document.createElement("div");
  el.className = `feed-item k-${esc(tag)}`;
  el.innerHTML = `<span class="feed-ico">${icon(tag)}</span><div class="feed-body"><div class="feed-top">` +
                 `<span class="feed-title"><span class="sr-only">${esc(TAG_WORD[tag] || tag)}: </span>${esc(title)}</span>` +
                 `<time>${fmtTime(Date.now())}</time></div>${detail ? `<div class="feed-detail">${esc(detail)}</div>` : ""}</div>`;
  $("log").prepend(el);
  while ($("log").children.length > 200) $("log").lastChild.remove();
}
// Display helpers: thousands separators, and a real minus sign for results.
const num = (v, d = 2) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => (Number.isFinite(v) ? `${num(v)} ${st.currency}` : "–");
const signed = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v))} ${st.currency}` : "–");
const tone = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const px = (v) => (Number.isFinite(v) ? num(v, v > 1000 ? 2 : 4) : "–");

// -------------------------------------------------------- notifications
let audioCtx;
function beep() {
  if (!settings.sound) return;
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* no audio */ }
}
function notify(title, body) {
  beep();
  navigator.vibrate?.(200);
  if (!settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body, icon: "icon.svg", tag: "tbot" }); } catch { /* some mobile browsers need a service worker */ }
}

// ------------------------------------------------------------ rendering
function setConn(status) {
  $("connDot").className = "dot " + (status === "online" ? "online" : status === "offline" ? "offline" : "");
  const where = st.trading && st.account ? `${st.account.type === "demo" ? "demo" : "REAL"} account` : "prices only";
  $("connText").textContent = status === "online" ? `live · ${where}` : status === "offline" ? "reconnecting…" : "connecting…";
}

let accountsShown = "";
function renderAccount() {
  const loggedIn = !!st.auth;
  const real = loggedIn && st.account?.type === "real";
  $("loginCard").hidden = loggedIn;
  $("accountCard").hidden = !loggedIn;
  $("hdrLogin").hidden = loggedIn;
  $("loginAppIdRow").hidden = !!CONFIG.appId;
  $("realWarn").hidden = !real;
  document.body.dataset.acct = !loggedIn || !st.account ? "none" : real ? "real" : "demo";
  if (!loggedIn) { accountsShown = ""; return; }
  // Rebuilt only when the accounts change, so an open picker isn't reset by every balance update.
  const shown = st.accounts.map((a) => `${a.id}:${a.type}:${a.currency}`).join("|") + "@" + st.account?.id;
  if (shown !== accountsShown) {
    accountsShown = shown;
    $("accountSelect").innerHTML = st.accounts.map((a) =>
      `<option value="${esc(a.id)}" ${a.id === st.account?.id ? "selected" : ""}>${a.type === "demo" ? "Demo" : "REAL money"} · ${esc(a.id)} · ${esc(a.currency)}</option>`).join("");
    $("acctList").innerHTML = st.accounts.map((a) => {
      const demo = a.type === "demo";
      return `<button type="button" class="acct-row ${demo ? "is-demo" : "is-real"}" data-account="${esc(a.id)}" aria-pressed="${a.id === st.account?.id}">` +
        `<span class="acct-badge ${demo ? "demo" : "real"}">${demo ? "DEMO" : "REAL MONEY"}</span>` +
        `<span class="acct-row-main"><b>${esc(a.id)}</b><span>${demo ? "Practice money" : "Your own money"} · ${esc(a.currency)}</span></span>` +
        `<svg class="tick" viewBox="0 0 24 24" width="20" height="20" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>`;
    }).join("");
  }
  // Fallback: if the list can't be drawn, the plain account picker is shown, so you can always leave a REAL account.
  $("accountSelect").hidden = $("acctList").children.length > 0;
  $("accountCard").dataset.type = real ? "real" : "demo";
  $("acctBadge").textContent = real ? "REAL MONEY" : "DEMO";
  $("sheetType").textContent = real ? "REAL MONEY" : "Demo · practice money";
  $("sheetType").className = "acct-badge " + (real ? "real" : "demo");
  $("sheetId").textContent = st.account?.id || "";
  $("accountCard").setAttribute("aria-label", `${real ? "REAL money" : "Demo"} account ${st.account?.id || ""}, balance ${money(st.balance)}. Opens the account menu.`);
  $("balance").textContent = money(st.balance);
  $("sheetBalance").textContent = money(st.balance);
  if (st.guard && Number.isFinite(equity())) {
    const pl = st.guard.dayPL(equity());
    const start = st.guard.state.startBalance;
    const amount = start > 0 ? equity() - start : NaN;
    const pct = `${pl > 0 ? "+" : pl < 0 ? "−" : ""}${Math.abs(pl).toFixed(2)}%`;
    $("dayPL").textContent = Number.isFinite(amount) ? `${signed(amount)} · ${pct} today` : `${pct} today`;
    $("dayPL").className = "acct-pl " + tone(pl);
    $("sheetPL").textContent = Number.isFinite(amount) ? signed(amount) : pct;
    $("sheetPL").className = tone(pl);
    $("sheetPLPct").textContent = Number.isFinite(amount) ? pct : "";
    $("sheetPLPct").className = "pct " + tone(pl);
  } else {
    $("dayPL").textContent = ""; $("sheetPL").textContent = "–"; $("sheetPL").className = ""; $("sheetPLPct").textContent = "";
  }
  const r = todayResults();
  $("sheetWon").textContent = r.won;
  $("sheetLost").textContent = r.lost;
  $("sheetFee").textContent = st.lastCost ? `about ${money(st.lastCost.commission)}` : "shown after the first trade";
}

function renderControls() {
  document.querySelectorAll("[data-strategy]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.strategy === settings.strategy));
    b.disabled = b.dataset.strategy === "ai" && !st.model;
  });
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === settings.mode)));
  const auto = settings.mode === "auto", running = st.running, market = symbolName(settings.symbol);
  const real = st.trading && st.account?.type === "real";
  const needLogin = auto && !st.trading;
  $("runBtn").textContent = running ? "Stop bot" : needLogin ? "Log in to auto trade" : auto && real ? "Start auto trading · REAL money"
    : auto ? "Start auto trading" : "Start signals";
  $("runBtn").className = "run-btn " + (running ? "is-stop" : needLogin ? "is-login" : auto && real ? "is-real" : auto ? "is-auto" : "is-start");
  const guardMsg = st.guard?.blockReason(st.contracts.size) || "";
  const fullUp = guardMsg === "max open trades reached";   // the normal wait while a trade is open
  const waiting = running && auto && !!guardMsg && !fullUp;
  $("botState").textContent = !running ? "Bot is off" : !auto ? "Watching for signals" : waiting ? "Auto trading paused" : "Auto trading";
  $("barSub").textContent =
      !running && needLogin ? "Log in first. Signals only works without an account."
    : !running && auto ? `Places trades on your ${real ? "REAL money" : "demo"} account.`
    : !running ? "Alerts only. Nothing is traded."
    : !auto ? `Alerts for ${market}. Nothing is traded.`
    : fullUp ? `A trade is open (limit ${settings.maxOpen}). Looks again when it closes.`
    : waiting ? waitText(guardMsg)
    : `Looking for trades on ${market}.`;
  const trades = st.guard?.state.trades || 0, max = +settings.maxTradesPerDay;
  $("tradesToday").textContent = st.guard ? (max ? `${trades} of ${max}` : String(trades)) : "–";
  $("infoLabel").textContent = settings.strategy === "ai" ? "AI forecast" : "Market now";
  // display only: the sticky bar, the mode lock while running, and what the chosen mode will do
  const bar = $("actionBar");
  bar.dataset.state = running ? settings.mode : "stopped";
  bar.dataset.wait = waiting ? "1" : "";
  bar.dataset.acct = !st.trading || !st.account ? "none" : real ? "real" : "demo";
  $("barMode").textContent = `${settings.strategy === "ai" ? "AI model" : "Rules"} · ${auto ? "Auto trade" : "Signals only"}`;
  $("barAcct").textContent = real ? "REAL MONEY" : "Demo";
  $("barAcct").hidden = !st.trading || !st.account;
  $("modeSeg").classList.toggle("locked", running);
  const note = $("modeNote");
  if (!auto) { note.textContent = "You get an alert with entry, stop loss and take profit. Nothing is traded."; note.className = "mode-note"; }
  else if (!st.trading || !st.account) { note.textContent = "Auto trade needs your Deriv account. Log in first."; note.className = "mode-note is-warn"; }
  else if (real) { note.textContent = `Trades will use REAL money on ${st.account.id}.`; note.className = "mode-note is-real"; }
  else { note.textContent = `Trades go to your demo account ${st.account.id} (practice money).`; note.className = "mode-note is-demo"; }
  if (running) note.textContent += " Stop the bot to switch mode.";
}

/** The risk guard's reason for not trading, in plain words. */
function waitText(msg) {
  const s = st.guard?.state || {};
  if (msg.startsWith("cooling down")) {
    const left = Math.max(1, Math.ceil(((s.cooldownUntil || 0) - Date.now()) / 60000));
    return `A ${settings.cooldownMinutes}-min break after ${settings.maxConsecLosses} losses in a row (${left} min left).`;
  }
  if (msg === "max trades for today reached") return `Today's limit of ${settings.maxTradesPerDay} trades is reached. No new trades until tomorrow (UTC).`;
  if (msg.startsWith("daily loss limit")) {
    const pct = (msg.match(/\(([^)]+)\)/) || [])[1];
    return `Stopped for today: daily loss limit reached${pct ? ` (${pct.replace("-", "−")})` : ""}. No new trades until tomorrow (UTC).`;
  }
  if (msg === "halted for today") return "Stopped for today. No new trades until tomorrow (UTC).";
  return `Paused: ${msg}.`;
}

const REGIME_WORDS = { TREND: "Trending", RANGE: "Moving sideways", UNCLEAR: "No clear direction" };
const REGIME_PLAIN = {
  TREND: "Rules wait for a small dip to join the move.",
  RANGE: "Rules look for bounces off the edges.",
  UNCLEAR: "No clear pattern, so Rules wait.",
};
const NOTE_PLAIN = { "loading history": "Loading price history…", "volatility spike": "Prices are jumping a lot, so the bot holds off for now.",
                     "model not loaded": "The AI model couldn't be loaded." };
function renderInfo(res) {
  const i = res.info || {};
  if (i.note) {
    $("infoText").textContent = i.note.charAt(0).toUpperCase() + i.note.slice(1);
    $("infoPlain").textContent = NOTE_PLAIN[i.note] && NOTE_PLAIN[i.note].toLowerCase() !== i.note + "…" ? NOTE_PLAIN[i.note] : "";
    $("infoSub").textContent = "";
    return;
  }
  if (settings.strategy === "ai") {
    const pct = (v) => (v * 100).toFixed(0), top = Math.max(i.pUp, i.pDn, i.pNone);
    $("infoText").textContent = top === i.pUp ? "Leans up" : top === i.pDn ? "Leans down" : "No clear move";
    $("infoPlain").textContent = top === i.pUp ? `The AI leans up: ${pct(i.pUp)}% chance of a rise.`
      : top === i.pDn ? `The AI leans down: ${pct(i.pDn)}% chance of a fall.` : "The AI expects no clear move right now.";
    $("infoSub").textContent = `Up ${pct(i.pUp)}% · Down ${pct(i.pDn)}% · Flat ${pct(i.pNone)}% · signals at ${Math.round(+settings.aiThreshold * 100)}%`;
  } else {
    $("infoText").textContent = REGIME_WORDS[i.regime] || i.regime;
    $("infoPlain").textContent = REGIME_PLAIN[i.regime] || "";
    $("infoSub").textContent = `ADX ${i.adx?.toFixed(0)} · RSI ${i.rsi?.toFixed(0)}`;
  }
}

const EMPTY_OPEN = `<div class="empty"><span class="empty-ico"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">` +
  `<path d="M3.5 8h17v11h-17zM8.5 8V5.5h7V8"/></svg></span><div><b>No open trades</b>Trades the bot opens show here with live profit and loss.</div></div>`;
function renderOpen() {
  const n = st.contracts.size, list = $("openList");
  $("openCount").textContent = String(n);
  $("openCount").hidden = !n;
  const total = [...st.contracts.values()].reduce((sum, c) => sum + (Number.isFinite(c.profit) ? c.profit : 0), 0);
  $("openTotal").hidden = n < 2;
  $("openTotalVal").textContent = signed(total);
  $("openTotalVal").className = tone(total);
  if (!n) { list.innerHTML = EMPTY_OPEN; list.dataset.ids = ""; return; }
  // Rebuilt only when the set of trades changes. Live profit updates change the numbers in place,
  // so the Close button is never replaced under a finger.
  const ids = [...st.contracts.keys()].join(" ");
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids;
    list.innerHTML = [...st.contracts.keys()].map((id) => `
    <div class="pos-card" data-trade="${esc(id)}">
      <div class="pos-top">
        <span class="side-badge"></span>
        <div class="pos-name"><b></b><span class="pos-stake"></span></div>
        <div class="pos-pl"><b></b><span></span></div>
      </div>
      <div class="pos-foot">
        <span class="live"></span>
        <button class="btn btn-outline btn-sm" data-close="${esc(id)}" type="button">Close</button>
      </div>
    </div>`).join("");
  }
  for (const card of list.querySelectorAll("[data-trade]")) {
    const c = st.contracts.get(card.dataset.trade);
    if (!c) continue;
    const buy = c.side !== "SELL";
    const side = card.querySelector(".side-badge");
    const sideHtml = c.side === "?" ? "…" : `${icon(buy ? "BUY" : "SELL", 14)}${esc(c.side)}`;
    if (side.dataset.side !== c.side) { side.dataset.side = c.side; side.className = `side-badge ${buy ? "buy" : "sell"}`; side.innerHTML = sideHtml; }
    card.querySelector(".pos-name b").textContent = symbolName(settings.symbol);
    card.querySelector(".pos-stake").textContent = `Stake ${money(c.buyPrice)}`;
    const pl = card.querySelector(".pos-pl");
    pl.className = `pos-pl ${tone(c.profit)}`;
    pl.querySelector("b").textContent = signed(c.profit);
    pl.querySelector("span").textContent = Number.isFinite(c.profit) && c.buyPrice > 0
      ? `${c.profit > 0 ? "+" : c.profit < 0 ? "−" : ""}${Math.abs((c.profit / c.buyPrice) * 100).toFixed(2)}%` : "";
    card.querySelector(".live").textContent = c.horizon ? `Closes by itself after ${c.horizon} min` : "Stop loss and take profit are set";
  }
}

/** The latest signal or opened trade, shown above the bot setup. Display only. */
function renderSignal(d) {
  try {
    const buy = d.action === "BUY", size = d.size;
    const cost = Number.isFinite(d.commission) ? money(d.commission)
      : st.lastCost ? `about ${money(st.lastCost.commission)}` : "shown after the first trade quote";
    const stake = size?.ok ? `${money(size.stake)} at x${d.mult}` : size ? size.reason : "Log in to see the stake for your balance";
    const card = $("signalCard");
    card.className = "signal " + (buy ? "is-buy" : "is-sell");
    card.dataset.ts = String(Date.now());
    card.innerHTML = `
      <div class="sig-head">
        <span class="side-badge ${buy ? "buy" : "sell"}">${icon(buy ? "BUY" : "SELL", 14)}${buy ? "BUY" : "SELL"}</span>
        <div class="sig-title"><b>${d.opened ? "Trade opened" : `${buy ? "Buy" : "Sell"} signal`}</b>
          <span>${esc(symbolName(settings.symbol))} · <span class="sig-age">just now</span> <span class="sig-old">Old signal</span></span></div>
        <button class="icon-btn" type="button" data-hide-signal aria-label="Hide this signal">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="levels">
        <div><span class="k">Signal price</span><b>${px(d.entry)}</b></div>
        <div><span class="k">Stop loss</span><b>${px(d.sl)}</b>${size?.ok ? `<span class="m neg">−${money(size.stopLoss)}</span>` : ""}</div>
        <div><span class="k">Take profit</span><b>${px(d.tp)}</b>${size?.ok ? `<span class="m pos">+${money(size.takeProfit)}</span>` : ""}</div>
      </div>
      <p class="levels-note">Approximate prices from the last 1-minute close${d.opened ? ". Deriv's actual fill can differ a little" : ""}.</p>
      <dl class="sig-rows">
        <dt>Stake</dt><dd>${esc(stake)}</dd>
        <dt>Deriv fee</dt><dd>${esc(cost)}</dd>
        <dt>Why</dt><dd class="why">${esc(d.reason)}</dd>
      </dl>
      <p class="sig-foot">${d.opened
        ? `Opened by the bot on your ${st.account?.type === "real" ? "REAL money" : "demo"} account. Follow it under Open trades.`
        : "Signals only, so nothing was traded."}</p>`;
    card.hidden = false;
  } catch { /* display only */ }
}

// --------------------------------------------------------------- market
function normBar(c) {
  return { epoch: Number(c.epoch ?? c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close };
}

function onCandles(msg) {
  if (msg.error) return;
  if (msg.msg_type === "candles") {
    const all = (msg.candles || []).map(normBar);
    st.forming = all.pop() || null;
    st.bars = all;
    series.setData([...st.bars, ...(st.forming ? [st.forming] : [])].map((b) => ({ time: b.epoch, ...b })));
    updatePrice();
    evaluate(false);
  } else if (msg.msg_type === "ohlc") {
    const o = msg.ohlc;
    const bar = { epoch: Number(o.open_time), open: +o.open, high: +o.high, low: +o.low, close: +o.close };
    if (!st.forming || bar.epoch > st.forming.epoch) {
      if (st.forming) {
        st.bars.push(st.forming);
        if (st.bars.length > HISTORY_BARS * 1.5) st.bars.splice(0, st.bars.length - HISTORY_BARS);
        st.forming = bar;
        series.update({ time: bar.epoch, ...bar });
        onBarClosed();
      } else st.forming = bar;
    } else if (bar.epoch === st.forming.epoch) st.forming = bar;
    series.update({ time: st.forming.epoch, ...st.forming });
    updatePrice();
  }
}

let shownPrice = NaN;
function updatePrice() {
  const p = st.forming?.close ?? st.bars.at(-1)?.close;
  $("lastPrice").textContent = px(p);
  if (Number.isFinite(p) && Number.isFinite(shownPrice) && p !== shownPrice) $("lastPrice").dataset.dir = p > shownPrice ? "up" : "down";
  shownPrice = p;
}

function strategyParams() {
  return settings.strategy === "ai"
    ? { threshold: +settings.aiThreshold, margin: AI_DEFAULTS.margin, barrierATR: +settings.aiBarrier, horizonBars: +settings.aiHorizon }
    : RULES_DEFAULTS;
}

function evaluate(actOnSignal) {
  if (!st.bars.length) return null;
  const res = settings.strategy === "ai" ? evaluateAI(st.bars, st.model, strategyParams()) : evaluateRules(st.bars, strategyParams());
  renderInfo(res);
  if (actOnSignal && res.action) handleSignal(res).catch((e) => log("ERROR", "Signal handling failed", e.message));
  return res;
}

function onBarClosed() {
  timeExits();
  if (!st.running) { evaluate(false); return; }
  evaluate(true);
  renderControls();
}

// -------------------------------------------------------------- signals
function chooseMultiplier() {
  const m = +settings.multiplier;
  return st.multipliers.includes(m) ? m : st.multipliers[0];
}

async function handleSignal(sig) {
  const lastBar = st.bars.at(-1);
  const entry = lastBar.close;
  const gapMin = settings.mode === "signals" ? Math.max(+settings.signalGap, sig.horizonBars || 0) : 0;
  if (gapMin && lastBar.epoch - st.lastSignalEpoch < gapMin * 60) return;

  const mult = chooseMultiplier();
  const size = Number.isFinite(st.balance)
    ? sizeMultiplier({ balance: st.balance, riskPct: +settings.riskPct, entry, slDist: sig.slDist, tpDist: sig.tpDist,
                       multiplier: mult, minStake: st.minStake, maxStake: st.maxStake })
    : null;
  const up = sig.action === "BUY";
  const sl = up ? entry - sig.slDist : entry + sig.slDist, tp = up ? entry + sig.tpDist : entry - sig.tpDist;
  const sizeText = size?.ok ? `stake ${money(size.stake)} at x${mult} · risk ${money(size.stopLoss)} · target ${money(size.takeProfit)}`
                 : size ? size.reason : "log in to see the stake for your balance";

  if (settings.mode === "signals") {
    st.lastSignalEpoch = lastBar.epoch;
    addMarker(lastBar.epoch, sig.action, sig.action);
    showLevels(sig, entry);
    log(sig.action, `${sig.action} ${settings.symbol} @ ${px(entry)}`, `SL ${px(sl)} · TP ${px(tp)} · ${sizeText} · ${sig.reason}`);
    renderSignal({ action: sig.action, entry, sl, tp, size, mult, reason: sig.reason, opened: false });
    notify(`Tbot: ${sig.action} ${settings.symbol}`, `Entry ${px(entry)} · SL ${px(sl)} · TP ${px(tp)}`);
    return;
  }

  // ---- auto trade
  if (!st.trading) { log("ERROR", "Auto trade needs a logged-in account"); return; }
  const blocked = st.guard.blockReason(st.contracts.size);
  if (blocked) { log("INFO", `Skipped ${sig.action}: ${blocked}`); return; }
  if (!size?.ok) { log("INFO", `Skipped ${sig.action}`, size?.reason || "balance not known yet"); return; }
  if (st.busy) return;
  st.busy = true;
  try {
    const p = await st.socket.send({
      proposal: 1, amount: size.stake, basis: "stake", contract_type: up ? "MULTUP" : "MULTDOWN",
      currency: st.currency, underlying_symbol: settings.symbol, multiplier: mult, duration_unit: "s",
      limit_order: { stop_loss: size.stopLoss, take_profit: size.takeProfit },
    });
    const prop = p.proposal;
    const commission = Number(prop.commission ?? prop.contract_details?.commission ?? NaN);
    if (Number.isFinite(commission)) {
      st.lastCost = { commission, r: commission / size.stopLoss };
      $("costText").textContent = `${money(commission)} (${(st.lastCost.r * 100).toFixed(1)}% of the risk)`;
    }
    const b = await st.socket.send({ buy: prop.id, price: Number(prop.ask_price ?? size.stake) });
    const buy = b.buy;
    st.guard.recordEntry();
    st.lastSignalEpoch = lastBar.epoch;
    addMarker(lastBar.epoch, sig.action, sig.action);
    showLevels(sig, entry);
    trackContract(buy.contract_id, { side: sig.action, entryEpoch: lastBar.epoch, horizon: sig.horizonBars || 0, buyPrice: Number(buy.buy_price) });
    log(sig.action, `Opened ${sig.action} ${settings.symbol}`, `${sizeText} · ${sig.reason}${Number.isFinite(commission) ? ` · commission ${money(commission)}` : ""}`);
    renderSignal({ action: sig.action, entry, sl, tp, size, mult, reason: sig.reason, opened: true, commission });
    notify(`Tbot opened ${sig.action} ${settings.symbol}`, sizeText);
  } catch (e) {
    log("ERROR", `Deriv refused the ${sig.action} order`, e.message);
  } finally {
    st.busy = false;
    renderControls();
  }
}

// ------------------------------------------------------------ contracts
/** Balance plus what open trades are worth now (stakes are taken from the balance while open). */
function equity() {
  let e = st.balance;
  for (const c of st.contracts.values()) e += c.buyPrice + (c.profit || 0);
  return e;
}

/** Daily loss limit on equity, like the MT5 bots. Skipped while an order is in flight. */
function checkGuard() {
  if (!st.guard || st.busy || !Number.isFinite(equity())) return;
  const { justHalted } = st.guard.update(equity());
  if (justHalted) {
    log("ERROR", `Stopped for today: ${st.guard.state.haltReason}`);
    notify("Tbot stopped for today", st.guard.state.haltReason);
    closeAll("daily loss limit");
    renderControls();
  }
}

function trackContract(id, meta) {
  if (st.contracts.has(String(id))) return;
  const c = { side: "?", profit: 0, buyPrice: NaN, horizon: 0, entryEpoch: 0, ...meta };
  st.contracts.set(String(id), c);
  c.sub = st.socket.subscribe({ proposal_open_contract: 1, contract_id: Number(id) || id }, (msg) => {
    const poc = msg.proposal_open_contract;
    if (!poc || !Object.keys(poc).length) return;
    c.profit = Number(poc.profit ?? c.profit);
    c.buyPrice = Number(poc.buy_price ?? c.buyPrice);
    if (c.side === "?") c.side = String(poc.contract_type).includes("DOWN") ? "SELL" : "BUY";
    const sold = poc.is_sold === 1 || poc.is_sold === true || ["sold", "won", "lost"].includes(poc.status);
    if (sold) {
      c.sub.unsubscribe();
      st.contracts.delete(String(id));
      st.guard?.recordClose(c.profit);
      log(c.profit >= 0 ? "WIN" : "LOSS", `Closed ${c.side} ${settings.symbol}: ${c.profit >= 0 ? "+" : ""}${money(c.profit)}`,
          poc.exit_tick_display_value ? `exit ${poc.exit_tick_display_value}` : "");
      notify(`Tbot closed ${c.side}: ${c.profit >= 0 ? "+" : ""}${c.profit.toFixed(2)}`, settings.symbol);
      renderControls();
    }
    renderOpen();
    checkGuard();
    renderAccount();
  });
  renderOpen();
}

async function closeContract(id, why) {
  try {
    await st.socket.send({ sell: Number(id) || id, price: 0 });
    log("INFO", `Closing trade (${why})`);
  } catch (e) { log("ERROR", "Close failed", e.message); }
}

function timeExits() {
  const last = st.bars.at(-1);
  if (!last) return;
  for (const [id, c] of st.contracts)
    if (c.horizon && last.epoch - c.entryEpoch >= c.horizon * 60 && !c.closing) { c.closing = true; closeContract(id, `${c.horizon} min time limit`); }
}

function closeAll(why) { for (const id of st.contracts.keys()) closeContract(id, why); }

// ------------------------------------------------------------ connection
function subscribeMarket(sock) {
  sock.subscribe({ ticks_history: settings.symbol, style: "candles", granularity: 60, count: HISTORY_BARS, end: "latest", adjust_start_time: 1 }, onCandles);
}

async function onOnline() {
  setConn("online");
  try {
    const r = await st.socket.send({ contracts_for: settings.symbol });
    const items = r.contracts_for?.available || [];
    const mult = items.find((a) => /MULT/.test(a.contract_type) || a.contract_category === "multiplier");
    if (mult?.multiplier_range?.length) st.multipliers = mult.multiplier_range.map(Number).sort((a, b) => a - b);
    if (mult?.min_stake) st.minStake = Number(mult.min_stake);
    if (mult?.max_stake) st.maxStake = Number(mult.max_stake);
    renderMultipliers();
  } catch (e) { /* defaults stay; the proposal will report any limit */ }
  if (st.trading) {
    try {
      const pf = await st.socket.send({ portfolio: 1 });
      for (const c of pf.portfolio?.contracts || [])
        if (/MULT/.test(c.contract_type) && (c.underlying_symbol ?? c.symbol) === settings.symbol) trackContract(c.contract_id, {});
    } catch { /* not critical */ }
  }
}

function makeSocket(urlProvider) {
  st.socket?.close();
  const sock = new DerivSocket(urlProvider, {
    onStatus: (s) => { setConn(s); if (s === "online") onOnline(); },
    onError: (e) => {
      log("ERROR", e.message);
      if (e.auth) { logout(); showLoginMsg("Your Deriv login has expired. Please log in again."); }
    },
  });
  st.socket = sock;
  subscribeMarket(sock);
  if (st.trading) {
    sock.subscribe({ balance: 1 }, (msg) => {
      if (!msg.balance) return;
      st.balance = Number(msg.balance.balance);
      st.currency = msg.balance.currency || st.currency;
      checkGuard();
      renderAccount(); renderControls();
    });
  }
  sock.connect();
}

function connectPublic() {
  st.trading = false;
  makeSocket(async () => cfg.publicWs);
}

function connectAccount(account) {
  st.account = account;
  st.trading = true;
  st.currency = account.currency || "USD";
  st.balance = account.balance;
  st.contracts.clear(); renderOpen();
  st.guard = new RiskGuard(localStorage, account.id, limits());
  if (Number.isFinite(st.balance)) st.guard.update(st.balance);   // no open trades tracked yet
  makeSocket(() => getTradingSocketUrl(cfg, st.auth, account.id));
  renderAccount(); renderControls();
}

const limits = () => ({
  maxDailyLossPct: +settings.maxDailyLossPct, maxOpen: +settings.maxOpen, maxTradesPerDay: +settings.maxTradesPerDay,
  maxConsecLosses: +settings.maxConsecLosses, cooldownMinutes: +settings.cooldownMinutes,
});

// --------------------------------------------------------------- login
function showLoginMsg(text, kind = "warn") {
  const el = $("loginMsg");
  el.textContent = text || "";
  el.className = kind;
  el.hidden = !text;
  if (text) {   // after a failed login the card can sit below the sticky bar: bring the message into view
    const r = el.getBoundingClientRect(), bar = $("actionBar")?.getBoundingClientRect().top ?? innerHeight;
    if (r.top < 0 || r.bottom > bar) el.scrollIntoView({ block: "center" });
  }
}
function setLoginBusy(text) {
  $("loginBtn").disabled = !!text;
  if (text) showLoginMsg(text, "note");
}
// If the page doesn't actually leave for Deriv (stopped, or the link opened elsewhere), allow another try.
function leavingForDeriv() {
  setTimeout(() => { if (!st.auth && $("loginBtn").disabled) { setLoginBusy(""); showLoginMsg(""); } }, 15000);
}
function setAppId(value, from) {
  settings.appId = cleanAppId(value);
  saveSettings();
  cfg.appId = settings.appId || CONFIG.appId;
  if (from !== "login") $("loginAppId").value = settings.appId;
  if (from !== "settings") $("settingsForm").elements.appId.value = settings.appId;
}
// Remembers when an App ID may only ask for trading access, so later logins ask for that directly.
const scopeKey = (id) => `tbot:scope:${id}`;
const scopeFor = (id) => store.get(scopeKey(id), FULL_SCOPE);

function loginFailText(e, fresh) {
  if (e.code === "no_account") return e.message;
  if (e.status === 401) return fresh
    ? `Deriv didn't accept the login (${e.detail || "401"}). Check the App ID and tap Log in again.`
    : "Your Deriv login has expired. Please log in again.";
  if (e.status === 403) return `Deriv logged you in but refused access to your trading accounts (${e.detail || "403"}). ` +
    "In your app at developers.deriv.com, make sure the trading permission (trade) is ticked, then log in again.";
  return e.message;
}

/** A login with no Options account yet gets a demo one, when the login allows creating it. */
async function ensureAccount(auth) {
  const noAccount = (why) => Object.assign(new Error("Your Deriv login has no Options trading account yet" + why), { code: "no_account" });
  if (auth.kind === "oauth" && auth.scope && !hasScope(auth, "account_manage")) {
    try { localStorage.removeItem(scopeKey(auth.clientId)); } catch { /* blocked */ }   // ask for account access next time
    throw noAccount(". Open Deriv's trading site once to create one, or tick account access (account_manage) for your app at developers.deriv.com, then log in again.");
  }
  log("INFO", "No Options account yet, so creating your demo account");
  try {
    const created = await createDemoAccount(cfg, auth);
    return created.length ? created : await getAccounts(cfg, auth);
  } catch (e) {
    throw noAccount(`, and creating a demo one failed (${e.message}).`);
  }
}

async function loginWith(auth, fresh = false) {
  st.auth = auth;
  saveAuth(auth);
  try {
    let accounts = await getAccounts(cfg, auth);
    if (!accounts.length) accounts = await ensureAccount(auth);
    if (!accounts.length) throw Object.assign(new Error("Deriv didn't return any trading accounts for this login."), { code: "no_account" });
    st.accounts = accounts;
    let saved = null;
    try { saved = sessionStorage.getItem("tbot:account"); } catch { /* blocked */ }
    const pick = st.accounts.find((a) => a.id === saved) || st.accounts.find((a) => a.type === "demo" && a.active) ||
                 st.accounts.find((a) => a.type === "demo") || st.accounts[0];
    log("INFO", `Logged in. Using ${pick.type === "demo" ? "demo" : "REAL"} account ${pick.id}`);
    showLoginMsg("");
    connectAccount(pick);
  } catch (e) {
    const msg = loginFailText(e, fresh);
    log("ERROR", "Login failed", msg);
    logout();
    showLoginMsg(msg);
  }
}

function logout() {
  stopBot();
  st.auth = null; st.account = null; st.accounts = []; st.guard = null; st.balance = NaN;
  try { sessionStorage.removeItem("tbot:auth"); sessionStorage.removeItem("tbot:account"); } catch { /* blocked */ }
  st.contracts.clear(); renderOpen();
  renderAccount(); renderControls();
  connectPublic();
}

async function login() {
  if (onOtherHost) { location.assign(CONFIG.siteUrl + "/"); return; }
  const typed = cleanAppId($("loginAppId").value);
  if (typed && typed !== settings.appId) setAppId(typed, "login");
  if (!cfg.appId) {
    showLoginMsg("Paste your Deriv App ID first. It's shown on your app's page at developers.deriv.com.");
    $("loginAppId").focus();
    return;
  }
  setLoginBusy("Opening Deriv's login page…");
  try {
    await startOAuth(cfg, scopeFor(cfg.appId));
    leavingForDeriv();
  } catch (e) {
    setLoginBusy("");
    log("ERROR", "Login failed", e.message);
    showLoginMsg(e.message);
  }
}

/** Handles the page load that Deriv's login sends back. Returns the new auth, or null. */
async function returnFromDeriv() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return null;
  setLoginBusy("Finishing your Deriv login…");
  try {
    return await finishOAuth(cfg);
  } catch (e) {
    if (e.code === "invalid_scope" && e.clientId && e.scope && e.scope !== "trade") {
      // This app may not ask for account access, so log in again asking for trading only.
      store.set(scopeKey(e.clientId), "trade");
      log("INFO", "Deriv refused account access for this app, so logging in again with trading access only");
      setLoginBusy("Logging in again with trading access only…");
      try { await startOAuth({ ...cfg, appId: e.clientId }, "trade"); leavingForDeriv(); return null; } catch (e2) { e = e2; }
    }
    setLoginBusy("");
    log("ERROR", "Login failed", e.message);
    showLoginMsg(e.message);
    return null;
  }
}

// ------------------------------------------------------------- run/stop
async function startBot() {
  if (settings.mode === "auto") {
    if (!st.trading) { log("ERROR", "Log in with Deriv first to auto trade"); return; }
    if (st.account.type === "real" &&
        !confirm(`Auto trade with REAL money on ${st.account.id}?\n\nThe tests showed no proven edge. Only continue if you accept losing what you risk.`)) return;
  }
  if (settings.notify && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignored */ }
  }
  try { st.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
  st.running = true;
  log("INFO", `Bot started: ${settings.strategy === "ai" ? "AI model" : "rules"}, ${settings.mode === "auto" ? "auto trade" : "signals only"}`);
  if (settings.strategy === "rules" && st.bars.length < rulesMinBars()) log("INFO", "Waiting for enough price history");
  renderControls();
}

function stopBot() {
  if (!st.running) return;
  st.running = false;
  st.wakeLock?.release?.().catch(() => {});
  st.wakeLock = null;
  log("INFO", "Bot stopped. Open trades keep their stop loss and take profit.");
  renderControls();
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && st.running && !st.wakeLock) {
    try { st.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* ignored */ }
  }
});

// ------------------------------------------------------------ settings UI
function renderMultipliers() {
  const cur = chooseMultiplier();
  $("multiplierSelect").innerHTML = st.multipliers.map((m) => `<option value="${m}" ${m === cur ? "selected" : ""}>x${m}</option>`).join("");
}

function showRedirect() {
  $("redirectHint").textContent = `Redirect URL to register: ${redirectUri(cfg)}`;
  document.querySelectorAll(".redirectExact").forEach((el) => (el.textContent = redirectUri(cfg)));
}

function fillSettingsForm() {
  const f = $("settingsForm");
  for (const el of f.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === "checkbox") el.checked = !!settings[el.name];
    else if (el.name !== "multiplier") el.value = settings[el.name];
  }
  showRedirect();
  $("loginAppId").value = settings.appId;
}

$("settingsForm").addEventListener("change", (ev) => {
  const el = ev.target;
  if (!el.name || !(el.name in settings)) return;
  if (el.name === "appId") { setAppId(el.value, "settings"); el.value = settings.appId; return; }
  settings[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
  saveSettings();
  if (el.name === "redirectNoSlash") { cfg.redirectNoSlash = el.checked; showRedirect(); }
  if (st.guard) st.guard.limits = limits();
  renderControls();
});
// Save the App ID as it's typed, so it isn't lost if the field never loses focus.
$("settingsForm").elements.appId.addEventListener("input", (ev) => setAppId(ev.target.value, "settings"));
$("loginAppId").addEventListener("input", (ev) => setAppId(ev.target.value, "login"));
$("settingsForm").addEventListener("submit", (e) => e.preventDefault());

document.querySelectorAll("[data-strategy]").forEach((b) => b.addEventListener("click", () => {
  settings.strategy = b.dataset.strategy; saveSettings(); renderControls(); evaluate(false);
}));
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
  if (st.running) { log("INFO", "Stop the bot before switching mode"); return; }
  settings.mode = b.dataset.mode; saveSettings(); renderControls();
}));
$("runBtn").addEventListener("click", () => (st.running ? stopBot() : startBot()));
$("loginBtn").addEventListener("click", login);
// Coming back with the browser's Back button restores the page as it was when it left for Deriv.
addEventListener("pageshow", (e) => {
  if (!e.persisted || st.auth) return;
  setLoginBusy(""); showLoginMsg("");
  if (st.socket?.ws?.readyState !== WebSocket.OPEN) connectPublic();
});
$("patBtn").addEventListener("click", () => {
  const token = $("patInput").value.trim();
  const typed = cleanAppId($("loginAppId").value);
  if (typed && typed !== settings.appId) setAppId(typed, "login");
  if (!cfg.appId) { showLoginMsg("A token also needs your Deriv App ID. Paste it above first."); return; }
  $("patInput").value = "";
  if (token) { showLoginMsg(""); loginWith({ kind: "pat", token, expiresAt: Date.now() + 12 * 3600 * 1000 }, true); }
});
$("logoutBtn").addEventListener("click", () => { logout(); showLoginMsg(""); });
$("accountSelect").addEventListener("change", (e) => {
  const a = st.accounts.find((x) => x.id === e.target.value);
  if (!a) return;
  stopBot();
  sessionStorage.setItem("tbot:account", a.id);
  log("INFO", `Switched to ${a.type === "demo" ? "demo" : "REAL"} account ${a.id}`);
  connectAccount(a);
});
$("symbolSelect").addEventListener("change", (e) => {
  settings.symbol = e.target.value; saveSettings();
  stopBot();
  st.bars = []; st.forming = null; markers = []; series.setMarkers([]);
  priceLines.forEach((l) => series.removePriceLine(l)); priceLines = [];
  if (st.trading) connectAccount(st.account); else connectPublic();
});
$("openList").addEventListener("click", (e) => {
  const id = e.target.closest("[data-close]")?.dataset.close;
  if (id) closeContract(id, "closed by you");
});

// ---------------------------------------------------- history download
$("downloadBtn").addEventListener("click", async () => {
  const days = Math.max(1, Math.min(365, Number($("histDays").value) || 30));
  const want = days * 1440;
  const btn = $("downloadBtn");
  btn.disabled = true;
  const rows = new Map();
  let end = "latest";
  try {
    while (rows.size < want) {
      btn.textContent = `Downloading… ${rows.size.toLocaleString()} bars`;
      const r = await st.socket.send({ ticks_history: settings.symbol, style: "candles", granularity: 60, count: 5000, end: String(end) }, 30000);
      const c = r.candles || [];
      if (!c.length) break;
      c.forEach((b) => rows.set(Number(b.epoch), b));
      const first = Number(c[0].epoch);
      if (end !== "latest" && first >= Number(end)) break;
      end = first - 1;
    }
    const sorted = [...rows.values()].sort((a, b) => a.epoch - b.epoch).slice(-want);
    const csv = "time,open,high,low,close\n" + sorted.map((b) =>
      `${new Date(b.epoch * 1000).toISOString().replace("T", " ").slice(0, 19)},${b.open},${b.high},${b.low},${b.close}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${settings.symbol}_M1.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    log("INFO", `Downloaded ${sorted.length.toLocaleString()} bars of ${settings.symbol}`);
  } catch (e) {
    log("ERROR", "Download failed", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Download CSV";
  }
});

// ------------------------------------------------------------------ boot
async function boot() {
  $("symbolSelect").innerHTML = SYMBOLS.map(([v, n]) => `<option value="${v}" ${v === settings.symbol ? "selected" : ""}>${esc(n)}</option>`).join("");
  fillSettingsForm();
  renderMultipliers();
  try {
    const res = await fetch("model/tbotai-model.json");
    if (res.ok) st.model = await res.json();
  } catch { /* AI stays disabled */ }
  renderAccount(); renderControls();
  if (onOtherHost) {
    $("siteLink").href = CONFIG.siteUrl + "/";
    $("siteLink").textContent = new URL(CONFIG.siteUrl).host;
    $("otherHostNote").hidden = false;
  }
  $("inAppHint").hidden = !inAppBrowser;
  log("INFO", settings.mode === "auto"
    ? "Mode is Auto trade. The bot places trades only after you press Start."
    : "Signals only is on. Nothing will be traded until you switch to Auto trade and start the bot.");

  let auth = await returnFromDeriv(), fresh = !!auth;
  if (!auth && !$("loginBtn").disabled) {
    try { auth = JSON.parse(sessionStorage.getItem("tbot:auth") || "null"); } catch { auth = null; }
    if (auth && !(auth.expiresAt > Date.now()) && !auth.refreshToken) { auth = null; log("INFO", "Your Deriv login expired. Please log in again."); }
  }
  if (auth) { await loginWith(auth, fresh); setLoginBusy(""); }
  else if (!$("loginBtn").disabled) connectPublic();
}

if (isLocal) window.tbot = { st, settings, handleSignal, evaluate };   // test hook
boot();
