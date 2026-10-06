// A small stand-in for the Deriv API, for testing the web bot locally.
// Serves public/ and fakes: OAuth (PKCE), the Options accounts REST API, the OTP
// WebSocket handshake and the WebSocket calls the bot uses. Prices are a random
// walk at Volatility-75 strength, and time runs fast (one M1 bar per BAR_MS ms).
//
//   node tools/mock-deriv.mjs            -> http://localhost:8787/?api=http://localhost:8787&auth=http://localhost:8787&ws=ws://localhost:8787/trading/v1/options/ws/public
//
// Settings for testing login problems (environment variables):
//   MOCK_CLIENT_ID=abc        only this App ID is accepted (others get Deriv's own error page)
//   MOCK_ALLOWED_SCOPES=trade scopes the app may ask for (default "trade account_manage")
//   MOCK_NO_ACCOUNTS=1        the login starts with no Options account
//   MOCK_ACCOUNTS_404=1       ...and Deriv lists no accounts as 404 AccountNotFound instead of []
//   MOCK_TOKEN_TTL=60         access token lifetime in seconds; MOCK_REFRESH=1 also issues refresh tokens
//   MOCK_NO_PROXY=1           /api/token is missing, as if the site had no server functions
//   MOCK_REDIRECT=url         the registered redirect URL (default http://localhost:8787/)
//   MOCK_PAT=token            also accept this personal access token (scope "trade account_manage"), only
//                             together with a Deriv-App-ID header, as Deriv does (for the server bot)
//   MOCK_LIMIT_MONEY_ONLY=1   open trades report their stop loss / take profit as money only (no price)
//   MOCK_CONTROL=1            tests may change the clock speed while it runs: POST /mock/clock {"barMs": 6000}
//                             (fast bars to get a signal soon, then slow ones so a trade stays open long enough to look at),
//                             open or close a market: POST /mock/market {"symbol": "frxEURUSD", "open": false},
//                             and play a fixed ICT buy setup: POST /mock/script {"name": "ict-buy"} (the next candles
//                             form a sweep, a break in structure and a fair value gap, then hold above the gap), then
//                             POST /mock/script {"touch": true} (the next candle's ticks come back into the gap)
//   MOCK_HISTORY=30000        1-minute candles of history at start (enough for 1-hour candles too)
//   MOCK_CLOSED=frxXAUUSD     markets that start closed (comma separated; "" for none)
//   MOCK_NO_ACTIVE_SYMBOLS=1  active_symbols fails, as if Deriv refused it (the bots keep their built-in list)
//
// active_symbols lists the synthetic indices, a few forex pairs, gold (closed by default), Bitcoin
// and one stock index without Multipliers, with the field names of Deriv's Options API
// (underlying_symbol). All markets share one random walk, scaled to each market's price level.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
process.env.DERIV_AUTH_URL = `http://localhost:${PORT}`;   // the site's /api/token forwards to this mock
const { POST: tokenProxy } = await import("../api/token.js");
const BAR_MS = Number(process.env.BAR_MS || 1000);
const root = new URL("../public/", import.meta.url).pathname;
// Serve pages with the same Content-Security-Policy as vercel.json, plus this mock's own address.
const vercelCsp = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"))
  .headers[0].headers.find((h) => h.key === "Content-Security-Policy").value
  .replace("connect-src 'self'", `connect-src 'self' ws://localhost:${PORT}`);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                ".svg": "image/svg+xml", ".json": "application/json" };

// ---------------------------------------------------------------- market
const sigmaBar = 0.75 / Math.sqrt(365 * 1440);
let gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const bars = [];
const HISTORY = Math.max(2000, Number(process.env.MOCK_HISTORY || 30000));
const KEEP = HISTORY + 6000;
let price = 400000, clockEpoch = Math.floor(Date.now() / 60000) * 60 - HISTORY * 60;
function makeBar(epoch) {
  const o = price;
  let h = o, l = o;
  for (let k = 0; k < 30; k++) { price *= Math.exp((sigmaBar / Math.sqrt(30)) * gauss()); h = Math.max(h, price); l = Math.min(l, price); }
  return { epoch, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +price.toFixed(2) };
}
for (let i = 0; i < HISTORY; i++) bars.push(makeBar(clockEpoch + i * 60));
let forming = makeBar(clockEpoch + HISTORY * 60);

// ---------------------------------------------------------------- markets
// [symbol, name, market, market_display_name, submarket, price level, decimals, has Multipliers]
const MARKET_LIST = [
  ["R_10", "Volatility 10 Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["R_25", "Volatility 25 Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["R_50", "Volatility 50 Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["R_75", "Volatility 75 Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["R_100", "Volatility 100 Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["1HZ10V", "Volatility 10 (1s) Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["1HZ100V", "Volatility 100 (1s) Index", "synthetic_index", "Derived", "random_index", 0, 2, true],
  ["frxEURUSD", "EUR/USD", "forex", "Forex", "major_pairs", 1.08, 5, true],
  ["frxGBPUSD", "GBP/USD", "forex", "Forex", "major_pairs", 1.27, 5, true],
  ["frxXAUUSD", "Gold/USD", "commodities", "Commodities", "metals", 2400, 2, true],
  ["cryBTCUSD", "BTC/USD", "cryptocurrency", "Cryptocurrencies", "non_stable_coin", 60000, 2, true],
  ["OTC_DJI", "Wall Street 30", "indices", "Stock Indices", "americas_OTC", 39000, 2, false],
];
const closedMarkets = new Set((process.env.MOCK_CLOSED ?? "frxXAUUSD").split(",").map((x) => x.trim()).filter(Boolean));
const marketOf = (sym) => MARKET_LIST.find((m) => m[0] === sym);
/** Each market's prices: the shared walk scaled to its own level. */
const scaleOf = (sym) => { const m = marketOf(sym); return m && m[5] ? m[5] / 400000 : 1; };
const decOf = (sym) => marketOf(sym)?.[6] ?? 2;
const px = (v, sym) => +(v * scaleOf(sym)).toFixed(decOf(sym));
const scaleBar = (b, sym) => (scaleOf(sym) === 1 ? b : { ...b, open: px(b.open, sym), high: px(b.high, sym), low: px(b.low, sym), close: px(b.close, sym) });
const isOpen = (sym) => !closedMarkets.has(sym);

// ---------------------------------------------------------------- scripts
// A fixed ICT buy setup in "units" around the price when it starts (the same bars as
// test/ict.test.mjs): flat candles, a swing low, a sweep below it, a strong candle that
// breaks the swing high and leaves a fair value gap, then candles that hold above the gap.
const ICT_FLAT = [100, 100.5, 99.5, 100];
const ICT_SETUP = [
  [100, 100.5, 99, 99.2], [99.2, 99.4, 98, 98.2], [98.2, 98.5, 97, 97.8], [97.8, 99, 97.6, 98.8], [98.8, 100, 98.5, 99.8],
  [99.8, 101, 99.5, 100.2], [100.2, 100.4, 99, 99.2], [99.2, 99.5, 98, 98.2], [98.2, 98.4, 96.5, 97.5], [97.5, 99, 97.3, 98.8],
  [98.8, 101.8, 98.7, 101.6], [101.6, 102.5, 101.2, 102.2], [102.2, 102.4, 101.6, 101.8],
];
const ICT_HOLD = [101.8, 102.0, 101.6, 101.8];
const ICT_TOUCH = { bar: [101.8, 101.9, 100.8, 101.0], path: [101.7, 101.5, 101.1, 101.0, 101.0] };
const script = { queue: [], hold: false, base: 0, unit: 0 };
const unitPrice = (v) => +(script.base + (v - 100) * script.unit).toFixed(2);
const unitBar = (epoch, [o, h, l, c]) => ({ epoch, open: unitPrice(o), high: unitPrice(h), low: unitPrice(l), close: unitPrice(c) });
function startScript(name) {
  if (name !== "ict-buy") return false;
  script.base = forming.close; script.unit = +(forming.close * 0.001).toFixed(2);   // about one candle's usual range
  script.queue = [...Array(20).fill(ICT_FLAT), ...ICT_SETUP].map((bar) => ({ bar }));
  script.hold = true;
  return true;
}
/** The next candle when a script runs: {bar, path?}, or null for the normal random walk. */
function scriptNext() {
  if (script.queue.length) return script.queue.shift();
  if (script.hold) return { bar: ICT_HOLD };
  return null;
}
// Other timeframes are the same random walk grouped into longer candles (the last one still forming).
// (candlesOf and formingOf are in the R_75 price level; scaleBar turns them into another market's.)
const GRANULARITIES = [60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];
function candlesOf(g) {
  if (g === 60) return [...bars, forming];
  const out = [];
  for (const b of [...bars, forming]) {
    const start = Math.floor(b.epoch / g) * g, last = out[out.length - 1];
    if (last && last.epoch === start) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; }
    else out.push({ epoch: start, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out;
}
function formingOf(g) {
  if (g === 60) return forming;
  const start = Math.floor(forming.epoch / g) * g;
  let c = null;
  for (let i = bars.length - 1; i >= 0 && bars[i].epoch >= start; i--) {
    const b = bars[i];
    c = c ? { epoch: start, open: b.open, high: Math.max(c.high, b.high), low: Math.min(c.low, b.low), close: c.close } : { ...b, epoch: start };
  }
  const f = forming;
  return c ? { ...c, high: Math.max(c.high, f.high), low: Math.min(c.low, f.low), close: f.close } : { ...f, epoch: start };
}

// ----------------------------------------------------------------- state
const codes = new Map();           // code -> {challenge, clientId, redirectUri, scope}
const tokens = new Map();          // access token -> {scope, exp}
const refreshTokens = new Map();   // refresh token -> {scope, clientId}
const ALLOWED_SCOPES = (process.env.MOCK_ALLOWED_SCOPES || "trade account_manage").split(/\s+/);
const TOKEN_TTL = Number(process.env.MOCK_TOKEN_TTL || 3600);
const accounts = process.env.MOCK_NO_ACCOUNTS ? [] : [
  { account_id: "DOT90000001", account_type: "demo", currency: "USD", balance: 10000, group: "row", status: "active" },
  { account_id: "ROT10000001", account_type: "real", currency: "USD", balance: 25, group: "row", status: "active" },
];
function issueToken(scope, clientId) {
  const access = "ory_at_" + randomBytes(12).toString("hex");
  tokens.set(access, { scope, exp: Date.now() + TOKEN_TTL * 1000 });
  const out = { access_token: access, token_type: "Bearer", expires_in: TOKEN_TTL, scope };
  if (process.env.MOCK_REFRESH) {
    out.refresh_token = "ory_rt_" + randomBytes(12).toString("hex");
    refreshTokens.set(out.refresh_token, { scope, clientId });
  }
  return out;
}
const apiError = (status, code, message) => ({ errors: [{ status, code, message }], meta: { timing: 1 } });
const otps = new Map();            // otp -> account
const contracts = new Map();       // id -> contract
let nextContract = 1000;
const sockets = new Set();

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

// ---------------------------------------------------------------- http
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Deriv-App-ID, Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const body = await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
  const json = (code, obj) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));

  if (process.env.MOCK_CONTROL && url.pathname === "/mock/clock" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse(body); } catch { /* checked below */ }
    const ms = Number(b.barMs);
    if (!(ms >= 60 && ms <= 600000)) return json(400, { error: "barMs must be between 60 and 600000" });
    setClock(ms);
    return json(200, { barMs: ms });
  }
  if (process.env.MOCK_CONTROL && url.pathname === "/mock/market" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse(body); } catch { /* checked below */ }
    if (!marketOf(b.symbol) || typeof b.open !== "boolean") return json(400, { error: "symbol and open (true/false) needed" });
    if (b.open) closedMarkets.delete(b.symbol); else closedMarkets.add(b.symbol);
    return json(200, { symbol: b.symbol, open: b.open });
  }
  if (process.env.MOCK_CONTROL && url.pathname === "/mock/script" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse(body); } catch { /* checked below */ }
    if (b.touch) {
      if (!script.hold) return json(409, { error: "no script is holding" });
      script.hold = false;
      script.queue.push({ bar: ICT_TOUCH.bar, path: ICT_TOUCH.path });
      return json(200, { touch: true, zone: [unitPrice(99), unitPrice(101.2)] });
    }
    if (b.stop) { script.queue = []; script.hold = false; return json(200, { stopped: true }); }
    if (!startScript(b.name)) return json(400, { error: "unknown script" });
    return json(200, { name: b.name, base: script.base, unit: script.unit, zone: [unitPrice(99), unitPrice(101.2)], sweepLow: unitPrice(96.5) });
  }
  if (url.pathname === "/oauth2/auth") {
    const p = url.searchParams;
    const page = (code, text) => res.writeHead(code, { "Content-Type": "text/html" }).end(`<h1>Deriv login error</h1><p>${text}</p>`);
    if (p.get("code_challenge_method") !== "S256" || !p.get("client_id")) return page(400, "invalid_request");
    if (process.env.MOCK_CLIENT_ID && p.get("client_id") !== process.env.MOCK_CLIENT_ID) return page(401, "invalid_client");
    if (p.get("redirect_uri") !== (process.env.MOCK_REDIRECT || `http://localhost:${PORT}/`)) return page(400, "The 'redirect_uri' parameter does not match any of the OAuth 2.0 Client's pre-registered redirect urls.");
    const back = new URL(p.get("redirect_uri"));
    back.searchParams.set("state", p.get("state"));
    const asked = (p.get("scope") || "").split(/\s+/).filter(Boolean);
    const bad = asked.find((x) => !ALLOWED_SCOPES.includes(x));
    if (bad) {
      back.searchParams.set("error", "invalid_scope");
      back.searchParams.set("error_description", `The OAuth 2.0 Client is not allowed to request scope '${bad}'.`);
      return res.writeHead(302, { Location: back.toString() }).end();
    }
    const code = randomBytes(8).toString("hex");
    codes.set(code, { challenge: p.get("code_challenge"), clientId: p.get("client_id"), redirectUri: p.get("redirect_uri"), scope: asked.join(" ") });
    back.searchParams.set("code", code);
    return res.writeHead(302, { Location: back.toString() }).end();
  }
  if (url.pathname === "/api/token" && req.method === "POST" && !process.env.MOCK_NO_PROXY) {
    const out = await tokenProxy(new Request(`http://localhost:${PORT}/api/token`, { method: "POST", body }));
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
    return;
  }
  if (url.pathname === "/oauth2/token" && req.method === "POST") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "refresh_token") {
      const r = refreshTokens.get(p.get("refresh_token"));
      if (!r || r.clientId !== p.get("client_id")) return json(400, { error: "invalid_grant", error_description: "bad refresh token" });
      refreshTokens.delete(p.get("refresh_token"));
      return json(200, issueToken(r.scope, r.clientId));
    }
    const entry = codes.get(p.get("code"));
    const challenge = createHash("sha256").update(p.get("code_verifier") || "").digest("base64url");
    if (!entry || entry.challenge !== challenge || entry.clientId !== p.get("client_id") || entry.redirectUri !== p.get("redirect_uri"))
      return json(400, { error: "invalid_grant", error_description: "The provided authorization grant is invalid." });
    codes.delete(p.get("code"));
    return json(200, issueToken(entry.scope, entry.clientId));
  }
  if (url.pathname.startsWith("/trading/v1/options/accounts")) {
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    let tok = tokens.get(bearer);
    if (!tok && process.env.MOCK_PAT && bearer === process.env.MOCK_PAT) {
      if (!req.headers["deriv-app-id"]) return json(401, apiError(401, "Unauthorized", "Deriv-App-ID header is required for PAT tokens"));
      tok = { scope: "trade account_manage", exp: Infinity };
    }
    if (!tok || tok.exp < Date.now()) return json(401, apiError(401, "InvalidToken", "Invalid or expired token"));
    const scopes = tok.scope.split(" ");
    const m = url.pathname.match(/accounts\/([^/]+)\/otp$/);
    if (m && req.method === "POST") {
      if (!scopes.includes("trade")) return json(403, apiError(403, "AccessDenied", "Missing scope: trade"));
      const acc = accounts.find((a) => a.account_id === m[1]);
      if (!acc) return json(404, apiError(404, "AccountNotFound", "Resource not found"));
      const otp = randomBytes(6).toString("hex");
      otps.set(otp, acc);
      return json(200, { data: { url: `ws://localhost:${PORT}/trading/v1/options/ws/${acc.account_type}?otp=${otp}` } });
    }
    if (req.method === "POST") {
      if (!scopes.includes("account_manage")) return json(403, apiError(403, "AccessDenied", "Missing scope: account_manage"));
      let b = {};
      try { b = JSON.parse(body); } catch { return json(400, apiError(400, "InvalidBody", "Invalid JSON")); }
      if (b.currency !== "USD" || b.group !== "row" || !["demo", "real"].includes(b.account_type)) return json(400, apiError(400, "InvalidBody", "Bad account fields"));
      const existing = accounts.find((a) => a.account_type === b.account_type);
      if (existing) return json(200, { data: existing });
      const acc = { account_id: (b.account_type === "demo" ? "DOT" : "ROT") + String(90000000 + accounts.length + 1),
                    account_type: b.account_type, currency: "USD", balance: b.account_type === "demo" ? 10000 : 0, group: "row", status: "active" };
      accounts.push(acc);
      return json(201, { data: [acc] });
    }
    if (!scopes.includes("trade")) return json(403, apiError(403, "AccessDenied", "Missing scope: trade"));
    if (!accounts.length && process.env.MOCK_ACCOUNTS_404) return json(404, apiError(404, "AccountNotFound", "Resource not found"));
    return json(200, { data: accounts, meta: { endpoint: "/accounts", method: "GET", timing: 3 } });
  }
  // static files
  try {
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const data = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Content-Security-Policy": vercelCsp }).end(data);
  } catch { res.writeHead(404).end("not found"); }
});

// -------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.endsWith("/public")) ws.account = null;
  else {
    const acc = otps.get(url.searchParams.get("otp"));
    if (!acc) return ws.close(4001, "bad otp");
    otps.delete(url.searchParams.get("otp"));    // one use only
    ws.account = acc;
  }
  ws.subs = new Map();
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", (raw) => handle(ws, JSON.parse(raw)));
});

function err(ws, req, code, message) { send(ws, { msg_type: Object.keys(req)[0], req_id: req.req_id, echo_req: req, error: { code, message } }); }

function handle(ws, req) {
  const r = { req_id: req.req_id, echo_req: req };
  if (req.ping) return send(ws, { ...r, msg_type: "ping", ping: "pong" });
  if (req.forget) { const had = ws.subs.delete(req.forget); return send(ws, { ...r, msg_type: "forget", forget: had ? 1 : 0 }); }
  if (req.ticks_history) {
    if (req.symbol) return err(ws, req, "InputValidationFailed", "unknown field symbol");
    const sym = String(req.ticks_history);
    if (!marketOf(sym)) return err(ws, req, "InvalidSymbol", "Symbol is invalid.");
    const g = Number(req.granularity || 60);
    if (!GRANULARITIES.includes(g)) return err(ws, req, "InputValidationFailed", "granularity");
    if (req.count > 5000) return err(ws, req, "InputValidationFailed", "count");
    let list = candlesOf(g);
    if (req.end && req.end !== "latest") list = list.filter((b) => b.epoch <= Number(req.end));
    list = list.slice(-(req.count || 1000)).map((b) => scaleBar(b, sym));
    const subId = req.subscribe ? "sub" + randomBytes(4).toString("hex") : undefined;
    send(ws, { ...r, msg_type: "candles", candles: list, ...(subId && { subscription: { id: subId } }) });
    if (subId) ws.subs.set(subId, { kind: "ohlc", req_id: req.req_id, g, symbol: sym });
    return;
  }
  if (req.active_symbols) {
    if (process.env.MOCK_NO_ACTIVE_SYMBOLS) return err(ws, req, "UnrecognisedRequest", "unrecognised request");
    if (!["brief", "full"].includes(req.active_symbols)) return err(ws, req, "InputValidationFailed", "active_symbols");
    const mult = Array.isArray(req.contract_type) && req.contract_type.some((t) => /^MULT/.test(t));
    const list = MARKET_LIST.filter((m) => !mult || m[7]).map(([sym, name, market, marketName, sub], k) => ({
      underlying_symbol: sym, display_name: name, display_order: k, market, market_display_name: marketName, submarket: sub,
      submarket_display_name: sub, subgroup: "none", subgroup_display_name: "None", symbol_type: market === "forex" ? "forex" : "",
      exchange_is_open: isOpen(sym) ? 1 : 0, is_trading_suspended: 0, pip: 10 ** -decOf(sym),
    }));
    return send(ws, { ...r, msg_type: "active_symbols", active_symbols: list });
  }
  if (req.contracts_for) {
    const m = marketOf(String(req.contracts_for));
    if (!m) return err(ws, req, "InvalidSymbol", "Symbol is invalid.");
    if (!m[7]) return send(ws, { ...r, msg_type: "contracts_for", contracts_for: { available: [
      { contract_type: "CALL", contract_category: "callput" }, { contract_type: "PUT", contract_category: "callput" }] } });
    return send(ws, { ...r, msg_type: "contracts_for", contracts_for: { available: [
      { contract_type: "MULTUP", contract_category: "multiplier", multiplier_range: [50, 100, 200, 300, 500], min_stake: 1, max_stake: 2000 },
      { contract_type: "MULTDOWN", contract_category: "multiplier", multiplier_range: [50, 100, 200, 300, 500], min_stake: 1, max_stake: 2000 }] } });
  }
  if (!ws.account) return err(ws, req, "AuthorizationRequired", "Please log in.");
  const acc = ws.account;
  if (req.balance) {
    const subId = "bal" + randomBytes(3).toString("hex");
    ws.subs.set(subId, { kind: "balance", req_id: req.req_id });
    return send(ws, { ...r, msg_type: "balance", balance: { balance: acc.balance, currency: acc.currency }, subscription: { id: subId } });
  }
  if (req.portfolio) return send(ws, { ...r, msg_type: "portfolio", portfolio: { contracts: [...contracts.values()].filter((c) => c.acc === acc && !c.sold)
    .map((c) => ({ contract_id: c.id, contract_type: c.type, underlying_symbol: c.symbol })) } });
  if (req.proposal) {
    for (const k of ["amount", "contract_type", "currency", "underlying_symbol", "multiplier"]) if (req[k] === undefined) return err(ws, req, "InputValidationFailed", `missing ${k}`);
    if (req.limit_order?.stop_loss > req.amount) return err(ws, req, "InvalidStopLoss", "Stop loss cannot be more than the stake.");
    if (!marketOf(req.underlying_symbol)?.[7]) return err(ws, req, "ContractBuyValidationError", "Trading is not offered for this asset.");
    if (!isOpen(req.underlying_symbol)) return err(ws, req, "MarketIsClosed", "This market is presently closed.");
    const id = "prop" + randomBytes(4).toString("hex");
    ws.lastProposal = { id, ...req };
    return send(ws, { ...r, msg_type: "proposal", proposal: { id, ask_price: req.amount, commission: +(req.amount * req.multiplier * 0.00005).toFixed(2), spot: px(forming.close, req.underlying_symbol) } });
  }
  if (req.buy) {
    const p = ws.lastProposal;
    if (!p || p.id !== req.buy) return err(ws, req, "InvalidContractProposal", "proposal expired");
    if (p.amount > acc.balance) return err(ws, req, "InsufficientBalance", "not enough balance");
    const c = { id: nextContract++, acc, type: p.contract_type, symbol: p.underlying_symbol, stake: p.amount, mult: p.multiplier,
                entry: px(forming.close, p.underlying_symbol), entryTime: forming.epoch + 30, sl: p.limit_order?.stop_loss, tp: p.limit_order?.take_profit,
                commission: +(p.amount * p.multiplier * 0.00005).toFixed(2), sold: false, profit: 0 };
    contracts.set(c.id, c);
    acc.balance = +(acc.balance - c.stake).toFixed(2);
    pushBalance(acc);
    return send(ws, { ...r, msg_type: "buy", buy: { contract_id: c.id, buy_price: c.stake, balance_after: acc.balance, transaction_id: c.id * 7 } });
  }
  if (req.proposal_open_contract) {
    const c = contracts.get(Number(req.contract_id));
    if (!c) return err(ws, req, "ContractNotFound", "no such contract");
    const subId = "poc" + randomBytes(3).toString("hex");
    ws.subs.set(subId, { kind: "poc", req_id: req.req_id, contract: c });
    return send(ws, { ...r, msg_type: "proposal_open_contract", proposal_open_contract: poc(c), subscription: { id: subId } });
  }
  if (req.sell) {
    const c = contracts.get(Number(req.sell));
    if (!c || c.sold) return err(ws, req, "InvalidSellContractProposal", "already sold");
    settle(c);
    return send(ws, { ...r, msg_type: "sell", sell: { contract_id: c.id, sold_for: +(c.stake + c.profit).toFixed(2) } });
  }
  err(ws, req, "UnrecognisedRequest", "unrecognised request");
}

// Like Deriv: the entry spot and the limit orders as money (order_amount) and price (value).
// MOCK_LIMIT_MONEY_ONLY=1 leaves the price out, so the page has to work it out from the money.
function limitOrder(c, kind) {
  const amount = c[kind];
  if (!amount) return undefined;
  const dist = (amount / (c.stake * c.mult)) * c.entry, up = c.type === "MULTUP";
  const price = kind === "tp" ? (up ? c.entry + dist : c.entry - dist) : (up ? c.entry - dist : c.entry + dist);
  return { display_name: kind === "tp" ? "Take profit" : "Stop loss", order_amount: kind === "tp" ? amount : -amount, order_date: c.entryTime,
           ...(!process.env.MOCK_LIMIT_MONEY_ONLY && { value: price.toFixed(2) }) };
}
function poc(c) {
  return { contract_id: c.id, contract_type: c.type, buy_price: c.stake, profit: c.profit, is_sold: c.sold ? 1 : 0,
           status: c.sold ? "sold" : "open", current_spot: px(forming.close, c.symbol), entry_spot: c.entry, entry_tick_time: c.entryTime, date_start: c.entryTime,
           multiplier: c.mult, underlying_symbol: c.symbol, limit_order: { stop_loss: limitOrder(c, "sl"), take_profit: limitOrder(c, "tp") },
           ...(c.sold && { exit_tick_display_value: String(c.exit) }) };
}
function pnl(c) {
  const move = (px(forming.close, c.symbol) - c.entry) / c.entry * (c.type === "MULTUP" ? 1 : -1);
  return +(c.stake * c.mult * move - c.commission).toFixed(2);
}
function settle(c) {
  c.profit = Math.max(pnl(c), -c.stake); c.sold = true; c.exit = px(forming.close, c.symbol);
  c.acc.balance = +(c.acc.balance + c.stake + c.profit).toFixed(2);
  pushBalance(c.acc);
}
function pushBalance(acc) {
  for (const ws of sockets) if (ws.account === acc)
    for (const [id, s] of ws.subs) if (s.kind === "balance")
      send(ws, { msg_type: "balance", req_id: s.req_id, balance: { balance: acc.balance, currency: acc.currency }, subscription: { id } });
}

// ------------------------------------------------------------------ clock
// Ticks every BAR_MS/6: the forming bar moves; every 6th tick a new bar starts.
let tick = 0, path = null;
function clockTick() {
  tick++;
  if (tick % 6 === 0) {
    if (path?.final) forming = { ...forming, ...path.final };   // a scripted candle ends exactly as written
    bars.push(forming); if (bars.length > KEEP) bars.shift();
    path = null;
    const next = scriptNext();
    if (!next) forming = makeBar(forming.epoch + 60);
    else {
      const b = unitBar(forming.epoch + 60, next.bar);
      price = b.close;
      if (next.path) {   // ticks move the candle along the path, starting at its open
        path = { steps: next.path.map(unitPrice), final: { open: b.open, high: b.high, low: b.low, close: b.close } };
        forming = { epoch: b.epoch, open: b.open, high: b.open, low: b.open, close: b.open };
      } else forming = b;
    }
  } else if (path) {
    const p = path.steps.shift() ?? forming.close;
    forming = { ...forming, close: p, high: Math.max(forming.high, p), low: Math.min(forming.low, p) };
  } else if (!script.hold && !script.queue.length) {
    price *= Math.exp((sigmaBar / Math.sqrt(6)) * gauss());
    forming = { ...forming, close: +price.toFixed(2), high: Math.max(forming.high, +price.toFixed(2)), low: Math.min(forming.low, +price.toFixed(2)) };
  }
  for (const c of contracts.values()) {
    if (c.sold) continue;
    c.profit = pnl(c);
    if ((c.sl && c.profit <= -c.sl) || (c.tp && c.profit >= c.tp) || c.profit <= -c.stake) settle(c);
  }
  for (const ws of sockets) for (const [id, s] of ws.subs) {
    if (s.kind === "ohlc" && isOpen(s.symbol)) {   // a closed market sends no prices
      const g = s.g || 60, f = scaleBar(formingOf(g), s.symbol);
      send(ws, { msg_type: "ohlc", req_id: s.req_id, subscription: { id },
        ohlc: { open_time: f.epoch, epoch: forming.epoch + 59, open: String(f.open), high: String(f.high),
                low: String(f.low), close: String(f.close), granularity: g, symbol: s.symbol } });
    }
    if (s.kind === "poc") { send(ws, { msg_type: "proposal_open_contract", req_id: s.req_id, proposal_open_contract: poc(s.contract), subscription: { id } });
      if (s.contract.sold) ws.subs.delete(id); }
  }
}
let clock = setInterval(clockTick, BAR_MS / 6);
function setClock(barMs) { clearInterval(clock); clock = setInterval(clockTick, barMs / 6); }

server.listen(PORT, () => console.log(`mock Deriv on http://localhost:${PORT}`));
