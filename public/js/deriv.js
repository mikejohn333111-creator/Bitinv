// Deriv API client for the browser: OAuth 2.0 (PKCE) or personal-access-token
// login, the Options accounts REST API, and a WebSocket wrapper with
// request/response matching, subscriptions, keep-alive and reconnects.
//
// Flow (new Deriv API, developers.deriv.com):
//   1. Log in: OAuth at auth.deriv.com -> access token  (or the user pastes a PAT)
//   2. GET  {API}/trading/v1/options/accounts           -> demo / real accounts
//   3. POST {API}/trading/v1/options/accounts/{id}/otp  -> one-time WebSocket URL
//   4. WebSocket: balance, ticks_history, contracts_for, proposal, buy, sell, ...
// Market data without logging in uses the public WebSocket.

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function randomString(n = 64) {
  return b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);
}

export const redirectUri = () => location.origin + location.pathname;

// ------------------------------------------------------------------ login
export async function startOAuth(cfg) {
  if (!cfg.appId) throw new Error("Add your Deriv App ID in Settings first.");
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(24);
  sessionStorage.setItem("tbot:pkce", JSON.stringify({ verifier, state }));
  const url = new URL(cfg.authUrl + "/oauth2/auth");
  url.search = new URLSearchParams({
    response_type: "code", client_id: cfg.appId, redirect_uri: redirectUri(),
    scope: "trade account_manage", state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  location.assign(url.toString());
}

/** If this page load is the OAuth redirect, exchanges the code for a token. */
export async function finishOAuth(cfg) {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return null;
  history.replaceState(null, "", redirectUri());
  if (q.has("error")) throw new Error(`Deriv login was cancelled or failed (${q.get("error")}).`);
  const saved = JSON.parse(sessionStorage.getItem("tbot:pkce") || "null");
  sessionStorage.removeItem("tbot:pkce");
  if (!saved || saved.state !== q.get("state")) throw new Error("Login check failed (state mismatch). Please log in again.");
  const res = await fetch(cfg.authUrl + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: cfg.appId, code: q.get("code"),
      redirect_uri: redirectUri(), code_verifier: saved.verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Token exchange failed (${res.status}) ${data.error_description || data.error || ""}`);
  return { kind: "oauth", token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
}

// ------------------------------------------------------------------- REST
async function rest(cfg, auth, method, path) {
  const headers = { Authorization: `Bearer ${auth.token}` };
  if (auth.kind === "pat") headers["Deriv-App-ID"] = cfg.appId;
  const res = await fetch(cfg.apiUrl + path, { method, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("Your Deriv session has expired. Please log in again."), { auth: true });
  if (!res.ok) throw new Error(`Deriv API ${res.status}: ${data?.error?.message || data?.message || JSON.stringify(data).slice(0, 160)}`);
  return data;
}

/** Normalises the accounts list into [{id, type: "demo"|"real", currency, balance}]. */
export async function getAccounts(cfg, auth) {
  const data = await rest(cfg, auth, "GET", "/trading/v1/options/accounts");
  const raw = data?.data?.accounts ?? data?.data ?? data?.accounts ?? data;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((a) => {
    const id = String(a.account_id ?? a.id ?? a.loginid ?? "");
    const typ = String(a.account_type ?? a.type ?? "").toLowerCase();
    const demo = typ.includes("demo") || typ.includes("virtual") || a.is_virtual === 1 || a.is_virtual === true || /^(VRT|DOT|VR)/i.test(id);
    return { id, type: demo ? "demo" : "real", currency: a.currency ?? "USD", balance: Number(a.balance ?? NaN) };
  }).filter((a) => a.id);
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
  }

  async connect() {
    this.closedByUser = false;
    this.onStatus("connecting");
    let url;
    try { url = await this.urlProvider(); }
    catch (e) { this.onStatus("offline"); this.onError(e); if (!e.auth) this.#scheduleReconnect(); return; }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus("online");
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
      for (const [id, s] of this.streams) ws.send(JSON.stringify({ ...s.request, req_id: id }));
    };
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (this.ws !== ws) return;
      this.onStatus("offline");
      if (!this.closedByUser) this.#scheduleReconnect();
    };
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
