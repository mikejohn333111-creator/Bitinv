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
let price = 400000, clockEpoch = Math.floor(Date.now() / 60000) * 60 - 2000 * 60;
function makeBar(epoch) {
  const o = price;
  let h = o, l = o;
  for (let k = 0; k < 30; k++) { price *= Math.exp((sigmaBar / Math.sqrt(30)) * gauss()); h = Math.max(h, price); l = Math.min(l, price); }
  return { epoch, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +price.toFixed(2) };
}
for (let i = 0; i < 2000; i++) bars.push(makeBar(clockEpoch + i * 60));
let forming = makeBar(clockEpoch + 2000 * 60);

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
    const tok = tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
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
  if (req.forget) return send(ws, { ...r, msg_type: "forget", forget: 1 });
  if (req.ticks_history) {
    if (req.symbol) return err(ws, req, "InputValidationFailed", "unknown field symbol");
    let list = [...bars, forming];
    if (req.end && req.end !== "latest") list = list.filter((b) => b.epoch <= Number(req.end));
    list = list.slice(-(req.count || 1000));
    const subId = req.subscribe ? "sub" + randomBytes(4).toString("hex") : undefined;
    send(ws, { ...r, msg_type: "candles", candles: list, ...(subId && { subscription: { id: subId } }) });
    if (subId) ws.subs.set(subId, { kind: "ohlc", req_id: req.req_id });
    return;
  }
  if (req.contracts_for) return send(ws, { ...r, msg_type: "contracts_for", contracts_for: { available: [
    { contract_type: "MULTUP", contract_category: "multiplier", multiplier_range: [50, 100, 200, 300, 500], min_stake: 1, max_stake: 2000 },
    { contract_type: "MULTDOWN", contract_category: "multiplier", multiplier_range: [50, 100, 200, 300, 500], min_stake: 1, max_stake: 2000 }] } });
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
    const id = "prop" + randomBytes(4).toString("hex");
    ws.lastProposal = { id, ...req };
    return send(ws, { ...r, msg_type: "proposal", proposal: { id, ask_price: req.amount, commission: +(req.amount * req.multiplier * 0.00005).toFixed(2), spot: forming.close } });
  }
  if (req.buy) {
    const p = ws.lastProposal;
    if (!p || p.id !== req.buy) return err(ws, req, "InvalidContractProposal", "proposal expired");
    if (p.amount > acc.balance) return err(ws, req, "InsufficientBalance", "not enough balance");
    const c = { id: nextContract++, acc, type: p.contract_type, symbol: p.underlying_symbol, stake: p.amount, mult: p.multiplier,
                entry: forming.close, sl: p.limit_order?.stop_loss, tp: p.limit_order?.take_profit,
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

function poc(c) {
  return { contract_id: c.id, contract_type: c.type, buy_price: c.stake, profit: c.profit, is_sold: c.sold ? 1 : 0,
           status: c.sold ? "sold" : "open", current_spot: forming.close, ...(c.sold && { exit_tick_display_value: String(c.exit) }) };
}
function pnl(c) {
  const move = (forming.close - c.entry) / c.entry * (c.type === "MULTUP" ? 1 : -1);
  return +(c.stake * c.mult * move - c.commission).toFixed(2);
}
function settle(c) {
  c.profit = Math.max(pnl(c), -c.stake); c.sold = true; c.exit = forming.close;
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
let tick = 0;
setInterval(() => {
  tick++;
  if (tick % 6 === 0) { bars.push(forming); if (bars.length > 6000) bars.shift(); forming = makeBar(forming.epoch + 60); }
  else {
    price *= Math.exp((sigmaBar / Math.sqrt(6)) * gauss());
    forming = { ...forming, close: +price.toFixed(2), high: Math.max(forming.high, +price.toFixed(2)), low: Math.min(forming.low, +price.toFixed(2)) };
  }
  for (const c of contracts.values()) {
    if (c.sold) continue;
    c.profit = pnl(c);
    if ((c.sl && c.profit <= -c.sl) || (c.tp && c.profit >= c.tp) || c.profit <= -c.stake) settle(c);
  }
  for (const ws of sockets) for (const [id, s] of ws.subs) {
    if (s.kind === "ohlc") send(ws, { msg_type: "ohlc", req_id: s.req_id, subscription: { id },
      ohlc: { open_time: forming.epoch, epoch: forming.epoch + 59, open: String(forming.open), high: String(forming.high),
              low: String(forming.low), close: String(forming.close), granularity: 60, symbol: "R_75" } });
    if (s.kind === "poc") { send(ws, { msg_type: "proposal_open_contract", req_id: s.req_id, proposal_open_contract: poc(s.contract), subscription: { id } });
      if (s.contract.sold) ws.subs.delete(id); }
  }
}, BAR_MS / 6);

server.listen(PORT, () => console.log(`mock Deriv on http://localhost:${PORT}`));
