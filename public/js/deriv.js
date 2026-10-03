// Deriv API client for the browser: OAuth 2.0 (PKCE) or personal-access-token
// login, the Options accounts REST API, and a WebSocket wrapper with
// request/response matching, subscriptions, keep-alive and reconnects.
//
// Flow (new Deriv API, developers.deriv.com):
//   1. Log in: OAuth at auth.deriv.com -> code, swapped for an access token through
//      this site's /api/token (or the user pastes a PAT)
//   2. GET  {API}/trading/v1/options/accounts           -> demo / real accounts
//   3. POST {API}/trading/v1/options/accounts/{id}/otp  -> one-time WebSocket URL
//   4. WebSocket: balance, ticks_history, contracts_for, proposal, buy, sell, ...
// Market data without logging in uses the public WebSocket.

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function randomString(n = 64) {
  return b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
}

/** Where Deriv sends the user back. It must equal the app's registered redirect URL exactly. */
export const redirectUri = () => location.origin + "/";

/** App IDs pasted on phones can carry spaces or invisible characters. */
export const cleanAppId = (s) => String(s ?? "").replace(/[\s​-‍⁠﻿]/g, "");

/** trade: accounts, OTP and trading. account_manage: creating an Options account if there is none. */
export const FULL_SCOPE = "trade account_manage";
export const hasScope = (auth, s) => String(auth?.scope || "").split(/\s+/).includes(s);

/** A login problem with a short code the page can act on and a message for the user. */
export class LoginError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// ------------------------------------------------------------------ login
// The PKCE values are kept in this tab (sessionStorage) and, keyed by state, in
// localStorage, so a login that comes back in a new tab of the same browser still works.
const PKCE_KEY = "tbot:pkce";
const PKCE_TTL = 15 * 60 * 1000;

function savePkce(rec) {
  let saved = false;
  try { sessionStorage.setItem(PKCE_KEY, JSON.stringify(rec)); saved = true; } catch { /* blocked */ }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PKCE_KEY + ":")) continue;
      let old = null;
      try { old = JSON.parse(localStorage.getItem(k)); } catch { /* corrupt */ }
      if (!old || !(Date.now() - old.t < PKCE_TTL)) localStorage.removeItem(k);
    }
    localStorage.setItem(`${PKCE_KEY}:${rec.state}`, JSON.stringify(rec));
    saved = true;
  } catch { /* blocked */ }
  return saved;
}

function takePkce(state) {
  let rec = null;
  try {
    const s = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    if (s?.state === state) rec = s;
    sessionStorage.removeItem(PKCE_KEY);
  } catch { /* blocked */ }
  try {
    const k = `${PKCE_KEY}:${state}`;
    rec ??= JSON.parse(localStorage.getItem(k) || "null");
    localStorage.removeItem(k);
  } catch { /* blocked */ }
  return rec;
}

export async function startOAuth(cfg, scope = FULL_SCOPE) {
  const clientId = cleanAppId(cfg.appId);
  if (!clientId) throw new LoginError("no_app_id", "Paste your Deriv App ID first.");
  if (!globalThis.crypto?.subtle) throw new LoginError("insecure", "This browser can't do a secure login here. Open the page in Chrome or Safari.");
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const rec = { verifier, state: randomString(32), clientId, redirectUri: redirectUri(), scope, t: Date.now() };
  if (!savePkce(rec)) throw new LoginError("storage", "This browser blocks site storage, so the login can't finish. Open the page in Chrome or Safari.");
  const url = new URL(cfg.authUrl + "/oauth2/auth");
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: rec.redirectUri,
    scope, state: rec.state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  location.assign(url.toString());
}

function describeOAuthError(code, description) {
  const said = description ? ` Deriv said: "${String(description).slice(0, 200)}"` : "";
  const text = {
    access_denied: "The Deriv login was cancelled.",
    invalid_scope: "Deriv refused the permissions the bot asked for.",
    invalid_client: "Deriv didn't accept this App ID. Check that you copied the App ID of your OAuth app.",
    unauthorized_client: "Deriv didn't accept this App ID for this kind of login. Check that the app is the OAuth type.",
    invalid_grant: "The login code expired or was already used. Please tap Log in again.",
    invalid_request: "Deriv rejected the login request.",
    temporarily_unavailable: "Deriv's login is busy right now. Please try again in a minute.",
    server_error: "Deriv's login had an error. Please try again in a minute.",
  }[code] || `The Deriv login failed (${code}).`;
  return text + said;
}

/** If this page load is the OAuth redirect, exchanges the code for a token. */
export async function finishOAuth(cfg) {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return null;
  history.replaceState(null, "", redirectUri());
  const rec = q.get("state") ? takePkce(q.get("state")) : null;
  if (q.has("error")) {
    const code = q.get("error");
    throw new LoginError(code, describeOAuthError(code, q.get("error_description")), { scope: rec?.scope, clientId: rec?.clientId });
  }
  if (!rec) throw new LoginError("no_pkce", "This login came back in a different tab or browser from the one it started in. Open the bot in Chrome or Safari and tap Log in again.");
  if (!(Date.now() - rec.t < PKCE_TTL)) throw new LoginError("expired", "That login took too long. Please tap Log in again.");
  const tokens = await exchange(cfg, {
    grant_type: "authorization_code", client_id: rec.clientId, code: q.get("code"),
    redirect_uri: rec.redirectUri, code_verifier: rec.verifier,
  });
  return toAuth(tokens, rec.clientId, rec.scope);
}

const toAuth = (t, clientId, scope) => ({
  kind: "oauth", token: t.access_token, refreshToken: t.refresh_token || null, clientId,
  scope: t.scope || scope, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
});

async function exchange(cfg, fields) {
  const opts = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
  // Deriv's docs want this done on a server, so try this site's /api/token first. If that
  // isn't there or couldn't reach Deriv, Deriv never saw the code and the page can safely
  // do the exchange itself, as Deriv's own sample apps do.
  let data = null, status = 0;
  try {
    const res = await fetch("/api/token", opts);
    if (res.headers.get("X-Tbot-Proxy")) {
      const d = await res.json().catch(() => null);
      if (d && !d.proxy_error) { data = d; status = res.status; }
    }
  } catch { /* not deployed here */ }
  if (!data) {
    try {
      const res = await fetch(cfg.authUrl + "/oauth2/token", opts);
      status = res.status;
      data = await res.json().catch(() => ({}));
    } catch (e) {
      throw new LoginError("network", `Couldn't reach Deriv to finish the login (${e.message}). Check your connection and tap Log in again.`);
    }
  }
  if (status >= 400 || !data.access_token) {
    const code = data.error || `http_${status}`;
    throw new LoginError(code, describeOAuthError(code, data.error_description || data.error_hint));
  }
  return data;
}

async function refresh(cfg, auth) {
  const next = toAuth(await exchange(cfg, { grant_type: "refresh_token", client_id: auth.clientId, refresh_token: auth.refreshToken }),
                      auth.clientId, auth.scope);
  next.refreshToken ||= auth.refreshToken;
  Object.assign(auth, next);
  cfg.onAuthChange?.(auth);
}

// ------------------------------------------------------------------- REST
/** Deriv's REST errors look like {errors: [{status, code, message}]}. */
export function apiErrorText(d) {
  const e = Array.isArray(d?.errors) ? d.errors[0] : d?.error;
  const msg = (typeof e === "string" ? e : e?.message || e?.code) || d?.message || "";
  const code = e && typeof e === "object" && e.code && e.code !== msg ? ` (${e.code})` : "";
  return String(msg).slice(0, 200) + code;
}

async function rest(cfg, auth, method, path, body, retried = false) {
  const canRefresh = auth.kind === "oauth" && auth.refreshToken && auth.clientId && !retried;
  if (canRefresh && auth.expiresAt < Date.now() + 60000) {
    try { await refresh(cfg, auth); } catch { /* the call below reports the problem */ }
  }
  const headers = { Authorization: `Bearer ${auth.token}` };
  if (auth.kind === "pat") headers["Deriv-App-ID"] = cleanAppId(cfg.appId);
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(cfg.apiUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Couldn't reach Deriv's API (${e.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 401 && canRefresh) {
    try { await refresh(cfg, auth); return await rest(cfg, auth, method, path, body, true); } catch { /* report the 401 */ }
  }
  const detail = apiErrorText(data);
  throw Object.assign(new Error(`Deriv API ${res.status}${detail ? `: ${detail}` : ""}`),
                      { status: res.status, auth: res.status === 401, detail });
}

/** Normalises an accounts answer into [{id, type: "demo"|"real", currency, balance, active}]. */
export function normalizeAccounts(data) {
  const raw = data?.data?.accounts ?? data?.data ?? data?.accounts ?? data;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && (raw.account_id || raw.id) ? [raw] : [];
  return list.map((a) => {
    const id = String(a.account_id ?? a.id ?? a.loginid ?? "");
    const typ = String(a.account_type ?? a.type ?? "").toLowerCase();
    const demo = typ ? typ.includes("demo") || typ.includes("virtual")
                     : a.is_virtual === 1 || a.is_virtual === true || /^(VRT|DOT|VR)/i.test(id);
    return { id, type: demo ? "demo" : "real", currency: a.currency ?? "USD", balance: Number(a.balance ?? NaN), active: a.status !== "inactive" };
  }).filter((a) => a.id).sort((a, b) => b.active - a.active);
}

export async function getAccounts(cfg, auth) {
  return normalizeAccounts(await rest(cfg, auth, "GET", "/trading/v1/options/accounts"));
}

/** Creates the user's demo Options account (needs the account_manage scope). */
export async function createDemoAccount(cfg, auth) {
  return normalizeAccounts(await rest(cfg, auth, "POST", "/trading/v1/options/accounts",
                                      { currency: "USD", group: "row", account_type: "demo" }));
}

export async function getTradingSocketUrl(cfg, auth, accountId) {
  const data = await rest(cfg, auth, "POST", `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`);
  const url = data?.data?.url ?? data?.url;
  if (!url) throw new Error("Deriv did not return a WebSocket address.");
  return url;
}

// -------------------------------------------------------------- WebSocket
export class DerivSocket {
  /** @param urlProvider async () => wss URL (called again on every reconnect) */
  constructor(urlProvider, { onStatus = () => {}, onError = () => {} } = {}) {
    this.urlProvider = urlProvider;
    this.onStatus = onStatus;
    this.onError = onError;
    this.nextId = 1;
    this.pending = new Map();      // req_id -> {resolve, reject}
    this.streams = new Map();      // req_id -> {request, onMessage}
    this.closedByUser = false;
    this.retry = 0;
    this.failures = 0;             // connection attempts in a row that never opened
  }

  async connect() {
    this.closedByUser = false;
    this.onStatus("connecting");
    let url, ws;
    try {
      url = await this.urlProvider();
      if (this.closedByUser) return;
      ws = new WebSocket(url);
    } catch (e) {
      this.onStatus("offline"); this.onError(e);
      if (!e.auth) this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false, ended = false;
    const end = (code, reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(openTimer);
      clearInterval(this.pingTimer);
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (this.ws !== ws) return;
      this.onStatus("offline");
      if (this.closedByUser) return;
      if (!opened && ++this.failures % 5 === 3)
        this.onError(new Error(`Can't connect to Deriv's live feed (code ${code}${reason ? `: ${reason}` : ""}). Still retrying.`));
      this.#scheduleReconnect();
    };
    const openTimer = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* ignore */ } end(4000, "timed out"); } }, 15000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(openTimer);
      this.retry = 0; this.failures = 0;
      this.onStatus("online");
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
      for (const [id, s] of this.streams) ws.send(JSON.stringify({ ...s.request, req_id: id }));
    };
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onclose = (ev) => end(ev.code, ev.reason);
    // Some browsers fire only "error" when a socket is refused; "close" normally follows it.
    ws.onerror = () => setTimeout(() => { if (ws.readyState === WebSocket.CLOSED) end(1006, "connection refused"); }, 100);
  }

  #scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const id = msg.req_id;
    const stream = this.streams.get(id);
    if (stream) {
      if (msg.subscription?.id) stream.subId = msg.subscription.id;
      if (msg.error) this.onError(new Error(msg.error.message || msg.error.code));
      stream.onMessage(msg);
    }
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || msg.error.code), { code: msg.error.code }));
      else p.resolve(msg);
    }
  }

  send(request, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("request timed out")); }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ ...request, req_id: id }));
    });
  }

  /** Streams every message for this request (and re-subscribes after reconnects). */
  subscribe(request, onMessage) {
    const id = this.nextId++;
    const full = { ...request, subscribe: 1 };
    this.streams.set(id, { request: full, onMessage });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...full, req_id: id }));
    return {
      unsubscribe: () => {
        // Deriv's "forget" needs the subscription id, which arrives with the stream's messages.
        const sub = this.streams.get(id)?.subId;
        this.streams.delete(id);
        if (sub) this.send({ forget: sub }).catch(() => {});
      },
    };
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.streams.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
