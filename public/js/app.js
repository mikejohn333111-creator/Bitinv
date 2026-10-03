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
};
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const settings = { ...DEFAULT_SETTINGS, ...store.get("tbot:settings", {}) };
const saveSettings = () => store.set("tbot:settings", settings);
cfg.appId = cleanAppId(settings.appId) || CONFIG.appId;
const saveAuth = (auth) => { try { sessionStorage.setItem("tbot:auth", JSON.stringify(auth)); } catch { /* blocked */ } };
cfg.onAuthChange = saveAuth;   // keeps a refreshed token for this tab
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
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const chart = createChart($("chart"), {
  autoSize: true,
  layout: { background: { color: "transparent" }, textColor: dark ? "#8d98a7" : "#667085", fontSize: 11 },
  grid: { vertLines: { color: dark ? "#1d242c" : "#eef0f3" }, horzLines: { color: dark ? "#1d242c" : "#eef0f3" } },
  rightPriceScale: { borderVisible: false },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  crosshair: { mode: CrosshairMode.Normal },
});
const series = chart.addCandlestickSeries({
  upColor: dark ? "#3ccf95" : "#12805c", downColor: dark ? "#ff7a70" : "#c4332b",
  wickUpColor: dark ? "#3ccf95" : "#12805c", wickDownColor: dark ? "#ff7a70" : "#c4332b", borderVisible: false,
});
let markers = [], priceLines = [];
function showLevels(sig, entry) {
  priceLines.forEach((l) => series.removePriceLine(l));
  const up = sig.action === "BUY";
  priceLines = [
    series.createPriceLine({ price: up ? entry - sig.slDist : entry + sig.slDist, color: "#c4332b", lineStyle: 2, lineWidth: 1, title: "SL" }),
    series.createPriceLine({ price: up ? entry + sig.tpDist : entry - sig.tpDist, color: "#12805c", lineStyle: 2, lineWidth: 1, title: "TP" }),
  ];
}
function addMarker(epoch, side, text) {
  markers.push({ time: epoch, position: side === "BUY" ? "belowBar" : "aboveBar", color: side === "BUY" ? "#12805c" : "#c4332b",
                 shape: side === "BUY" ? "arrowUp" : "arrowDown", text });
  markers = markers.filter((m) => m.time >= (st.bars[0]?.epoch ?? 0)).slice(-100);
  series.setMarkers(markers);
}

// ------------------------------------------------------------------ log
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function log(tag, title, detail = "") {
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<span class="tag ${esc(tag)}">${esc(tag)}</span><span class="title">${esc(title)}</span>` +
                 `<span class="time">${fmtTime(Date.now())}</span>${detail ? `<span class="detail">${esc(detail)}</span>` : ""}`;
  $("log").prepend(el);
  while ($("log").children.length > 200) $("log").lastChild.remove();
}
const money = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} ${st.currency}` : "–");
const px = (v) => (Number.isFinite(v) ? v.toFixed(v > 1000 ? 2 : 4) : "–");

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
  const where = st.trading && st.account ? `${st.account.type === "demo" ? "demo" : "REAL"} ${st.account.id}` : "prices only";
  $("connText").textContent = status === "online" ? `live · ${where}` : status === "offline" ? "reconnecting…" : "connecting…";
}

function renderAccount() {
  const loggedIn = !!st.auth;
  $("loginCard").hidden = loggedIn;
  $("accountCard").hidden = !loggedIn;
  $("loginAppIdRow").hidden = !!CONFIG.appId;
  if (!loggedIn) return;
  $("accountSelect").innerHTML = st.accounts.map((a) =>
    `<option value="${esc(a.id)}" ${a.id === st.account?.id ? "selected" : ""}>${a.type === "demo" ? "Demo" : "REAL"} · ${esc(a.id)} · ${esc(a.currency)}</option>`).join("");
  $("realWarn").hidden = st.account?.type !== "real";
  $("balance").textContent = money(st.balance);
  if (st.guard && Number.isFinite(equity())) {
    const pl = st.guard.dayPL(equity());
    $("dayPL").textContent = `${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%`;
    $("dayPL").className = "big " + (pl > 0 ? "pos" : pl < 0 ? "neg" : "");
  }
}

function renderControls() {
  document.querySelectorAll("[data-strategy]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.strategy === settings.strategy));
    b.disabled = b.dataset.strategy === "ai" && !st.model;
  });
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === settings.mode)));
  $("runBtn").textContent = st.running ? "Stop bot" : settings.mode === "auto" ? "Start auto trading" : "Start signals";
  $("runBtn").className = "btn big-btn " + (st.running ? "danger" : "primary");
  const guardMsg = st.guard?.blockReason(st.contracts.size) || "";
  $("botState").textContent = !st.running ? "stopped"
    : `${settings.mode === "auto" ? "auto trading" : "watching for signals"}${guardMsg && settings.mode === "auto" ? ` · waiting: ${guardMsg}` : ""}`;
  $("tradesToday").textContent = st.guard ? `${st.guard.state.trades || 0}${settings.maxTradesPerDay ? " / " + settings.maxTradesPerDay : ""}` : "–";
  $("infoLabel").textContent = settings.strategy === "ai" ? "Model" : "Market";
}

function renderInfo(res) {
  const i = res.info || {};
  if (i.note) { $("infoText").textContent = i.note; return; }
  $("infoText").textContent = settings.strategy === "ai"
    ? `up ${(i.pUp * 100).toFixed(0)}% · down ${(i.pDn * 100).toFixed(0)}% · flat ${(i.pNone * 100).toFixed(0)}%`
    : `${i.regime} · ADX ${i.adx?.toFixed(0)} · RSI ${i.rsi?.toFixed(0)}`;
}

function renderOpen() {
  if (!st.contracts.size) { $("openList").innerHTML = `<p class="muted small">None.</p>`; return; }
  $("openList").innerHTML = [...st.contracts.entries()].map(([id, c]) => `
    <div class="item"><span class="tag ${c.side}">${c.side}</span>
      <span class="title">${esc(settings.symbol)} · stake ${money(c.buyPrice)}</span>
      <button class="btn small" data-close="${esc(id)}" type="button">Close</button>
      <span class="detail">P/L <b class="${c.profit >= 0 ? "pos" : "neg"}">${money(c.profit)}</b>${c.horizon ? ` · auto-close after ${c.horizon} min` : ""}</span>
    </div>`).join("");
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

function updatePrice() {
  const p = st.forming?.close ?? st.bars.at(-1)?.close;
  $("lastPrice").textContent = px(p);
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
}
function setLoginBusy(text) {
  $("loginBtn").disabled = !!text;
  if (text) showLoginMsg(text, "note");
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
      try { await startOAuth({ ...cfg, appId: e.clientId }, "trade"); return null; } catch (e2) { e = e2; }
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

function fillSettingsForm() {
  const f = $("settingsForm");
  for (const el of f.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === "checkbox") el.checked = !!settings[el.name];
    else if (el.name !== "multiplier") el.value = settings[el.name];
  }
  $("redirectHint").textContent = `Redirect URL to register: ${redirectUri()}`;
  document.querySelectorAll(".redirectExact").forEach((el) => (el.textContent = redirectUri()));
  $("loginAppId").value = settings.appId;
}

$("settingsForm").addEventListener("change", (ev) => {
  const el = ev.target;
  if (!el.name || !(el.name in settings)) return;
  if (el.name === "appId") { setAppId(el.value, "settings"); el.value = settings.appId; return; }
  settings[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
  saveSettings();
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
addEventListener("pageshow", (e) => { if (e.persisted && !st.auth) { setLoginBusy(""); showLoginMsg(""); } });
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
