// The Deriv login pieces that run without a browser: the /api/token function and
// the account/error handling in public/js/deriv.js. fetch is replaced by a stub.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DERIV_AUTH_URL = "https://auth.example";
const { POST } = await import("../api/token.js");
const { normalizeAccounts, apiErrorText, cleanAppId, getAccounts, createDemoAccount, hasScope } = await import("../public/js/deriv.js");

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts, calls.length); };
  return calls;
}
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (form) => POST(new Request("https://site/api/token", { method: "POST", body: new URLSearchParams(form).toString() }));
test.afterEach(() => { globalThis.fetch = realFetch; });

test("token function forwards only the OAuth fields to Deriv", async () => {
  const calls = stubFetch(() => jsonRes(200, { access_token: "ory_at_x", expires_in: 3600, token_type: "Bearer" }));
  const res = await post({ grant_type: "authorization_code", client_id: "abc123", code: "c1", redirect_uri: "https://site/",
                           code_verifier: "v".repeat(64), extra: "dropped" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Tbot-Proxy"), "1");
  assert.equal((await res.json()).access_token, "ory_at_x");
  assert.equal(calls[0].url, "https://auth.example/oauth2/token");
  const sent = new URLSearchParams(calls[0].opts.body);
  assert.deepEqual([...sent.keys()].sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
});

test("token function passes Deriv's OAuth errors through", async () => {
  stubFetch(() => jsonRes(400, { error: "invalid_grant", error_description: "expired" }));
  const res = await post({ grant_type: "authorization_code", client_id: "abc", code: "c", redirect_uri: "https://site/", code_verifier: "v" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("token function marks answers that never reached Deriv's OAuth server", async () => {
  stubFetch(() => new Response("<html>blocked</html>", { status: 403 }));
  let res = await post({ grant_type: "refresh_token", client_id: "abc", refresh_token: "r" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).proxy_error, "upstream_not_oauth");
  stubFetch(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }); });
  res = await post({ grant_type: "refresh_token", client_id: "abc", refresh_token: "r" });
  assert.equal((await res.json()).proxy_error, "upstream_unreachable");
});

test("token function never lets the page resend a code Deriv may have used", async () => {
  stubFetch(() => { throw new DOMException("The operation timed out.", "TimeoutError"); });
  let res = await post({ grant_type: "authorization_code", client_id: "abc", code: "c", redirect_uri: "https://site/", code_verifier: "v" });
  assert.equal(res.status, 504);
  assert.deepEqual(Object.keys(await res.json()).sort(), ["error", "error_description"]);
  stubFetch(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }); });
  res = await post({ grant_type: "authorization_code", client_id: "abc", code: "c", redirect_uri: "https://site/", code_verifier: "v" });
  assert.equal((await res.json()).error, "temporarily_unavailable");
});

test("a 404 'AccountNotFound' list means no accounts yet; other 404s are errors", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: "abc" };
  const auth = { kind: "oauth", token: "t", expiresAt: Date.now() + 3600e3 };
  stubFetch(() => jsonRes(404, { errors: [{ status: 404, code: "AccountNotFound", message: "Resource not found" }] }));
  assert.deepEqual(await getAccounts(cfg, auth), []);
  stubFetch(() => jsonRes(404, { errors: [{ status: 404, code: "RouteMissing", message: "No route" }] }));
  await assert.rejects(getAccounts(cfg, auth), /404/);
});

test("overlapping calls share one token refresh", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: "abc" };
  const auth = { kind: "oauth", token: "old", refreshToken: "r1", clientId: "abc", scope: "trade", expiresAt: Date.now() - 1000 };
  let refreshes = 0;
  globalThis.fetch = async (url, opts) => {
    if (url === "/api/token") { refreshes++; await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600, refresh_token: "r2" }), { status: 200, headers: { "X-Tbot-Proxy": "1" } }); }
    return opts.headers.Authorization === "Bearer new" ? jsonRes(200, { data: [{ account_id: "D1", account_type: "demo" }] })
                                                       : jsonRes(401, { errors: [{ code: "InvalidToken", message: "expired" }] });
  };
  const [a, b] = await Promise.all([getAccounts(cfg, auth), getAccounts(cfg, auth)]);
  assert.equal(a[0].id, "D1"); assert.equal(b[0].id, "D1");
  assert.equal(refreshes, 1);
});

test("when the refresh works but the retried call fails, that call's own error is reported", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: "abc" };
  const auth = { kind: "oauth", token: "old", refreshToken: "r1", clientId: "abc", scope: "trade", expiresAt: Date.now() + 3600e3 };
  globalThis.fetch = async (url, opts) => {
    if (url === "/api/token") return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200, headers: { "X-Tbot-Proxy": "1" } });
    return opts.headers.Authorization === "Bearer new" ? jsonRes(503, { errors: [{ code: "Busy", message: "try later" }] })
                                                       : jsonRes(401, { errors: [{ code: "InvalidToken", message: "expired" }] });
  };
  await assert.rejects(getAccounts(cfg, auth), (e) => e.status === 503 && !e.auth);
});

test("token function rejects anything but a code or refresh exchange", async () => {
  const calls = stubFetch(() => jsonRes(200, {}));
  assert.equal((await post({ grant_type: "password", client_id: "abc" })).status, 400);
  assert.equal((await post({ grant_type: "authorization_code", client_id: "a b", code: "c", redirect_uri: "r", code_verifier: "v" })).status, 400);
  assert.equal((await post({ grant_type: "authorization_code", client_id: "abc", code: "c" })).status, 400);
  assert.equal(calls.length, 0, "nothing was sent to Deriv");
});

test("accounts follow Deriv's account_type, not the ID prefix", () => {
  const list = normalizeAccounts({ data: [
    { account_id: "DOT1", account_type: "real", currency: "USD", balance: 5, status: "active" },
    { account_id: "X2", account_type: "demo", currency: "USD", balance: 10000, status: "inactive" },
    { account_id: "X3", account_type: "demo", currency: "USD", balance: 9000, status: "active" },
  ] });
  assert.deepEqual(list.map((a) => [a.id, a.type, a.active]), [["DOT1", "real", true], ["X3", "demo", true], ["X2", "demo", false]]);
  assert.equal(normalizeAccounts({ data: { account_id: "DOT9", account_type: "demo" } })[0].id, "DOT9", "single object (create, 200)");
  assert.deepEqual(normalizeAccounts({ data: [], meta: {} }), []);
  assert.equal(normalizeAccounts({ data: [{ loginid: "VRTC1", is_virtual: 1 }] })[0].type, "demo", "older shape still read");
});

test("REST errors show Deriv's message", () => {
  assert.equal(apiErrorText({ errors: [{ status: 403, code: "AccessDenied", message: "Missing scope" }] }), "Missing scope (AccessDenied)");
  assert.equal(apiErrorText({ error: { message: "nope" } }), "nope");
  assert.equal(apiErrorText({}), "");
});

test("App IDs lose pasted spaces and invisible characters", () => {
  assert.equal(cleanAppId(" ​32izC2lBT4﻿MmiSNWuxq2l \n"), "32izC2lBT4MmiSNWuxq2l");
  assert.equal(cleanAppId(undefined), "");
  assert.ok(hasScope({ scope: "trade account_manage" }, "account_manage"));
  assert.ok(!hasScope({ scope: "trade" }, "account_manage"));
});

test("an expired OAuth token is refreshed once and the call retried", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: "abc", changed: 0 };
  cfg.onAuthChange = () => cfg.changed++;
  const auth = { kind: "oauth", token: "old", refreshToken: "r1", clientId: "abc", scope: "trade", expiresAt: Date.now() + 3600e3 };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (url === "/api/token") return new Response(JSON.stringify({ access_token: "new", expires_in: 3600, refresh_token: "r2" }),
                                                  { status: 200, headers: { "X-Tbot-Proxy": "1" } });
    return opts.headers.Authorization === "Bearer new" ? jsonRes(200, { data: [{ account_id: "D1", account_type: "demo" }] })
                                                       : jsonRes(401, { errors: [{ code: "InvalidToken", message: "expired" }] });
  };
  const list = await getAccounts(cfg, auth);
  assert.equal(list[0].id, "D1");
  assert.equal(auth.token, "new");
  assert.equal(auth.refreshToken, "r2");
  assert.equal(cfg.changed, 1);
  assert.equal(new URLSearchParams(calls.find((c) => c.url === "/api/token").opts.body).get("grant_type"), "refresh_token");
});

test("a 401 without a refresh token is reported, not retried", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: "abc" };
  const calls = stubFetch(() => jsonRes(401, { errors: [{ code: "InvalidToken", message: "Invalid or expired token" }] }));
  await assert.rejects(getAccounts(cfg, { kind: "oauth", token: "t", expiresAt: Date.now() + 3600e3 }),
                       (e) => e.status === 401 && e.auth === true && /Invalid or expired token/.test(e.message));
  assert.equal(calls.length, 1);
});

test("a personal token sends the App ID header; creating a demo account sends Deriv's fields", async () => {
  const cfg = { apiUrl: "https://api.example", authUrl: "https://auth.example", appId: " abc​" };
  const calls = stubFetch(() => jsonRes(201, { data: [{ account_id: "DOT5", account_type: "demo", balance: 10000 }] }));
  const list = await createDemoAccount(cfg, { kind: "pat", token: "pat_1" });
  assert.equal(list[0].id, "DOT5");
  assert.equal(calls[0].opts.headers["Deriv-App-ID"], "abc");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { currency: "USD", group: "row", account_type: "demo" });
});
