// Tbot server control page. Talks only to this server's /api. Polls every 3 seconds while
// the page is visible and pauses while it is hidden. No inline scripts (strict CSP).
const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
const SCAN_POLL_MS = 15000, SCAN_BUSY_MS = 3000;   // the scanner list is asked for less often than the status
const ui = { screen: "loading", status: null, lastSeq: 0, stateKey: null, timer: null, dirty: new Set(), restart: null, chart: null,
             scan: null, scanAt: 0, scanSkew: 0, scanSig: "", scanSaving: false, focusId: null };

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
}

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

const TF_WORD = { 60: "1-minute", 900: "15-minute", 3600: "1-hour" };
const stratName = (s) => (s.strategy === "ai" ? (s.fast ? "AI model · Fast" : "AI model") : s.strategy === "ict" ? "ICT" : "Rules");

function detailText(s) {
  const strat = s.strategy === "ai" ? (s.fast ? "the AI model in fast mode" : "the AI model") : s.strategy === "ict" ? "the ICT strategy" : "the rules strategy";
  if (s.needsToken) return "Deriv did not accept the token, so the bot stopped. Add a new token under Deriv connection.";
  if (!s.running) {
    if (s.mode === "auto" && !s.hasToken) return "Add your Deriv token in Settings, then press Start.";
    return s.mode === "auto" ? `Press Start to auto trade ${s.symbolName} with ${strat}.`
                             : `Press Start to watch ${s.symbolName} for signals. Nothing will be traded.`;
  }
  if (s.fastBlocked && s.mode === "auto") return "Fast mode is demo only, so the bot places no trades on this REAL account. Switch to a demo account or turn fast mode off.";
  if (s.ictBlocked) return "ICT is demo only for auto trade, so the bot places no trades on this REAL account. Switch to a demo account or use Signals only.";
  if (s.halted) return `The daily loss limit was hit (${s.haltReason}). The bot carries on tomorrow (UTC). Press Stop to stop it fully.`;
  let t = s.mode === "auto" ? `Auto trading ${s.symbolName} with ${strat}.` : `Watching ${s.symbolName} for signals with ${strat}. Nothing is traded.`;
  if (s.resumedAt && Date.now() - s.resumedAt < 12 * 3600e3) t += ` It carried on by itself after a server restart at ${when(s.resumedAt)}.`;
  if (s.marketOpen === false) t += ` ${s.symbolName} is closed now, so nothing is traded until it opens.`;
  else if (s.pending) t += " A setup has formed: waiting for price to come back to the entry zone.";
  if (s.connection !== "online") t += " Reconnecting to Deriv.";
  else if (s.syncing && s.mode === "auto") t += " Checking your open trades.";
  else if (s.blockReason) t += ` Waiting: ${s.blockReason}.`;
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

  const run = $("runBtn");
  run.textContent = s.running ? "Stop the bot" : s.mode === "auto" ? "Start the bot" : "Start signals";
  run.className = `btn run-btn ${s.running ? "stop" : "start"}`;

  renderTrades(s);
  renderSignal(s);
  renderSettings(s);
  renderChart(s);
}

/**
 * The live chart (chart.js) is loaded once the control page shows, so the login screen stays
 * small. If it can't load, the rest of the page works without it.
 */
function renderChart(s) {
  $("chartPrice").textContent = Number.isFinite(s.lastPrice) ? px(s.lastPrice) : "";
  if (!ui.chart) {
    ui.chart = import("./chart.js").then((m) => m.mountChart()).catch(() => {
      $("chartCard").hidden = false;
      $("chartEmpty").textContent = "The chart couldn't load. Reload the page to try again.";
      $("chartEmpty").hidden = false;
      return null;
    });
  }
  ui.chart.then((c) => { if (c && ui.status === s) c.update(s); });
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
      li.append(el("span", "tag"), el("div", "title"), el("span", "profit"), el("div", "sub"), btn);
      list.append(li);
    }
    li.children[0].className = `tag ${t.side}`;
    li.children[0].textContent = t.side === "?" ? "…" : t.side;
    li.querySelector(".title").textContent = `Stake ${Number.isFinite(t.stake) ? nf2.format(t.stake) : "–"}`;
    const bits = [t.symbol || s.symbol];
    if (t.opened) bits.push(`opened ${when(t.opened)}`);
    if (t.horizon) bits.push(`closes after ${t.horizon} min`);
    if (t.closing) bits.push("closing");
    li.querySelector(".sub").textContent = bits.join(" · ");
    const p = li.querySelector(".profit");
    p.textContent = signed(t.profit, s.currency);
    p.className = `profit ${t.profit > 0 ? "pos" : t.profit < 0 ? "neg" : ""}`;
  }
  $("openEmpty").hidden = s.open.length > 0;
  $("closeAllBtn").hidden = s.open.length < 2;
  $("multInfo").textContent = s.account ? `Multiplier x${s.multiplierInUse}` : "";
}

function renderSignal(s) {
  const box = $("signalBox");
  const sig = s.lastSignal;
  if (!sig) {
    box.replaceChildren(el("p", "empty", s.running ? `No signal yet. The bot checks after every ${TF_WORD[s.botTf] || "1-minute"} candle.` : "No signal yet."));
  } else {
    const wrap = el("div", "signal");
    wrap.append(el("span", `tag ${sig.action}`, sig.action),
                el("span", "title", `${sig.symbol} at ${px(sig.entry)}${sig.traded ? " · traded" : " · signal only"}${sig.fromPending ? " · price reached the zone" : ""}`),
                el("span", "sub", `Stop loss ${px(sig.sl)} · take profit ${px(sig.tp)} · ${sig.sizeText}`),
                el("span", "sub", `${sig.reason} · ${when(sig.at)}`));
    box.replaceChildren(wrap);
  }
  $("priceText").textContent = Number.isFinite(s.lastPrice) ? `Price ${px(s.lastPrice)}` : "";
  $("seesText").textContent = s.lastEval?.sees || (s.connection === "online" ? "Loading price history" : "Waiting for prices");
  $("seesTime").textContent = s.lastEval ? `Checked at ${when(s.lastEval.at)} · ${stratName(s)} · ${TF_WORD[s.botTf] || "1-minute"} candles` : "";
  // the waiting plan, as text
  const p = s.pending;
  $("pendingBox").hidden = !p;
  if (p) {
    $("pendingSide").textContent = p.side;
    $("pendingSide").className = `tag ${p.side}`;
    $("pendingText").textContent = p.text;
    $("pendingWhy").textContent = p.reason;
  }
  const c = s.lastCost;
  $("costText").hidden = !c;
  if (c) $("costText").textContent = `Last commission: ${money(c.commission, c.currency)} (${(c.r * 100).toFixed(1)}% of the risk). This cost is why results lean negative.`;
}

// ------------------------------------------------------------- scanner
const STRATEGY_NAME = { ict: "ICT", rules: "Rules", ai: "AI model" };
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

function scanItem(it) {
  const li = el("li");
  const b = el("button", `scan-item ${it.status}`);
  b.type = "button";
  b.dataset.id = it.id;
  b.setAttribute("aria-pressed", String(ui.focusId === it.id));
  const head = el("span", "scan-head");
  head.append(el("span", `tag ${it.side}`, it.side), el("span", "scan-name", it.name), el("span", "scan-tf", TF_SHORT[it.tf] || ""));
  const age = el("span", "scan-age", ago(it.at));
  age.dataset.at = it.at;
  head.append(age);
  const status = el("span", "scan-status");
  status.append(el("span", `scan-pill ${it.status}`, it.status === "ready" ? "Ready now" : it.inZone ? "Price in the zone" : "Waiting for price"),
                el("span", "scan-strat", STRATEGY_NAME[it.strategy] || it.strategy));
  const nums = el("span", "scan-nums");
  const num = (label, v, cls = "") => { const x = el("span", `scan-num ${cls}`.trim()); x.append(el("span", "k", label), el("span", "v", v)); return x; };
  nums.append(it.status === "waiting" && it.zone ? num("Entry zone", `${px(it.zone[0])} – ${px(it.zone[1])}`, "wide") : num("Entry", px(it.entry)),
              num("Stop loss", px(it.sl), "sl"), num("Take profit", px(it.tp), "tp"),
              num("Reward : risk", Number.isFinite(it.rr) ? `${it.rr.toFixed(1)} : 1` : "–"));
  b.append(head, status, nums, el("span", "scan-reason", it.reason));
  if (it.agree?.length || it.against?.length) {
    const ag = el("span", "scan-agree");
    if (it.agree.length) ag.append(el("span", "yes", `Agrees: ${it.agree.join(" · ")}`));
    if (it.against.length) ag.append(el("span", "no", `Against: ${it.against.join(" · ")}`));
    b.append(ag);
  }
  b.setAttribute("aria-label", `${it.side} ${it.name}, ${STRATEGY_NAME[it.strategy]} on ${TF_SHORT[it.tf]}, ${it.status === "ready" ? "ready now" : "waiting for price"}, ` +
                               `entry ${px(it.entry)}, stop loss ${px(it.sl)}, take profit ${px(it.tp)}. Show on the chart.`);
  li.append(b);
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
  const sig = JSON.stringify([items.map((i) => [i.id, i.status, i.inZone, i.agree, i.against]), ui.focusId]);
  if (sig !== ui.scanSig) { ui.scanSig = sig; $("scanList").replaceChildren(...items.map(scanItem)); }
  else renderScanAges();
  $("scanEmpty").hidden = items.length > 0 || !!d.message;
  $("scanEmpty").textContent = d.scanning && !d.lastScanAt ? "Scanning. The first setups show in a minute or two."
    : `No setups on the ${d.markets} market${d.markets === 1 ? "" : "s"} watched right now. It checks again after the next candle${d.nextScanAt ? ` (in ${inMin(d.nextScanAt)} min)` : ""}.`;
  $("scanHint").hidden = !items.length;
  const btn = $("scanBtn");
  btn.disabled = !d.settings.on || !!d.cooldownUntil || d.scanning;
  btn.textContent = !d.settings.on ? "Scanner is off" : d.scanning ? "Scanning…" : d.cooldownUntil ? `Scan again in ${inMin(d.cooldownUntil)} min` : "Scan now";
  // settings
  const set = d.settings;
  $("sumScanner").textContent = set.on ? `On · ${set.timeframes.map((t) => TF_SHORT[t]).join(", ")}${set.synthetics ? " · with synthetics" : ""}` : "Off";
  if (!ui.scanSaving) {
    $("scanOn").checked = set.on;
    $("scanSynth").checked = set.synthetics;
    for (const c of document.querySelectorAll('#scanTfSeg input[name="tf"]')) c.checked = set.timeframes.includes(Number(c.value));
  }
}

$("scanBtn").addEventListener("click", () => busy($("scanBtn"), async () => {
  const r = await api("POST", "/api/scanner/scan", {});
  if (r.ok) { showScanner(r.data); ui.scanAt = Date.now(); toast("Scanning the markets now."); }
  else if (r.status !== 401) { toast(r.data.message || "That didn't work."); pullScanner(true); }
}).then(() => { if (ui.scan) renderScanner(); }));

$("scanList").addEventListener("click", (ev) => {
  const b = ev.target.closest(".scan-item");
  const it = b && ui.scan?.items.find((i) => i.id === b.dataset.id);
  if (!it || !ui.chart) return;
  ui.chart.then((c) => {
    if (!c) return;
    ui.focusId = it.id;
    c.focus(it);
    for (const x of document.querySelectorAll("#scanList .scan-item")) x.setAttribute("aria-pressed", String(x === b));
    ui.scanSig = "";
    $("chartCard").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    announce(`Chart shows ${it.name}, ${TF_SHORT[it.tf]}, with the ${it.side} setup.`);
  });
});
$("focusBack").addEventListener("click", () => {
  ui.focusId = null;
  for (const x of document.querySelectorAll("#scanList .scan-item")) x.setAttribute("aria-pressed", "false");
});

$("scanForm").addEventListener("change", async () => {
  const tfs = [...document.querySelectorAll('#scanTfSeg input[name="tf"]:checked')].map((c) => Number(c.value));
  if (!tfs.length) { setMsg("scanSetMsg", "Pick at least one timeframe.", "error"); if (ui.scan) renderScanner(); return; }
  ui.scanSaving = true;
  try {
    const r = await api("POST", "/api/scanner/settings", { on: $("scanOn").checked, synthetics: $("scanSynth").checked, timeframes: tfs });
    if (r.ok) { setMsg("scanSetMsg", r.data.settings.on ? "Saved. The scanner checks the markets again shortly." : "Saved. The scanner is off.", "ok"); showScanner(r.data); ui.scanAt = 0; }
    else setMsg("scanSetMsg", r.data.message || "Couldn't save that.", "error");
  } finally { ui.scanSaving = false; if (ui.scan) renderScanner(); }
});

// ------------------------------------------------------------- settings
const RISK_FIELDS = ["riskPct", "maxDailyLossPct", "maxOpen", "maxTradesPerDay", "maxConsecLosses", "cooldownMinutes", "signalGap"];

function renderSettings(s) {
  const set = s.settings;
  // summaries
  $("sumDeriv").textContent = s.needsToken ? "Token not accepted" : s.hasToken ? "Connected" : "Not connected";
  $("sumAccount").textContent = s.account ? `${s.account.type === "real" ? "REAL" : "Demo"} · ${s.account.id}` : "None";
  $("sumMode").textContent = set.mode === "auto" ? "Auto trade" : "Signals only";
  $("sumMarket").textContent = `${s.symbolName} · ${stratName(s)}${s.botTf && s.botTf !== 60 ? ` · ${{ 900: "15m", 3600: "1h" }[s.botTf]}` : ""}`;
  $("sumRisk").textContent = `${set.riskPct}% per trade · ${set.maxDailyLossPct}% a day`;
  $("sumReal").textContent = set.allowReal ? "On" : "Off";
  $("sumVersion").textContent = s.version?.commit ? s.version.commit.slice(0, 7) : "";
  if (s.version?.commit && !$("versionText").dataset.set) {
    $("versionText").textContent = `You have version ${s.version.commit.slice(0, 7)}${s.version.date ? ` from ${new Date(s.version.date).toLocaleDateString()}` : ""}.`;
  }

  // Deriv connection
  if (!ui.dirty.has("derivForm")) $("appIdInput").value = s.appId || "";
  $("tokenInput").placeholder = s.hasToken ? `Saved (ends in ${s.tokenHint})` : "Paste your token here";
  $("tokenHelp").textContent = s.hasToken ? "To replace the saved token, paste a new one. Tokens are kept only on this server, in a private file, and never shown again."
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
                  el("span", "choice-sub", `${a.currency}${Number.isFinite(a.balance) ? ` · ${money(a.balance, a.currency)}` : ""}${input.disabled ? " · turn on Allow real money first" : ""}`));
      lab.append(input, main, el("span", `badge ${a.type}`, a.type === "real" ? "Real" : "Demo"));
      list.append(lab);
    }
  }

  // mode
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === set.mode;

  // market and strategy
  const sel = $("symbolSelect");
  // Deriv's market list, grouped (Synthetic indices, Forex, Commodities, Crypto...), closed ones marked
  const groups = s.marketGroups || [{ name: "Synthetic indices", items: (s.symbols || []).map(([symbol, name]) => ({ symbol, name, open: true })) }];
  const gsig = JSON.stringify(groups);
  if (sel.dataset.sig !== gsig && !ui.dirty.has("marketForm")) {
    sel.dataset.sig = gsig;
    sel.replaceChildren(...groups.map((g) => {
      const og = document.createElement("optgroup");
      og.label = g.name;
      for (const m of g.items) og.append(new Option(m.open ? m.name : `${m.name} (closed)`, m.symbol));
      return og;
    }));
  }
  $("marketClosed").hidden = s.marketOpen !== false && !s.noMultipliers;
  $("marketClosed").textContent = s.noMultipliers ? "No Multipliers on this market. The bot trades nothing here." : "Market closed. The bot doesn't trade until it opens.";
  const real = !!s.account && s.account.type !== "demo";
  $("ictRealTag").hidden = !real;
  if (!ui.dirty.has("marketForm")) {
    sel.value = set.symbol;
    for (const r of document.querySelectorAll('input[name="strategy"]')) r.checked = r.value === set.strategy;
    for (const r of document.querySelectorAll('input[name="botTf"]')) r.checked = Number(r.value) === s.botTf;
    marketHints();
    const f = $("marketForm").elements;
    f.aiThreshold.value = Math.round(set.aiThreshold * 100);
    f.aiBarrier.value = set.aiBarrier;
    f.aiHorizon.value = set.aiHorizon;
    $("aiFields").hidden = set.strategy !== "ai";
  }
  $("ictNote").hidden = !(set.strategy === "ict" && real);
  if (!$("ictNote").hidden) $("ictNote").textContent = set.mode === "auto"
    ? "ICT is demo only for auto trade. The bot never trades with it on a real money account. Signals only still works."
    : "ICT is demo only for auto trade. Signals still show on this account.";
  const aiRadio = document.querySelector('input[name="strategy"][value="ai"]');
  aiRadio.disabled = !s.modelLoaded;
  renderFast(s);

  // risk
  const ms = $("multiplierSelect");
  const msig = JSON.stringify(s.multipliers);
  if (ms.dataset.sig !== msig) {
    ms.dataset.sig = msig;
    ms.replaceChildren(new Option(`Lowest available (x${s.multipliers[0]})`, "0"), ...s.multipliers.map((m) => new Option(`x${m}`, String(m))));
  }
  if (!ui.dirty.has("riskForm")) {
    const f = $("riskForm").elements;
    for (const k of RISK_FIELDS) f[k].value = set[k];
    ms.value = s.multipliers.includes(set.multiplier) ? String(set.multiplier) : "0";
  }

  // real money
  $("realOff").hidden = set.allowReal;
  $("realOn").hidden = !set.allowReal;
}

/** Fast mode switch: shown when the saved strategy is the AI model; it can't be turned on for a real account. */
function renderFast(s) {
  const set = s.settings, real = !!s.account && s.account.type !== "demo";
  $("fastBox").hidden = set.strategy !== "ai";
  $("fastBox").classList.toggle("locked", real);
  $("fastRealTag").hidden = !real;
  const sw = $("fastInput");
  if (!ui.fastSaving) sw.checked = !!set.aiFast;
  sw.disabled = real && !set.aiFast;   // on a real account it can be turned off, not on
  const note = $("fastNote");
  note.hidden = !set.aiFast;
  if (!set.aiFast) return;
  const p = s.fastPreset || {};
  const max = set.maxTradesPerDay, loss = set.maxDailyLossPct;
  note.className = "fast-note" + (real ? " real" : "");
  note.textContent = real
    ? "Fast mode is demo only. The bot never trades with it on a real money account. Switch to a demo account or turn it off."
    : `It uses ${Math.round(p.threshold * 100)}% confidence, stop and target at ${p.barrierATR}x the average range, closes after ${p.horizonBars} min, ` +
      `and allows up to ${p.maxOpen} open trades. These replace your AI values and Max open trades while it's on. ` +
      `The daily limit of ${max} trades and the ${loss}% daily loss limit still stop it. You can raise the trade limit under Risk limits.`;
}

// ------------------------------------------------------------- actions
function wireDirty(formId) {
  const f = $(formId);
  f.addEventListener("input", () => ui.dirty.add(formId));
  f.addEventListener("change", () => ui.dirty.add(formId));
}
["derivForm", "marketForm", "riskForm"].forEach(wireDirty);
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
  if (!s.running && s.mode === "auto" && s.account?.type === "real" &&
      !confirm(`Start trading with REAL money on ${s.account.id}?\n\nNo bot can guarantee profits. Only continue if you accept losing what you risk.`)) return;
  const r = await api("POST", s.running ? "/api/stop" : "/api/start", {});
  if (r.ok) { render(r.data); toast(r.data.running ? "The bot is running." : "The bot is stopped."); await pullLog(); }
  else if (r.status !== 401) toast(r.data.message || "That didn't work.");
}));

$("openList").addEventListener("click", (ev) => {
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
  const r = await saveSettings({ mode }, "modeMsg");
  if (!r.ok && ui.status) renderSettings(ui.status);
});

$("fastInput").addEventListener("change", async (ev) => {
  const on = ev.target.checked;
  ui.fastSaving = true;
  try {
    const r = await saveSettings({ aiFast: on });
    setMsg("fastMsg", r.ok ? (on ? "Fast mode is on (demo only)." : "Fast mode is off. Your own AI values apply again.") : r.data.message || "Couldn't save that.",
           r.ok ? "ok" : "error");
    if (!r.ok) ev.target.checked = !on;
  } finally { ui.fastSaving = false; }
});

/** What the form shows now: ICT hint, AI on bigger candles, and 1h for real markets. */
function marketHints() {
  const f = $("marketForm").elements, s = ui.status;
  const strategy = f.strategy.value, tf = Number(f.botTf.value) || 60;
  $("aiFields").hidden = strategy !== "ai";
  $("ictBox").hidden = strategy !== "ict";
  $("aiTfNote").hidden = !(strategy === "ai" && tf !== 60);
  const synthetic = (s?.marketGroups || []).find((g) => g.items.some((m) => m.symbol === f.symbol.value))?.name === "Synthetic indices"
    || !s?.marketGroups;
  $("tfSuggest").hidden = synthetic || tf === 3600;
}
$("marketForm").addEventListener("change", marketHints);

$("marketForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements, s = ui.status;
  const partial = { symbol: f.symbol.value, strategy: f.strategy.value, botTf: Number(f.botTf.value) || 60,
                    aiThreshold: Number(f.aiThreshold.value) / 100, aiBarrier: Number(f.aiBarrier.value), aiHorizon: Number(f.aiHorizon.value) };
  if (s?.running && (partial.symbol !== s.settings.symbol || partial.botTf !== s.botTf) &&
      !confirm(`Changing the ${partial.symbol !== s.settings.symbol ? "market" : "timeframe"} stops the bot. Continue?`)) return;
  busy(ev.submitter || f[f.length - 1], async () => {
    const r = await saveSettings(partial, "marketMsg");
    if (r.ok) { ui.dirty.delete("marketForm"); renderSettings(r.data.status); }
  });
});

$("riskForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const partial = { multiplier: Number(f.multiplier.value) };
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
    setMsg("realMsg", r.ok ? "Real money is allowed. Pick the account under Account." : r.data.message || "That didn't work.", r.ok ? "" : "error");
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
