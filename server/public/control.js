// Tbot server control page. Talks only to this server's /api. Polls every 3 seconds while
// the page is visible and pauses while it is hidden. No inline scripts (strict CSP).
const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
const SCAN_POLL_MS = 15000, SCAN_BUSY_MS = 3000;   // the scanner list is asked for less often than the status
const ui = { screen: "loading", status: null, lastSeq: 0, stateKey: null, timer: null, dirty: new Set(), restart: null, chart: null,
             scan: null, scanAt: 0, scanSkew: 0, scanSig: "", scanSaving: false, focusId: null, picked: false, chartKey: "", logAll: false };

// ------------------------------------------------------------- helpers
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, data: { message: "Can't reach the bot server. Check your internet connection." } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== "/api/login" && path !== "/api/password") show("login");
  if (res.status === 503 && data.error === "no_password") show("nopass");
  return { ok: res.ok, status: res.status, data };
}

const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, cur) => (Number.isFinite(v) ? `${nf2.format(v)} ${cur || ""}`.trim() : "–");
const signed = (v, cur) => (Number.isFinite(v) ? `${v > 0 ? "+" : ""}${money(v, cur)}` : "–");
const px = (v) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) > 1000 ? 2 : 5 }) : "–");
function when(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setMsg(id, text, kind = "") {
  const m = $(id);
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
  m.hidden = !text;
}
let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
const announce = (text) => { $("announce").textContent = text; };
async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

// ------------------------------------------------------------- screens
function show(screen) {
  if (ui.screen === screen) return;
  ui.screen = screen;
  for (const [name, id] of [["loading", "screenLoading"], ["nopass", "screenNoPassword"], ["offline", "screenOffline"],
                            ["login", "screenLogin"], ["main", "screenMain"]]) $(id).hidden = name !== screen;
  $("conn").hidden = screen !== "main";
  if (screen === "login") {
    clearTimeout(ui.timer);
    ui.lastSeq = 0; $("logList").replaceChildren();
    ui.scanAt = 0;
    setTimeout(() => $("loginPassword").focus(), 50);
  }
}

// ------------------------------------------------------------- polling
function schedule(ms = POLL_MS) {
  clearTimeout(ui.timer);
  if (document.visibilityState === "visible" && ui.screen !== "login") ui.timer = setTimeout(refresh, ms);
}

async function refresh() {
  clearTimeout(ui.timer);
  const r = await api("GET", "/api/status");
  if (ui.restart) {
    // After an update: wait until the old server has gone and the new one answers, then reload.
    if (!r.ok) ui.restart.down = true;
    if (r.ok && (ui.restart.down || Date.now() - ui.restart.at > 20000)) { location.reload(); return; }
  }
  if (r.ok) {
    show("main");
    render(r.data);
    await pullLog();
    await pullScanner();
  } else if (r.status === 0 || r.status >= 500 && r.status !== 503) {
    if (ui.screen === "main") setConn("unreachable"); else show("offline");
  }
  schedule(ui.screen === "nopass" ? 5000 : POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { if (ui.screen !== "login") refresh(); }
  else clearTimeout(ui.timer);
});

async function pullLog() {
  const r = await api("GET", `/api/log?after=${ui.lastSeq}`);
  if (!r.ok) return;
  if (r.data.last < ui.lastSeq) { ui.lastSeq = 0; $("logList").replaceChildren(); return pullLog(); }
  const list = $("logList");
  for (const e of r.data.entries || []) {
    ui.lastSeq = Math.max(ui.lastSeq, e.seq);
    const li = el("li");
    li.append(el("span", `tag ${e.tag}`, e.tag), el("span", "title", e.title), el("time", "time", when(e.t)));
    li.lastChild.dateTime = new Date(e.t).toISOString();
    if (e.detail) li.append(el("span", "detail", e.detail));
    list.prepend(li);
  }
  while (list.children.length > 200) list.lastChild.remove();
  $("logEmpty").hidden = list.children.length > 0;
  $("logMore").hidden = list.children.length <= LOG_SHORT;
}
const LOG_SHORT = 5;   // entries shown until "Show all"
$("logMore").addEventListener("click", () => {
  ui.logAll = !ui.logAll;
  $("logList").classList.toggle("short", !ui.logAll);
  $("logMore").textContent = ui.logAll ? "Show less" : "Show all";
  $("logMore").setAttribute("aria-expanded", String(ui.logAll));
});

// ------------------------------------------------------------- render
function setConn(kind, feed) {
  const map = {
    online: [feed === "public" ? "Live prices" : "Live", "online"], connecting: ["Connecting", "connecting"],
    offline: ["Reconnecting", "offline"], idle: ["Not connected", ""], unreachable: ["Server unreachable", "offline"],
  };
  const [text, cls] = map[kind] || map.idle;
  $("connText").textContent = text;
  $("connDot").className = "dot " + cls;
}

function stateOf(s) {
  if (s.needsToken) return { key: "attention", label: "Needs a new token" };
  if (!s.running) return { key: "stopped", label: "Stopped" };
  if (s.halted) return { key: "halted", label: "Stopped for today" };
  return { key: "running", label: "Running" };
}

/** One short line under Start: what the bot does now, or what it waits for. */
function detailText(s) {
  const auto = s.mode === "auto", a = s.scanAuto || {};
  if (s.needsToken) return "Deriv did not accept the token. Add a new one under Deriv connection.";
  if (!s.running) {
    if (auto && !s.hasToken) return "Add your Deriv token in Settings, then press Start.";
    if (auto && s.scanAutoBlocked) return "Auto trade is demo only. Switch to a demo account, or use Signals only.";
    return auto ? "Press Start to trade the scanner's ready setups on your demo account." : "Signals only: the scanner shows setups. Nothing is traded.";
  }
  if (s.halted) return `Daily loss limit hit (${s.haltReason}). It carries on tomorrow (UTC).`;
  if (auto && s.scanAutoBlocked) return "Auto trade is demo only, so nothing is traded on this REAL account.";
  let t = auto ? "Trading the scanner's ready setups (demo)." : "Signals only: nothing is traded.";
  if (s.resumedAt && Date.now() - s.resumedAt < 12 * 3600e3) t += ` Carried on by itself after a restart at ${when(s.resumedAt)}.`;
  if (s.connection !== "online") t += " Reconnecting to Deriv.";
  else if (auto && s.syncing) t += " Checking your open trades.";
  else if (auto && a.waiting && !/busy/.test(a.waiting)) t += ` Waiting: ${a.waiting}.`;
  return t;
}

function render(s) {
  ui.status = s;
  setConn(s.connection, s.feed);
  const cur = s.currency;

  // notices
  $("realBanner").hidden = s.account?.type !== "real";
  let notice = "", noticeBtn = false, noticeKind = "warn";
  if (s.needsToken) { notice = s.error; noticeBtn = true; }
  else if (s.error) notice = s.error;
  else if (!s.hasToken) { notice = "Add your Deriv token so the bot can trade on your account."; noticeBtn = true; noticeKind = "info"; }
  $("notice").hidden = !notice;
  $("notice").className = `notice ${noticeKind}`;
  $("noticeText").textContent = notice;
  $("noticeBtn").hidden = !noticeBtn;

  // hero
  const st = stateOf(s);
  $("statePill").className = `state ${st.key}`;
  $("stateLabel").textContent = st.label;
  if (ui.stateKey && ui.stateKey !== st.key) announce(`Bot status: ${st.label}`);
  ui.stateKey = st.key;
  const badge = $("acctBadge");
  badge.textContent = s.account ? (s.account.type === "real" ? "Real" : "Demo") : s.feed === "public" ? "Prices only" : "No account";
  badge.className = "badge" + (s.account ? ` ${s.account.type}` : "");
  badge.title = s.account ? s.account.id : "";
  $("balance").textContent = money(s.balance, cur);
  // Deriv takes the stake out of the balance while a trade is open, so say where that money is.
  const inTrades = s.open.length && Number.isFinite(s.equity) && Number.isFinite(s.balance) ? s.equity - s.balance : null;
  $("inTrades").hidden = inTrades === null;
  if (inTrades !== null) $("inTrades").textContent = `Plus ${money(inTrades, cur)} in open trades`;
  const pl = $("dayPL");
  pl.textContent = Number.isFinite(s.dayPL) ? `${s.dayPL > 0 ? "+" : ""}${s.dayPL.toFixed(2)}%` : "–";
  pl.className = s.dayPL > 0 ? "pos" : s.dayPL < 0 ? "neg" : "";
  $("tradesToday").textContent = s.account ? `${s.tradesToday} / ${s.limits.maxTradesPerDay}` : "–";
  $("openCount").textContent = String(s.open.length);
  $("stateDetail").textContent = detailText(s);
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;

  const run = $("runBtn");
  run.textContent = s.running ? "Stop the bot" : "Start the bot";
  run.className = `btn run-btn ${s.running ? "stop" : "start"}`;

  renderTrades(s);
  renderSettings(s);
  renderScanAuto();
  renderChart(s);
}

/**
 * The live chart (chart.js) is loaded once the control page shows, so the login screen stays
 * small. If it can't load, the rest of the page works without it. Until a setup or trade is
 * tapped, it shows the first open trade's market, else the top scanner setup's.
 */
function renderChart(s) {
  if (!ui.chart) {
    ui.chart = import("./chart.js").then((m) => m.mountChart()).catch(() => {
      $("chartCard").hidden = false;
      $("chartEmpty").textContent = "The chart couldn't load. Reload the page to try again.";
      $("chartEmpty").hidden = false;
      return null;
    });
  }
  ui.chart.then((c) => {
    if (!c || ui.status !== s) return;
    c.update(s);
    if (!ui.picked) autoChart(c, s);
  });
}

/** The chart's view of an open trade: its market, the timeframe it was found on, its plan. */
function tradeFocus(t) {
  const sc = t.scan || {};
  const tf = sc.tf || ([60, 300, 900, 3600].includes(t.barSec) ? t.barSec : 900);
  return { id: `trade:${t.id}`, tradeId: t.id, symbol: t.symbol, tf, side: t.side, name: sc.name || t.name || t.symbol, strategy: sc.strategy, status: "traded" };
}

/** The default chart: the first open trade's market, else the top scanner setup. Only a change of market moves it. */
function autoChart(c, s = ui.status) {
  const t = (s?.open || []).find((x) => x.symbol);
  const it = ui.scan?.items?.[0];
  const pick = t ? tradeFocus(t) : it || null;
  const key = pick ? `${pick.symbol}` : "";
  if (key === ui.chartKey) return;
  ui.chartKey = key;
  c.focus(pick);
}

/** A tapped setup or trade: the chart shows it until another one is tapped. */
function pickChart(item, scroll) {
  if (!ui.chart) return;
  ui.chart.then((c) => {
    if (!c) return;
    ui.picked = true;
    ui.chartKey = item.symbol;
    c.focus(item);
    if (scroll) $("chartCard").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    announce(`Chart shows ${item.name}${item.side ? ` with the ${item.side} ${item.status === "traded" ? "trade" : "setup"}` : ""}.`);
  });
}

function renderTrades(s) {
  const list = $("openList");
  const keep = new Set(s.open.map((t) => t.id));
  for (const li of [...list.children]) if (!keep.has(li.dataset.id)) li.remove();
  for (const t of s.open) {
    let li = list.querySelector(`li[data-id="${CSS.escape(t.id)}"]`);
    if (!li) {
      li = el("li", "trade");
      li.dataset.id = t.id;
      const btn = el("button", "btn small", "Close");
      btn.type = "button";
      btn.dataset.close = t.id;
      btn.setAttribute("aria-label", `Close trade ${t.id}`);
      const btns = el("div", "trade-btns");
      btns.append(btn);
      if (t.symbol) {   // each trade is on its own market: its plan is drawn on that market's chart
        const show = el("button", "btn small", "Chart");
        show.type = "button";
        show.dataset.chart = t.id;
        show.setAttribute("aria-label", `Show trade ${t.id} on the chart`);
        btns.append(show);
      }
      li.append(el("span", "tag"), el("div", "title"), el("span", "profit"), el("div", "sub"), btns);
      list.append(li);
    }
    li.children[0].className = `tag ${t.side}`;
    li.children[0].textContent = t.side === "?" ? "…" : t.side;
    li.querySelector(".title").textContent = `Stake ${Number.isFinite(t.stake) ? nf2.format(t.stake) : "–"}`;
    const bits = [t.name || t.symbol || "Unknown market"];
    if (t.opened) bits.push(`opened ${when(t.opened)}`);
    if (t.horizon) { const min = Math.round((t.horizon * (t.barSec || 60)) / 60); bits.push(`closes after ${min < 120 || min % 60 ? `${min} min` : `${min / 60} hours`}`); }
    if (t.closing) bits.push("closing");
    const sub = li.querySelector(".sub");
    if (t.source === "scanner") {
      // "from Scanner · ICT 15m EUR/USD"
      const sc = t.scan || {};
      bits[0] = el("span", "from", `from Scanner · ${[strategyName(sc.strategy), TF_SHORT[sc.tf] || "", sc.name || t.symbol].filter(Boolean).join(" ")}`);
      sub.replaceChildren(...bits.flatMap((b, k) => (k ? [" · ", b] : [b])));
    } else sub.textContent = bits.join(" · ");
    const p = li.querySelector(".profit");
    p.textContent = signed(t.profit, s.currency);
    p.className = `profit ${t.profit > 0 ? "pos" : t.profit < 0 ? "neg" : ""}`;
  }
  $("openEmpty").hidden = s.open.length > 0;
  $("closeAllBtn").hidden = s.open.length < 2;
}

// ------------------------------------------------------------- scanner
const STRATEGY_NAME = { ict: "ICT", smc: "SMC", ai: "AI model" };
/** A strategy's name; one that was removed (an old trade's "rules") just gets a capital letter. */
const strategyName = (k) => STRATEGY_NAME[k] || (k ? `${String(k).charAt(0).toUpperCase()}${String(k).slice(1)}` : "");
const TF_SHORT = { 900: "15m", 3600: "1h" };

/** The scanner's list, asked for every 15 seconds (every 3 while it is scanning) and after a change. */
async function pullScanner(force = false) {
  if (!force && Date.now() - ui.scanAt < (ui.scan?.scanning ? SCAN_BUSY_MS : SCAN_POLL_MS)) { if (ui.scan) renderScanAges(); return; }
  ui.scanAt = Date.now();
  const r = await api("GET", "/api/scanner");
  if (r.ok) showScanner(r.data);
}

function showScanner(d) {
  ui.scan = d;
  ui.scanSkew = Date.now() - d.now;   // the server's clock, for "12 min ago"
  renderScanner();
}

/** "just now", "12 min ago", "3 h ago", by the server's clock. */
function ago(ms) {
  const min = Math.floor((Date.now() - ui.scanSkew - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return when(ms);
}
const inMin = (ms) => Math.max(1, Math.ceil((ms - (Date.now() - ui.scanSkew)) / 60000));

/**
 * A short setup card: side, market, timeframe, age; then status and entry, stop and target on one
 * line. Tapping it shows it on the chart and opens its reason (and what agrees) underneath.
 */
function scanItem(it) {
  const li = el("li", "scan-li");
  const open = ui.focusId === it.id;
  const b = el("button", `scan-item ${it.status}`);
  b.type = "button";
  b.dataset.id = it.id;
  b.setAttribute("aria-pressed", String(open));
  b.setAttribute("aria-expanded", String(open));
  const head = el("span", "scan-head");
  head.append(el("span", `tag ${it.side}`, it.side), el("span", "scan-name", it.name), el("span", "scan-tf", TF_SHORT[it.tf] || ""));
  const age = el("span", "scan-age", ago(it.at));
  age.dataset.at = it.at;
  head.append(age);
  const line = el("span", "scan-line");
  const num = (label, v, cls) => { const x = el("span", `scan-num ${cls}`); x.append(el("span", "k", label), el("span", "v", v)); return x; };
  line.append(el("span", `scan-pill ${it.status}`, it.status === "ready" ? "Ready" : it.inZone ? "In zone" : "Waiting"),
              num(it.status === "waiting" ? "Zone" : "Entry", it.status === "waiting" && it.zone ? `${px(it.zone[0])}–${px(it.zone[1])}` : px(it.entry), "entry"),
              num("SL", px(it.sl), "sl"), num("TP", px(it.tp), "tp"));
  if (it.traded) line.append(el("span", "scan-traded", "Traded"));
  b.append(head, line);
  b.setAttribute("aria-label", `${it.side} ${it.name}, ${strategyName(it.strategy)} on ${TF_SHORT[it.tf]}, ${it.status === "ready" ? "ready now" : "waiting for price"}${it.traded ? ", traded by auto trade" : ""}, ` +
                               `entry ${px(it.entry)}, stop loss ${px(it.sl)}, take profit ${px(it.tp)}. Show on the chart and the reason.`);
  li.append(b);
  if (open) {
    const more = el("div", "scan-more");
    more.append(el("p", "scan-reason", `${strategyName(it.strategy)} · ${Number.isFinite(it.rr) ? `reward ${it.rr.toFixed(1)} : 1 risk` : ""}`.replace(/ · $/, "")),
                el("p", "scan-reason", it.reason));
    if (it.agree?.length) more.append(el("p", "scan-agree yes", `Agrees: ${it.agree.join(" · ")}`));
    if (it.against?.length) more.append(el("p", "scan-agree no", `Against: ${it.against.join(" · ")}`));
    const go = el("button", "btn small ghost", "See the chart");
    go.type = "button";
    go.dataset.goChart = "1";
    more.append(go);
    li.append(more);
  }
  return li;
}

function renderScanAges() { for (const a of document.querySelectorAll("#scanList .scan-age")) a.textContent = ago(Number(a.dataset.at)); }

function renderScanner() {
  const d = ui.scan;
  if (!d) return;
  const items = d.items || [];
  $("scanWhen").textContent = d.lastScanAt ? `Checked ${ago(d.lastScanAt)}` : "";
  const total = d.progress?.total || 0, done = d.progress?.done || 0;
  $("scanProgress").hidden = !d.scanning;
  if (d.scanning) {
    $("scanMeter").value = total ? Math.round((100 * done) / total) : 0;
    $("scanProgressText").textContent = `Scanning ${done} of ${total} charts`;
  }
  setMsg("scanMsg", d.message);
  const sig = JSON.stringify([items.map((i) => [i.id, i.status, i.inZone, i.agree, i.against, i.traded]), ui.focusId]);
  if (sig !== ui.scanSig) { ui.scanSig = sig; $("scanList").replaceChildren(...items.map(scanItem)); }
  else renderScanAges();
  $("scanEmpty").hidden = items.length > 0 || !!d.message;
  $("scanEmpty").textContent = d.scanning && !d.lastScanAt ? "Scanning. The first setups show in a minute or two."
    : `No setups on the ${d.markets} market${d.markets === 1 ? "" : "s"} watched. Next check${d.nextScanAt ? ` in ${inMin(d.nextScanAt)} min` : " after the next candle"}.`;
  const btn = $("scanBtn");
  btn.disabled = !d.settings.on || !!d.cooldownUntil || d.scanning;
  btn.textContent = !d.settings.on ? "Scanner is off" : d.scanning ? "Scanning…" : d.cooldownUntil ? `Scan again in ${inMin(d.cooldownUntil)} min` : "Scan now";
  // settings
  const set = d.settings;
  const strategies = set.strategies || [];
  $("sumScanner").textContent = `${set.timeframes.map((t) => TF_SHORT[t]).join(", ")} · ${strategies.map((k) => STRATEGY_SHORT[k]).join(", ")}${set.synthetics ? " · synthetics" : ""}`;
  renderScanAuto();
  if (!ui.scanSaving) {
    $("scanSynth").checked = set.synthetics;
    for (const c of document.querySelectorAll('#scanTfSeg input[name="tf"]')) c.checked = set.timeframes.includes(Number(c.value));
    for (const c of document.querySelectorAll('#scanStratSeg input[name="strategy"]')) c.checked = strategies.includes(c.value);
  }
  const ai = document.querySelector('#scanStratSeg input[value="ai"]');
  ai.disabled = !d.modelLoaded && !strategies.includes("ai");
  if (!ui.picked && ui.chart) ui.chart.then((c) => c && autoChart(c));
}
const STRATEGY_SHORT = { ict: "ICT", smc: "SMC", ai: "AI" };

$("scanBtn").addEventListener("click", () => busy($("scanBtn"), async () => {
  const r = await api("POST", "/api/scanner/scan", {});
  if (r.ok) { showScanner(r.data); ui.scanAt = Date.now(); toast("Scanning the markets now."); }
  else if (r.status !== 401) { toast(r.data.message || "That didn't work."); pullScanner(true); }
}).then(() => { if (ui.scan) renderScanner(); }));

$("scanList").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-go-chart]")) {
    $("chartCard").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    return;
  }
  const b = ev.target.closest(".scan-item");
  const it = b && ui.scan?.items.find((i) => i.id === b.dataset.id);
  if (!it) return;
  if (ui.focusId === it.id) { ui.focusId = null; renderScanner(); return; }   // tapped again: folds
  ui.focusId = it.id;
  renderScanner();
  $("scanList").querySelector(`.scan-item[data-id="${CSS.escape(it.id)}"]`)?.focus();
  pickChart(it, false);
});

$("scanForm").addEventListener("submit", (ev) => ev.preventDefault());
$("scanForm").addEventListener("change", async () => {
  const tfs = [...document.querySelectorAll('#scanTfSeg input[name="tf"]:checked')].map((c) => Number(c.value));
  const strategies = [...document.querySelectorAll('#scanStratSeg input[name="strategy"]:checked')].map((c) => c.value);
  if (!tfs.length) { setMsg("scanSetMsg", "Pick at least one timeframe.", "error"); if (ui.scan) renderScanner(); return; }
  if (!strategies.length) { setMsg("scanSetMsg", "Pick at least one strategy.", "error"); if (ui.scan) renderScanner(); return; }
  ui.scanSaving = true;
  try {
    const r = await api("POST", "/api/scanner/settings", { synthetics: $("scanSynth").checked, timeframes: tfs, strategies });
    if (r.ok) { setMsg("scanSetMsg", "Saved. The scanner checks the markets again shortly.", "ok"); showScanner(r.data); ui.scanAt = 0; }
    else setMsg("scanSetMsg", r.data.message || "Couldn't save that.", "error");
  } finally { ui.scanSaving = false; if (ui.scan) renderScanner(); }
});

/** The mode line on the Scanner card: "Auto trade (demo) · 2 of 4 today", and why it isn't trading now. */
function renderScanAuto() {
  const a = ui.status?.scanAuto || ui.scan?.auto;
  const box = $("scanAuto");
  box.hidden = !a;
  if (!a) return;
  const s = ui.status;
  let state, why = "", cls = "scan-auto";
  if (!a.on) state = "Signals only: setups are shown, not traded";
  else if (a.blocked) { state = "Auto trade: this is a REAL account"; why = "It is demo only, so nothing is traded here."; cls += " real"; }
  else {
    state = `Auto trade (demo) · ${a.today} of ${a.maxDay} today`;
    cls += " on";
    if (a.open) state += ` · ${a.open} open`;
    if (s && !s.running) why = "It takes setups once you press Start.";
    else if (a.waiting && !/busy/.test(a.waiting)) why = `Not taking setups now: ${a.waiting}.`;
  }
  box.className = cls;
  $("scanAutoState").textContent = state;
  $("scanAutoWhy").textContent = why;
}

// ------------------------------------------------------------- settings
const RISK_FIELDS = ["riskPct", "maxDailyLossPct", "scanAutoMaxDay", "scanAutoMaxOpen", "maxConsecLosses", "cooldownMinutes"];

function renderSettings(s) {
  const set = s.settings;
  // summaries
  $("sumDeriv").textContent = s.needsToken ? "Token not accepted" : s.hasToken ? "Connected" : "Not connected";
  $("sumAccount").textContent = s.account ? `${s.account.type === "real" ? "REAL" : "Demo"} · ${s.account.id}` : "None";
  $("sumRisk").textContent = `${set.riskPct}% a trade · ${set.maxDailyLossPct}% a day · ${set.scanAutoMaxDay} a day`;
  $("sumVersion").textContent = s.version?.commit ? s.version.commit.slice(0, 7) : "";
  if (s.version?.commit && !$("versionText").dataset.set) {
    $("versionText").textContent = `You have version ${s.version.commit.slice(0, 7)}${s.version.date ? ` from ${new Date(s.version.date).toLocaleDateString()}` : ""}.`;
  }

  // Deriv connection
  if (!ui.dirty.has("derivForm")) $("appIdInput").value = s.appId || "";
  $("tokenInput").placeholder = s.hasToken ? `Saved (ends in ${s.tokenHint})` : "Paste your token here";
  $("tokenHelp").textContent = s.hasToken ? "To replace the saved token, paste a new one. Kept only on this server, never shown again."
                                          : "Kept only on this server, in a private file. It is never shown again.";
  $("derivForget").hidden = !s.hasToken;

  // accounts
  const list = $("accountList");
  const accounts = s.accounts || [];
  $("accountEmpty").hidden = accounts.length > 0;
  $("accountRefresh").hidden = !s.hasToken;
  const sig = JSON.stringify([accounts, s.account?.id, set.allowReal]);
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    const legend = list.querySelector("legend");
    list.replaceChildren(legend);
    for (const a of accounts) {
      const lab = el("label", "choice");
      const input = el("input");
      input.type = "radio"; input.name = "account"; input.value = a.id;
      input.checked = a.id === s.account?.id;
      input.disabled = a.type === "real" && !set.allowReal;
      if (input.checked) lab.classList.add("checked");
      if (input.disabled) lab.classList.add("disabled");
      const main = el("span", "choice-main");
      main.append(el("span", "choice-id", a.id),
                  el("span", "choice-sub", `${a.currency}${Number.isFinite(a.balance) ? ` · ${money(a.balance, a.currency)}` : ""}${input.disabled ? " · allow real money first" : ""}`));
      lab.append(input, main, el("span", `badge ${a.type}`, a.type === "real" ? "Real" : "Demo"));
      list.append(lab);
    }
  }

  // risk
  if (!ui.dirty.has("riskForm")) {
    const f = $("riskForm").elements;
    for (const k of RISK_FIELDS) f[k].value = set[k];
  }

  // real money
  $("realOff").hidden = set.allowReal;
  $("realOn").hidden = !set.allowReal;
}

// ------------------------------------------------------------- actions
function wireDirty(formId) {
  const f = $(formId);
  f.addEventListener("input", () => ui.dirty.add(formId));
  f.addEventListener("change", () => ui.dirty.add(formId));
}
["derivForm", "riskForm"].forEach(wireDirty);
for (const d of document.querySelectorAll("details.set")) {
  d.addEventListener("toggle", () => {
    if (d.open) return;
    for (const f of d.querySelectorAll("form")) ui.dirty.delete(f.id);
    if (ui.status) renderSettings(ui.status);
  });
}
function openSection(id) {
  const d = $(id);
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "start" });
  d.querySelector("summary").focus({ preventScroll: true });
}

async function saveSettings(partial, msgId) {
  const r = await api("POST", "/api/settings", partial);
  if (r.ok) {
    if (msgId) setMsg(msgId, "Saved.", "ok");
    if (r.data.status) render(r.data.status);
  } else if (msgId) setMsg(msgId, r.data.message || "Couldn't save that.", "error");
  return r;
}

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pw = $("loginPassword").value;
  if (!pw) { $("loginMsg").textContent = "Type your password."; $("loginMsg").hidden = false; return; }
  await busy($("loginBtn"), async () => {
    const r = await api("POST", "/api/login", { password: pw });
    if (r.ok) {
      $("loginPassword").value = "";
      $("loginMsg").hidden = true;
      ui.screen = "loading";
      await refresh();
    } else {
      $("loginMsg").textContent = r.data.message || "That didn't work. Please try again.";
      $("loginMsg").hidden = false;
      $("loginPassword").select();
    }
  });
});

$("retryBtn").addEventListener("click", refresh);
$("noticeBtn").addEventListener("click", () => openSection("secDeriv"));

$("runBtn").addEventListener("click", () => busy($("runBtn"), async () => {
  const s = ui.status;
  if (!s) return;
  const r = await api("POST", s.running ? "/api/stop" : "/api/start", {});
  if (r.ok) { render(r.data); toast(r.data.running ? "The bot is running." : "The bot is stopped. Open trades keep their stop loss and take profit."); await pullLog(); }
  else if (r.status !== 401) toast(r.data.message || "That didn't work.");
}));

$("openList").addEventListener("click", (ev) => {
  const show = ev.target.closest("[data-chart]");
  const t = show && ui.status?.open.find((x) => x.id === show.dataset.chart);
  if (t) {
    // The trade's market and timeframe, with its plan (drawn from the status like every open trade).
    ui.focusId = null;
    if (ui.scan) renderScanner();
    pickChart(tradeFocus(t), true);
    return;
  }
  const btn = ev.target.closest("[data-close]");
  if (!btn) return;
  if (!confirm("Close this trade now at the current price?")) return;
  busy(btn, async () => {
    const r = await api("POST", "/api/close", { id: btn.dataset.close });
    toast(r.ok ? "Closing the trade." : r.data.message || "Couldn't close the trade.");
    await refresh();
  });
});

$("closeAllBtn").addEventListener("click", () => {
  if (!confirm("Close all open trades now at the current price?")) return;
  busy($("closeAllBtn"), async () => {
    const r = await api("POST", "/api/close-all", {});
    toast(r.ok ? "Closing all trades." : r.data.message || "Some trades didn't close. Please try again.");
    await refresh();
  });
});

$("derivForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const appId = $("appIdInput").value.trim(), token = $("tokenInput").value.trim();
  if (!appId) return setMsg("derivMsg", "Paste your App ID first.", "error");
  if (!token) return setMsg("derivMsg", ui.status?.hasToken ? "Paste a new token to replace the saved one." : "Paste your token first.", "error");
  busy($("derivSave"), async () => {
    setMsg("derivMsg", "Checking with Deriv…");
    const r = await api("POST", "/api/deriv", { appId, token });
    if (r.ok) {
      $("tokenInput").value = "";
      ui.dirty.delete("derivForm");
      const a = r.data.account;
      setMsg("derivMsg", `Connected. ${a ? `Using ${a.type === "real" ? "REAL" : "demo"} account ${a.id}.` : "No demo account was found."}`, "ok");
      await refresh();
    } else setMsg("derivMsg", r.data.message || "That didn't work.", "error");
  });
});

$("derivForget").addEventListener("click", () => {
  if (!confirm("Remove the Deriv token from this server? The bot stops. Open trades keep their stop loss and take profit.")) return;
  busy($("derivForget"), async () => {
    const r = await api("POST", "/api/deriv/forget", {});
    setMsg("derivMsg", r.ok ? "The token was removed." : r.data.message || "That didn't work.", r.ok ? "ok" : "error");
    await refresh();
  });
});

$("accountList").addEventListener("change", async (ev) => {
  const input = ev.target.closest('input[name="account"]');
  if (!input) return;
  const s = ui.status;
  const a = (s.accounts || []).find((x) => x.id === input.value);
  if (a?.type === "real" && !confirm(`Switch to the REAL money account ${a.id}? The bot stops, and you press Start again when ready.`)) {
    $("accountList").dataset.sig = ""; renderSettings(s); return;
  }
  if (s.running && !confirm("Switching accounts stops the bot. Continue?")) { $("accountList").dataset.sig = ""; renderSettings(s); return; }
  const r = await api("POST", "/api/account", { id: input.value });
  setMsg("accountMsg", r.ok ? `Now using ${r.data.account.type === "real" ? "REAL" : "demo"} account ${r.data.account.id}.` : r.data.message || "That didn't work.", r.ok ? "ok" : "error");
  await refresh();
});

$("accountRefresh").addEventListener("click", () => busy($("accountRefresh"), async () => {
  const r = await api("GET", "/api/accounts?refresh=1");
  setMsg("accountMsg", r.ok ? `Found ${r.data.accounts.length} account${r.data.accounts.length === 1 ? "" : "s"}.` : r.data.message || "That didn't work.", r.ok ? "ok" : "error");
  await refresh();
}));

$("modeSeg").addEventListener("change", async (ev) => {
  const mode = ev.target.value;
  const r = await saveSettings({ mode });
  if (r.ok) toast(mode === "auto" ? "Auto trade: the scanner's ready setups are traded on demo while the bot runs." : "Signals only: nothing new is traded.");
  else { toast(r.data.message || "Couldn't switch the mode."); if (ui.status) render(ui.status); }
});

$("riskForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const partial = {};
  for (const k of RISK_FIELDS) partial[k] = f[k].value === "" ? NaN : Number(f[k].value);
  if (Object.values(partial).some((v) => !Number.isFinite(v))) return setMsg("riskMsg", "Please fill in every box with a number.", "error");
  busy(ev.submitter || f[f.length - 1], async () => {
    const r = await saveSettings(partial, "riskMsg");
    if (r.ok) {
      ui.dirty.delete("riskForm");
      renderSettings(r.data.status);
      const changed = RISK_FIELDS.some((k) => r.data.settings[k] !== partial[k]);
      if (changed) setMsg("riskMsg", "Saved. Some numbers were outside the safe range, so they were adjusted.", "ok");
    }
  });
});

$("realForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const typed = $("realConfirm").value.trim();
  if (typed !== "REAL") return setMsg("realMsg", "Type REAL in capital letters to allow real money.", "error");
  busy($("realOnBtn"), async () => {
    const r = await saveSettings({ allowReal: true, confirmReal: typed });
    $("realConfirm").value = "";
    setMsg("realMsg", r.ok ? "Real accounts can be picked above. Auto trade still refuses them." : r.data.message || "That didn't work.", r.ok ? "" : "error");
  });
});

$("realOffBtn").addEventListener("click", () => busy($("realOffBtn"), async () => {
  const r = await saveSettings({ allowReal: false });
  setMsg("realMsg", r.ok ? "Real money is off. The bot uses your demo account." : r.data.message || "That didn't work.", r.ok ? "ok" : "error");
  await refresh();
}));

$("passwordForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  if (f.next.value.length < 10) return setMsg("passwordMsg", "The new password must be at least 10 characters.", "error");
  if (f.next.value !== f.again.value) return setMsg("passwordMsg", "The two new passwords are not the same.", "error");
  busy(ev.submitter || f[f.length - 1], async () => {
    const r = await api("POST", "/api/password", { current: f.current.value, next: f.next.value });
    if (r.ok) { ev.target.reset(); setMsg("passwordMsg", "Password changed. Other devices were logged out.", "ok"); }
    else setMsg("passwordMsg", r.data.message || "That didn't work.", "error");
  });
});

$("updateCheck").addEventListener("click", () => busy($("updateCheck"), async () => {
  setMsg("updateMsg", "Checking…");
  const r = await api("GET", "/api/update");
  if (!r.ok) { setMsg("updateMsg", r.data.message || "Couldn't check for updates.", "error"); return; }
  const d = r.data;
  if (d.commit) {
    $("versionText").dataset.set = "1";
    $("versionText").textContent = `You have version ${d.commit.slice(0, 7)}${d.date ? ` from ${new Date(d.date).toLocaleDateString()}` : ""}.`;
  }
  setMsg("updateMsg", d.message, d.ahead ? "ok" : d.checked === false ? "error" : "");
  $("updateNow").hidden = !d.ahead;
}));

$("updateNow").addEventListener("click", () => {
  if (!confirm("Update the bot now? It restarts and carries on by itself.")) return;
  busy($("updateNow"), async () => {
    setMsg("updateMsg", "Updating…");
    const r = await api("POST", "/api/update", {});
    if (!r.ok) { setMsg("updateMsg", r.data.message || "The update didn't work.", "error"); return; }
    setMsg("updateMsg", r.data.message, "ok");
    if (r.data.updated) { ui.restart = { at: Date.now(), down: false }; $("updateNow").hidden = true; schedule(1500); }
  });
});

$("logoutBtn").addEventListener("click", () => busy($("logoutBtn"), async () => {
  await api("POST", "/api/logout", {});
  show("login");
}));

// ------------------------------------------------------------- start
refresh();
