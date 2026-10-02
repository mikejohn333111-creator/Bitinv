(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let filter = "all", data = null, lastOk = 0;

  // View key: ?key=... once, then remembered on this device.
  const params = new URLSearchParams(location.search);
  let key = params.get("key");
  try {
    if (key) localStorage.setItem("tbotKey", key); else key = localStorage.getItem("tbotKey");
  } catch {}
  if (params.has("key")) history.replaceState(null, "", location.pathname);

  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmt = (v, d) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: d ?? 5 }) : "–");

  function renderBots(bots) {
    if (!bots.length) {
      $("bots").innerHTML = `<div class="card empty" style="grid-column:1/-1">No bot has checked in yet. Set the dashboard URL and secret in the EA inputs.</div>`;
      return;
    }
    bots.sort((a, b) => (a.bot + a.symbol).localeCompare(b.bot + b.symbol));
    $("bots").innerHTML = bots.map((b) => {
      const stale = Date.now() - new Date(b.received).getTime() > 15 * 60 * 1000;
      const state = stale ? ["OFFLINE", "bad"] : b.state === "ACTIVE" ? ["ACTIVE", "ok"] : [b.state || "?", "warn"];
      const pl = typeof b.day_pl_pct === "number" ? b.day_pl_pct : null;
      return `<div class="card">
        <div class="bot-top"><span class="bot-name">${esc(b.bot)}</span><span class="sym">${esc(b.symbol)}</span></div>
        <div class="pills">
          <span class="pill ${state[1]}">${esc(state[0])}</span>
          <span class="pill">${b.mode === "auto" ? "Auto trade" : "Signals only"}</span>
          ${b.regime ? `<span class="pill">${esc(b.regime)}</span>` : ""}
        </div>
        <div class="stats">
          <span>Equity</span><b>${fmt(b.equity, 2)} ${esc(b.currency || "")}</b>
          <span>Today</span><b class="${pl > 0 ? "pos" : pl < 0 ? "neg" : ""}">${pl === null ? "–" : (pl > 0 ? "+" : "") + pl.toFixed(2) + "%"}</b>
          <span>Open</span><b>${fmt(b.open_positions, 0)}</b>
          <span>Seen</span><b>${ago(b.received)}</b>
        </div>
      </div>`;
    }).join("");
  }

  function renderEvents(events) {
    const shown = events.filter((e) => filter === "all" || (filter === "signal" ? e.type === "signal" : e.type !== "signal"));
    if (!shown.length) {
      $("list").innerHTML = `<div class="card empty">${filter === "trade" ? "No trades yet." : "No signals yet. They appear here as soon as the bot finds a setup."}</div>`;
      return;
    }
    const label = { signal: "Signal", open: "Opened", close: "Closed" };
    $("list").innerHTML = shown.map((e) => {
      const levels = e.type === "close"
        ? `<div><span>Result</span> <b class="${e.profit >= 0 ? "pos" : "neg"}">${e.profit >= 0 ? "+" : ""}${fmt(e.profit, 2)}</b></div>
           ${e.price ? `<div><span>Exit</span> ${fmt(e.price)}</div>` : ""}`
        : `<div><span>Entry</span> ${fmt(e.entry)}</div><div><span>SL</span> ${fmt(e.sl)}</div><div><span>TP</span> ${fmt(e.tp)}</div>
           ${e.lots ? `<div><span>Lot</span> ${fmt(e.lots, 3)}</div>` : ""}
           ${typeof e.confidence === "number" ? `<div><span>Conf.</span> ${Math.round(e.confidence * 100)}%</div>` : ""}`;
      return `<div class="card ev">
        <span class="side ${esc(e.side)}">${esc(e.side)}</span>
        <div class="ev-title">${esc(e.symbol)} <small>${label[e.type]} · ${esc(e.bot)}</small></div>
        <div class="ev-time" title="${esc(new Date(e.time).toLocaleString())}">${clock(e.time)}<br>${ago(e.time)}</div>
        <div class="levels">${levels}</div>
        ${e.reason ? `<div class="reason">${esc(e.reason)}</div>` : ""}
      </div>`;
    }).join("");
  }

  function render() {
    if (!data) return;
    renderBots(data.bots || []);
    renderEvents(data.events || []);
  }

  async function load() {
    try {
      const res = await fetch("/api/feed" + (key ? "?key=" + encodeURIComponent(key) : ""), { cache: "no-store" });
      const body = await res.json();
      if (res.status === 401) {
        $("banner").innerHTML = `<div class="banner">This dashboard is private. Open it once with <b>?key=YOUR_VIEW_KEY</b> at the end of the address.</div>`;
        $("dot").className = "dot"; $("updated").textContent = "locked";
        return;
      }
      if (!res.ok) throw new Error(body.error || res.status);
      data = body; lastOk = Date.now();
      $("banner").innerHTML = body.storage === "memory"
        ? `<div class="banner">No database connected, so history resets when the server restarts. Add Upstash Redis in Vercel to keep it.</div>` : "";
      render();
    } catch (err) {
      $("banner").innerHTML = `<div class="banner">Can't reach the server (${esc(err.message)}). Retrying…</div>`;
    }
    tick();
  }

  function tick() {
    const fresh = lastOk && Date.now() - lastOk < 30000;
    $("dot").className = "dot" + (fresh ? " on" : "");
    if (lastOk) $("updated").textContent = "updated " + ago(new Date(lastOk).toISOString());
  }

  document.querySelectorAll(".filters button").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));

  load();
  setInterval(load, 10000);
  setInterval(() => { tick(); render(); }, 5000);
})();
