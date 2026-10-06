// The server's HTTP API, run as a real process on an ephemeral port with a temporary data
// directory. The Deriv parts talk to tools/mock-deriv.mjs with MOCK_PAT.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, cpSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "server", "main.mjs");
const PASSWORD = "correct horse battery";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TBOT_|DERIV_|MOCK_)/.test(k)));
const temps = [];
const procs = new Set();
test.after(() => {
  for (const p of procs) try { p.kill("SIGKILL"); } catch { /* gone */ }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function tempDir() { const d = mkdtempSync(join(tmpdir(), "tbot-api-")); temps.push(d); return d; }
const setPassword = (dataDir, pw) => spawnSync(process.execPath, [MAIN, "set-password"], {
  input: pw + "\n", encoding: "utf8", env: { ...cleanEnv, TBOT_DATA_DIR: dataDir } });

function freePort() {
  return new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function waitFor(proc, re, what) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${what} did not start: ${out}`)), 15000);
    const onData = (c) => { out += c; const m = out.match(re); if (m) { clearTimeout(timer); resolve({ m, out: () => out }); } };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (c) => { out += c; });
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${what} exited (${code}): ${out}`)); });
  });
}

async function startServer(dataDir, env = {}) {
  const proc = spawn(process.execPath, [MAIN], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: {
    ...cleanEnv, TBOT_DATA_DIR: dataDir, TBOT_PORT: "0", TBOT_HOST: "127.0.0.1",
    DERIV_API_URL: "http://127.0.0.1:9", DERIV_PUBLIC_WS: "ws://127.0.0.1:9/public", ...env } });
  procs.add(proc);
  let output = "";
  proc.stdout.on("data", (c) => { output += c; });
  proc.stderr.on("data", (c) => { output += c; });
  const { m } = await waitFor(proc, /listening on http:\/\/127\.0\.0\.1:(\d+)/, "server");
  const exited = new Promise((r) => proc.once("exit", (code) => { procs.delete(proc); r(code); }));
  return { proc, base: `http://127.0.0.1:${m[1]}`, output: () => output, exited,
           stop: async () => { proc.kill("SIGTERM"); return exited; } };
}

async function startMock(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [join(ROOT, "tools", "mock-deriv.mjs")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...cleanEnv, PORT: String(port), BAR_MS: "60000", ...env } });
  procs.add(proc);
  await waitFor(proc, /mock Deriv on/, "mock");
  return { port, base: `http://localhost:${port}`, stop: () => { proc.kill("SIGTERM"); procs.delete(proc); } };
}

function client(base) {
  const c = {
    cookie: "",        // the session cookie, "name=value"
    device: "",        // the known-device cookie, "name=value"
    async req(method, path, body, headers = {}) {
      const h = { ...headers };
      if ((c.cookie || c.device) && !("cookie" in h)) h.cookie = [c.cookie, c.device].filter(Boolean).join("; ");
      if (body !== undefined) { if (!("content-type" in h)) h["content-type"] = "application/json"; if (!("origin" in h)) h.origin = base; }
      for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
      let setCookie = null;
      for (const sc of res.headers.getSetCookie()) {
        const v = sc.split(";")[0];
        if (/^(__Host-)?tbot_dev=/.test(v)) c.device = v.endsWith("=") ? "" : v;
        else { setCookie = sc; c.cookie = v.endsWith("=") ? "" : v; }
      }
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, headers: res.headers, data, text, setCookie };
    },
    get: (p, h) => c.req("GET", p, undefined, h),
    post: (p, b = {}, h) => c.req("POST", p, b, h),
    login: (pw = PASSWORD, h) => c.post("/api/login", { password: pw }, h),
  };
  return c;
}

function rawGet(base, path) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ------------------------------------------------------------------ tests
test("set-password: reads stdin, writes a 0600 scrypt hash, rejects short passwords", () => {
  const dir = join(tempDir(), "data");
  const short = setPassword(dir, "short");
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /at least 10 characters/);
  assert.equal(existsSync(join(dir, "auth.json")), false);
  const ok = setPassword(dir, PASSWORD);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "Password saved.\n");
  assert.equal(ok.stderr, "");
  assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const rec = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
  assert.equal(rec.algo, "scrypt");
  assert.ok(!readFileSync(join(dir, "auth.json"), "utf8").includes(PASSWORD));
  const bad = spawnSync(process.execPath, [MAIN, "nonsense"], { encoding: "utf8", env: { ...cleanEnv, TBOT_DATA_DIR: dir } });
  assert.notEqual(bad.status, 0);
});

test("without a password: the page loads, /healthz is ok, every API call answers 503", async () => {
  const dir = tempDir();
  const srv = await startServer(dir, { TBOT_DEV: "1" });
  const c = client(srv.base);
  try {
    assert.equal((await c.get("/healthz")).text, "ok");
    const page = await c.get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    for (const [m, p] of [["GET", "/api/status"], ["GET", "/api/log"], ["POST", "/api/login"], ["POST", "/api/start"], ["GET", "/api/nothing"]]) {
      const r = await c.req(m, p, m === "POST" ? {} : undefined);
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.equal(r.data.message, "No password is set yet. Run the setup script again to set one.");
    }
    assert.match(srv.output(), /No password is set yet/);
    // Setting it with the CLI while the server runs works at once.
    assert.equal(setPassword(dir, PASSWORD).status, 0);
    assert.equal((await c.login()).status, 200);
    assert.equal((await c.get("/api/status")).status, 200);
  } finally { await srv.stop(); }
});

test("login: right and wrong password, cookie flags, sessions survive a restart, logout", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  let srv = await startServer(dir);
  const c = client(srv.base);
  try {
    assert.equal((await c.get("/api/status")).status, 401);
    const bad = await c.login("not the password");
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, "bad_password");
    assert.equal(bad.setCookie, null);
    const ok = await c.login();
    assert.equal(ok.status, 200);
    const flags = ok.setCookie.split(";").map((s) => s.trim());
    assert.match(flags[0], /^__Host-tbot_sid=[A-Za-z0-9_-]{43}$/, "the __Host- prefix: no other site can set it");
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) assert.ok(flags.includes(f), `cookie has ${f}`);
    assert.match(c.device, /^__Host-tbot_dev=[A-Za-z0-9_-]{43}$/, "a known-device cookie too");
    const st = await c.get("/api/status");
    assert.equal(st.status, 200);
    assert.equal(st.headers.get("cache-control"), "no-store");
    // A sibling *.sslip.io page can plant a plain tbot_sid with Domain=sslip.io and a longer path,
    // so it comes first. The real session must still count.
    assert.equal((await c.get("/api/status", { cookie: `tbot_sid=x; ${c.cookie}` })).status, 200, "a planted cookie can't lock the owner out");
    assert.equal((await c.get("/api/status", { cookie: `__Host-tbot_sid=x; ${c.cookie}` })).status, 200, "nor a planted copy under the same name");
    assert.equal(st.data.mode, "auto", "auto trade is the server default");
    assert.equal(st.data.running, false);
    const sid = c.cookie.split("=")[1];
    const sessions = readFileSync(join(dir, "sessions.json"), "utf8");
    assert.ok(!sessions.includes(sid), "only a hash of the session is stored");
    assert.equal(statSync(join(dir, "sessions.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);

    assert.equal(await srv.stop(), 0, "SIGTERM exits cleanly");
    srv = await startServer(dir);
    const c2 = client(srv.base);
    c2.cookie = c.cookie;
    assert.equal((await c2.get("/api/status")).status, 200, "still logged in after a restart");
    assert.equal((await c2.post("/api/logout")).status, 200);
    const old = client(srv.base);
    old.cookie = `__Host-tbot_sid=${sid}`;
    assert.equal((await old.get("/api/status")).status, 401, "logged out for real");
  } finally { await srv.stop(); }

  const dev = await startServer(dir, { TBOT_DEV: "1" });
  try {
    const r = await client(dev.base).login();
    assert.ok(!/;\s*Secure/i.test(r.setCookie), "TBOT_DEV=1 drops Secure for local http testing");
    assert.match(r.setCookie, /^tbot_sid=/, "and the __Host- prefix, which needs https");
  } finally { await dev.stop(); }
});

test("login rate limit: 5 failures per IP, 30 in total, answered with 429 and Retry-After", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_TRUST_PROXY: "1" });
  const c = client(srv.base);
  const from = (ip) => ({ "x-forwarded-for": `203.0.113.250, ${ip}` });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await c.login("wrong password", from("198.51.100.1"))).status, 401);
    const limited = await c.login(PASSWORD, from("198.51.100.1"));
    assert.equal(limited.status, 429, "even the right password waits");
    const wait = Number(limited.headers.get("retry-after"));
    assert.ok(wait > 800 && wait <= 900, `Retry-After ${wait}`);
    assert.equal((await c.login(PASSWORD, from("198.51.100.2"))).status, 200, "another IP is not blocked");
    const stranger = client(srv.base);   // no known-device cookie
    for (let ip = 3; ip <= 7; ip++) for (let i = 0; i < 5; i++) await stranger.login("wrong password", from(`198.51.100.${ip}`));
    const global = await stranger.login(PASSWORD, from("198.51.100.99"));
    assert.equal(global.status, 429, "30 failures in 15 minutes block everyone new");
    assert.ok(Number(global.headers.get("retry-after")) > 0);
    // The owner's phone logged in before (198.51.100.2 above), so it has a known-device cookie.
    const owner = client(srv.base);
    owner.device = c.device;
    assert.ok(owner.device, "known-device cookie set at login");
    assert.equal((await owner.login(PASSWORD, from("198.51.100.200"))).status, 200, "a known device is not locked out by strangers");
    // A stolen device cookie gets only 5 guesses, then it is not trusted any more.
    const thief = client(srv.base);
    thief.device = c.device;
    for (let i = 0; i < 5; i++) assert.equal((await thief.login("wrong password", from("198.51.100.201"))).status, 401);
    assert.equal((await thief.login(PASSWORD, from("198.51.100.202"))).status, 429);
    assert.equal((await owner.login(PASSWORD, from("198.51.100.203"))).status, 429, "that device cookie is dropped");
  } finally { await srv.stop(); }
});

test("login rate limit: IPv6 addresses in the same /64 share one limit", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_TRUST_PROXY: "1" });
  const c = client(srv.base);
  const from = (ip) => ({ "x-forwarded-for": ip });
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await c.login("wrong password", from(`2001:db8:1:2::${i}`))).status, 401);
    assert.equal((await c.login(PASSWORD, from("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).status, 429, "same /64");
    assert.equal((await c.login(PASSWORD, from("2001:db8:1:3::1"))).status, 200, "another /64 is fine");
  } finally { await srv.stop(); }
});

test("a proxy that hides the site name gets a clear message, and changing the password ignores strangers' wrong logins", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_TRUST_PROXY: "1" });
  const c = client(srv.base);
  try {
    const r = await c.login(PASSWORD, { origin: "https://bot.example.com" });
    assert.equal(r.status, 403);
    assert.match(r.data.message, /proxy_set_header Host \$host/);
    assert.equal((await c.login(PASSWORD, { origin: "https://bot.example.com", "x-forwarded-host": "bot.example.com" })).status, 200);
    const h = { origin: "https://bot.example.com", "x-forwarded-host": "bot.example.com" };
    for (let ip = 1; ip <= 7; ip++) for (let i = 0; i < 5; i++) await client(srv.base).login("wrong password", { ...h, "x-forwarded-for": `198.51.100.${ip}` });
    assert.equal((await c.post("/api/password", { current: PASSWORD, next: "a brand new password" }, h)).status, 200);
  } finally { await srv.stop(); }
});

test("requests that change something need POST, JSON, the same origin and a small body", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_DEV: "1" });
  const c = client(srv.base);
  try {
    assert.equal((await c.login(PASSWORD, { origin: "https://evil.example" })).status, 403, "login CSRF blocked");
    assert.equal((await c.login()).status, 200);
    assert.equal((await c.post("/api/stop", {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await c.post("/api/stop", {}, { origin: srv.base.replace("127.0.0.1", "localhost") })).status, 403);
    assert.equal((await c.post("/api/stop", {}, { origin: "null" })).status, 403);
    assert.equal((await c.req("POST", "/api/stop", "{}", { "content-type": "application/json", origin: undefined })).status, 403, "no Origin header");
    assert.equal((await c.post("/api/stop", {}, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await c.post("/api/stop", "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await c.post("/api/stop", "a=1", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await c.get("/api/stop")).status, 405);
    assert.equal((await c.post("/api/stop", "{bad json")).status, 400);
    assert.equal((await c.post("/api/stop", "[1]")).status, 400);
    assert.equal((await c.post("/api/settings", { riskPct: 1, pad: "x".repeat(17 * 1024) })).status, 413);
    assert.equal((await c.get("/api/unknown")).status, 404);
    assert.equal((await c.post("/api/stop", {})).status, 200, "a proper request works");
    assert.equal((await c.post("/api/stop", {}, { cookie: "" })).status, 401, "and needs the session");
    const s = await c.post("/api/settings", { riskPct: 99, maxDailyLossPct: 0, symbol: "R_10" });
    assert.equal(s.status, 200);
    assert.equal(s.data.settings.riskPct, 5);
    assert.equal(s.data.settings.maxDailyLossPct, 0.5);
    assert.equal((await c.post("/api/settings", { mode: "yolo" })).status, 400);
    const real = await c.post("/api/settings", { allowReal: true });
    assert.equal(real.status, 400);
    assert.match(real.data.message, /type REAL/);
    assert.equal((await c.post("/api/settings", { allowReal: true, confirmReal: "REAL" })).data.settings.allowReal, true);
    const start = await c.post("/api/start", {});
    assert.equal(start.status, 409, "auto trade without a token is refused");
    assert.match(start.data.message, /Deriv token/);
  } finally { await srv.stop(); }
});

test("security headers on every response; HSTS only over https from the local proxy", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_TRUST_PROXY: "1" });
  const c = client(srv.base);
  try {
    for (const p of ["/", "/control.js", "/api/status", "/nope.html", "/healthz"]) {
      const r = await c.get(p);
      assert.equal(r.headers.get("content-security-policy"), CSP, p);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", p);
      assert.equal(r.headers.get("strict-transport-security"), null, `${p} over http`);
    }
    const https = await c.get("/", { "x-forwarded-proto": "https" });
    assert.match(https.headers.get("strict-transport-security"), /max-age=\d+/);
    assert.equal((await c.get("/api/status")).headers.get("cache-control"), "no-store");
    const page = await c.get("/");
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>|\son[a-z]+\s*=/i.test(page.text), "no inline scripts or handlers");
    assert.ok(!/style="/i.test(page.text), "no inline styles");
  } finally { await srv.stop(); }
});

test("static files: only server/public, no path tricks", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir);
  try {
    const js = await rawGet(srv.base, "/control.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /text\/javascript/);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fpackage.json",
                     "/..%5cpackage.json", "/../server/main.mjs", "/%2E%2E/server/main.mjs", "/control.js%00.css", "/.tbot-data/auth.json",
                     "/%2e%2e/.tbot-data/auth.json", "/api/../../package.json", "/public/js/config.js", "/main.mjs", "//etc/passwd"]) {
      const r = await rawGet(srv.base, p);
      assert.ok(r.status === 404 || r.status === 400 || r.status === 503, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes("tbot-web") && !r.body.includes("scrypt") && !r.body.includes("root:"), `${p} leaked`);
    }
    assert.equal((await rawGet(srv.base, "/index.html")).status, 200);
    assert.equal((await client(srv.base).req("DELETE", "/index.html")).status, 405);
  } finally { await srv.stop(); }
});

test("the mock accepts MOCK_PAT only with a Deriv-App-ID header", async () => {
  const mock = await startMock({ MOCK_PAT: "pat_only_for_tests" });
  try {
    const url = `${mock.base}/trading/v1/options/accounts`;
    let r = await fetch(url, { headers: { Authorization: "Bearer pat_only_for_tests" } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).errors[0].message, "Deriv-App-ID header is required for PAT tokens");
    r = await fetch(url, { headers: { Authorization: "Bearer pat_only_for_tests", "Deriv-App-ID": "1" } });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).data.length >= 1);
    r = await fetch(url, { headers: { Authorization: "Bearer another", "Deriv-App-ID": "1" } });
    assert.equal(r.status, 401);
  } finally { mock.stop(); }
});

test("Deriv token: checked, saved privately, never returned; trading resumes after SIGTERM", async () => {
  const TOKEN = "pat_api_SECRET_9f8e7d6c";
  const mock = await startMock({ MOCK_PAT: TOKEN });
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const env = { TBOT_DEV: "1", DERIV_API_URL: mock.base, DERIV_PUBLIC_WS: `ws://localhost:${mock.port}/trading/v1/options/ws/public` };
  let srv = await startServer(dir, env);
  const c = client(srv.base);
  try {
    await c.login();
    let r = await c.post("/api/deriv", { appId: "1234", token: "pat_wrong_000000" });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /did not accept/);
    assert.equal(existsSync(join(dir, "secret.json")), false);
    r = await c.post("/api/deriv", { appId: "1234", token: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.account.id, "DOT90000001", "demo account by default");
    assert.deepEqual(r.data.accounts.map((a) => a.type).sort(), ["demo", "real"]);
    assert.ok(!r.text.includes(TOKEN));
    assert.equal(statSync(join(dir, "secret.json")).mode & 0o777, 0o600);
    const st = await until(async () => { const s = await c.get("/api/status"); return s.data.connection === "online" && s.data.balance !== null && s; });
    assert.ok(!st.text.includes(TOKEN));
    assert.equal(st.data.tokenHint, "7d6c");
    assert.equal(st.data.account.type, "demo");
    assert.equal(st.data.balance, 10000);
    const acc = await c.get("/api/accounts?refresh=1");
    assert.equal(acc.status, 200);
    assert.ok(!acc.text.includes(TOKEN));
    assert.equal((await c.post("/api/account", { id: "ROT10000001" })).status, 403, "real money needs permission");
    assert.equal((await c.post("/api/account", { id: "NOPE" })).status, 404);
    assert.equal((await c.post("/api/close", { id: "12345" })).status, 404);
    assert.deepEqual((await c.post("/api/close-all", {})).data, { ok: true, count: 0 });
    const start = await c.post("/api/start", {});
    assert.equal(start.status, 200);
    assert.equal(start.data.running, true);

    assert.equal(await srv.stop(), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).running, true, "SIGTERM keeps running=true");
    srv = await startServer(dir, env);
    const c2 = client(srv.base);
    c2.cookie = c.cookie;
    const back = await until(async () => { const s = await c2.get("/api/status"); return s.data.connection === "online" && s; });
    assert.equal(back.data.running, true, "resumed by itself");
    const log = await c2.get("/api/log?after=0");
    assert.ok(log.data.entries.some((e) => e.title === "Resumed after a restart"));
    const after = await c2.get(`/api/log?after=${log.data.last}`);
    assert.deepEqual(after.data.entries, []);

    assert.equal((await c2.post("/api/deriv/forget", {})).status, 200);
    const gone = await c2.get("/api/status");
    assert.equal(gone.data.hasToken, false);
    assert.equal(gone.data.running, false);
    assert.equal(existsSync(join(dir, "secret.json")), false);
    for (const f of ["log.jsonl", "state.json", "settings.json", "sessions.json", "guard.json"])
      if (existsSync(join(dir, f))) assert.ok(!readFileSync(join(dir, f), "utf8").includes(TOKEN), f);
    assert.ok(!srv.output().includes(TOKEN), "never printed");
  } finally { await srv.stop(); mock.stop(); }
});

test("changing the password logs out other devices", async () => {
  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_DEV: "1" });
  const a = client(srv.base), b = client(srv.base);
  try {
    await a.login(); await b.login();
    assert.equal((await a.post("/api/password", { current: "wrong one!!", next: "a brand new password" })).status, 400);
    assert.equal((await a.post("/api/password", { current: PASSWORD, next: "short" })).status, 400);
    assert.equal((await a.post("/api/password", { current: PASSWORD, next: "a brand new password" })).status, 200);
    assert.equal((await a.get("/api/status")).status, 200, "this device stays logged in");
    assert.equal((await b.get("/api/status")).status, 401, "the other device is logged out");
    assert.equal((await b.login(PASSWORD)).status, 401);
    assert.equal((await b.login("a brand new password")).status, 200);
    // The setup script's set-password also logs everyone out.
    assert.equal(setPassword(dir, "set again from the cli").status, 0);
    assert.equal((await a.get("/api/status")).status, 401);
  } finally { await srv.stop(); }
});

test("update: a version that can't start is rolled back; a good one is pulled with --ff-only and restarts", async () => {
  const base = tempDir();
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args],
                                             { cwd, encoding: "utf8", env: { ...cleanEnv, GIT_TERMINAL_PROMPT: "0" } }).trim();
  const remote = join(base, "remote.git"), work = join(base, "work"), app = join(base, "app");
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", work);
  // A real copy of the server code, so the update's self-test runs what was pulled.
  for (const d of ["server", "public/js", "public/model"]) cpSync(join(ROOT, d), join(work, d), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(work, "package.json"));
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "one"); git(work, "push", "-q", remote, "HEAD:main");
  const one = git(work, "rev-parse", "HEAD");
  git(base, "clone", "-q", remote, app);
  const publish = (msg, change) => { git(work, "reset", "-q", "--hard", one); change(); git(work, "commit", "-q", "-am", msg); git(work, "push", "-q", "-f", remote, "HEAD:main"); return git(work, "rev-parse", "HEAD"); };

  const dir = tempDir();
  setPassword(dir, PASSWORD);
  const srv = await startServer(dir, { TBOT_DEV: "1", TBOT_GIT_DIR: app });
  const c = client(srv.base);
  await c.login();

  // 1. A shared browser module gains a browser-only line: the new version would crash at start.
  publish("browser only", () => appendFileSync(join(work, "public/js/config.js"), "\nwindow.addEventListener(\"load\", () => {});\n"));
  const check = await c.get("/api/update");
  assert.equal(check.status, 200);
  assert.equal(check.data.ahead, true);
  assert.equal(check.data.behind, 1);
  assert.equal(check.data.commit, one.slice(0, 10));
  const bad = await c.post("/api/update", {});
  assert.equal(bad.status, 502);
  assert.equal(bad.data.message, "The update didn't work. The bot keeps running the current version.");
  assert.equal(git(app, "rev-parse", "HEAD"), one, "rolled back");
  assert.equal(git(app, "status", "--porcelain"), "", "nothing left over");
  assert.equal((await c.get("/api/status")).status, 200, "still running");
  const log = (await c.get("/api/log")).data.entries.map((e) => `${e.title}: ${e.detail}`).join("\n");
  assert.match(log, /went back to its current version: ReferenceError: window is not defined/);

  // 2. An update that needs new npm packages: refused, the setup line must be run.
  publish("deps", () => {
    const pkg = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ ...pkg, dependencies: { leftpad: "1.0.0" } }, null, 2));
  });
  const deps = await c.post("/api/update", {});
  assert.equal(deps.status, 502);
  assert.match(deps.data.message, /setup line/);
  assert.equal(git(app, "rev-parse", "HEAD"), one);

  // 3. A good update: pulled, checked, then the process exits so systemd starts it.
  const good = publish("two", () => writeFileSync(join(work, "a.txt"), "two\n"));
  const up = await c.post("/api/update", {});
  assert.equal(up.status, 200);
  assert.equal(up.data.updated, true);
  assert.equal(await srv.exited, 0, "exits so systemd starts the new version");
  assert.equal(git(app, "rev-parse", "HEAD"), good);

  const again = await startServer(dir, { TBOT_DEV: "1", TBOT_GIT_DIR: app });
  try {
    const c2 = client(again.base);
    c2.cookie = c.cookie;
    const r = await c2.post("/api/update", {});
    assert.equal(r.data.updated, false);
    assert.equal((await c2.get("/api/update")).data.ahead, false);
  } finally { await again.stop(); }
});
