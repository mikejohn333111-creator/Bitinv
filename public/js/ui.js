// Page-only behaviour: bottom sheets, the header login shortcut, the account list, the signal card's
// age, the activity filter and "show all", the Close button's "Closing…" state and the risk summary
// (including fast mode's open-trade limit). No trading logic lives here.
import { AI_FAST } from "./strategy.js";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- sheets
function openSheet(id) {
  const d = $(id);
  if (!d || d.open) return;
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  document.body.classList.add("sheet-open");
}
function closeSheet(d) {
  if (!d?.open) return;
  if (typeof d.close === "function") d.close(); else { d.removeAttribute("open"); d.dispatchEvent(new Event("close")); }
}
document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-sheet]");
  if (opener) { openSheet(opener.dataset.sheet); return; }
  const closer = e.target.closest("[data-close-sheet]");
  if (closer) closeSheet(closer.closest("dialog"));
});
document.querySelectorAll("dialog.sheet").forEach((d) => {
  d.addEventListener("close", () => {
    if (!document.querySelector("dialog.sheet[open]")) document.body.classList.remove("sheet-open");
  });
  // A tap on the dimmed area outside the sheet closes it.
  d.addEventListener("click", (e) => { if (e.target === d) closeSheet(d); });
});

// ------------------------------------------------------- header login
$("hdrLogin").addEventListener("click", () => {
  const card = $("loginCard");
  card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  const appId = $("loginAppId");
  const target = !$("loginAppIdRow").hidden && !appId.value.trim() ? appId : $("loginBtn");
  setTimeout(() => target.focus({ preventScroll: true }), 350);
});

// ------------------------------------------------------- account list
// The visible list drives the (hidden) account select, which app.js listens to.
$("acctList").addEventListener("click", (e) => {
  const row = e.target.closest("[data-account]");
  if (!row) return;
  const select = $("accountSelect");
  if (select.value !== row.dataset.account) {
    select.value = row.dataset.account;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeSheet($("accountSheet"));
});
$("logoutBtn").addEventListener("click", () => closeSheet($("accountSheet")));

// ------------------------------------------------------- signal card
$("signalCard").addEventListener("click", (e) => {
  if (e.target.closest("[data-hide-signal]")) $("signalCard").hidden = true;
});
// The card describes one market and one account, so it goes when either changes.
$("symbolSelect").addEventListener("change", () => { $("signalCard").hidden = true; });
$("accountSelect").addEventListener("change", () => { $("signalCard").hidden = true; });
$("logoutBtn").addEventListener("click", () => { $("signalCard").hidden = true; });

// ------------------------------------------------------- activity feed
// Filter chips (All / Signals & trades / Problems) and "Show all": both only hide rows, nothing is removed.
const SHOWN = 6;
const feed = $("log"), more = $("logMore"), logEmpty = $("logEmpty");
const FILTERS = {
  all: { test: () => true, empty: "Nothing here yet." },
  trades: { test: (el) => /\bk-(BUY|SELL|WIN|LOSS)\b/.test(el.className), empty: "No signals or trades yet. They show up here as soon as the bot finds one." },
  problems: { test: (el) => el.classList.contains("k-ERROR"), empty: "No problems so far." },
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
let filter = FILTERS[store.get("tbot:ui:logFilter")] ? store.get("tbot:ui:logFilter") : "all";
function syncFeed() {
  const f = FILTERS[filter], all = feed.classList.contains("all");
  let shown = 0;
  for (const el of feed.children) {
    const match = f.test(el);
    if (match) shown++;
    el.classList.toggle("f-out", !match);
    el.classList.toggle("f-more", match && !all && shown > SHOWN);
    el.classList.toggle("f-first", match && shown === 1);
  }
  more.hidden = shown <= SHOWN;
  more.textContent = all ? "Show less" : `Show all activity (${shown})`;
  logEmpty.hidden = shown > 0;
  logEmpty.textContent = f.empty;
}
function setFilter(name) {
  filter = FILTERS[name] ? name : "all";
  store.set("tbot:ui:logFilter", filter);
  document.querySelectorAll("button[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  syncFeed();
}
document.querySelectorAll("button[data-filter]").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
more.addEventListener("click", () => { feed.classList.toggle("all"); syncFeed(); });
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes)
    if (n.nodeType === 1 && n.classList.contains("k-ERROR") && /^(Problem: )?Close failed/.test(n.querySelector(".feed-title")?.textContent || "")) resetClosing();
  syncFeed();
}).observe(feed, { childList: true });
setFilter(filter);

// ------------------------------------------------------- Close: "Closing…"
// After a tap the button shows "Closing…" and is disabled, so a slow close isn't tapped twice.
// It resets when Deriv refuses the close, and after 15 seconds at the latest.
const openList = $("openList");
const closing = new Map();   // contract id -> when Close was tapped
function paintClosing() {
  const now = Date.now();
  for (const [id, t] of closing) if (now - t > 15000) closing.delete(id);
  openList.querySelectorAll("[data-close]").forEach((b) => {
    const on = closing.has(b.dataset.close);
    if (on === b.classList.contains("is-closing")) return;
    b.classList.toggle("is-closing", on);
    b.disabled = on;
    b.textContent = on ? "Closing…" : "Close";
  });
}
function resetClosing() { closing.clear(); paintClosing(); }
openList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close]");
  if (!btn || btn.disabled) return;
  closing.set(btn.dataset.close, Date.now());
  setTimeout(paintClosing);   // after app.js has handled this click
  setTimeout(paintClosing, 15100);
});
new MutationObserver(paintClosing).observe(openList, { childList: true });

// ------------------------------------------------------- signal age
// "x min ago", and the card is dimmed as an old signal after 5 minutes or once the bot is stopped.
const sigCard = $("signalCard"), bar = $("actionBar");
let stoppedAt = 0;
new MutationObserver(() => { if (bar.dataset.state === "stopped") stoppedAt = Date.now(); syncSignalAge(); })
  .observe(bar, { attributes: true, attributeFilter: ["data-state"] });
function syncSignalAge() {
  const ts = Number(sigCard.dataset.ts);
  const age = sigCard.querySelector(".sig-age");
  if (!ts || !age) return;
  const min = Math.floor((Date.now() - ts) / 60000);
  age.textContent = min < 1 ? "just now" : `${min} min ago`;
  const stoppedSince = bar.dataset.state === "stopped" && stoppedAt > ts;
  sigCard.classList.toggle("is-stale", min >= 5 || stoppedSince);
  const old = sigCard.querySelector(".sig-old");
  if (old) old.textContent = min >= 5 ? "Old signal" : "Bot stopped since";
}
new MutationObserver(syncSignalAge).observe(sigCard, { childList: true });
setInterval(syncSignalAge, 15000);

// ------------------------------------------------------- Start while logged out
// "Log in to auto trade" takes you to the login card (app.js also notes it in Activity).
$("runBtn").addEventListener("click", (e) => {
  if (!e.currentTarget.classList.contains("is-login")) return;
  $("loginCard").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
});

// ------------------------------------------------------- risk summary
const form = $("settingsForm");
function riskSummary() {
  const v = (n) => form.elements[n]?.value;
  const parts = [`${v("riskPct") || "?"}% per trade`];
  if (Number(v("maxDailyLossPct")) > 0) parts.push(`stop at −${v("maxDailyLossPct")}% a day`);
  // Fast mode (AI only) allows 3 open trades; app.js shows the switch only for the AI model.
  const fast = !$("fastRow").hidden && $("fastRow").dataset.on === "1";
  if (fast) parts.push(`${AI_FAST.maxOpen} open at most (fast mode)`);
  else if (Number(v("maxOpen")) > 0) parts.push(`${v("maxOpen")} open at most`);
  $("riskSummary").textContent = parts.join(" · ");
}
form.addEventListener("change", riskSummary);
form.addEventListener("input", riskSummary);
new MutationObserver(riskSummary).observe($("fastRow"), { attributes: true, attributeFilter: ["hidden", "data-on"] });
riskSummary();
