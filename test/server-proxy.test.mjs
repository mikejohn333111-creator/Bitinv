// TBOT_PROXY_IPS (extra trusted proxies, such as a Caddy container) and TBOT_EXTRA_HOST
// (a second address to listen on, such as the Docker network's gateway).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { parseProxyList, parseCidr, ipv4ToInt } from "../server/proxy-ips.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "server", "main.mjs");
const PASSWORD = "correct horse battery";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TBOT_|DERIV_|MOCK_)/.test(k)));
const temps = [];
const procs = new Set();
test.after(() => {
  for (const p of procs) try { p.kill("SIGKILL"); } catch { /* gone */ }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- CIDR matching
test("TBOT_PROXY_IPS: IPv4 addresses and CIDR ranges", () => {
  assert.equal(ipv4ToInt("172.18.0.1"), 0xac120001);
  assert.equal(ipv4ToInt("::ffff:10.0.0.1"), 0x0a000001);
  assert.equal(ipv4ToInt("256.1.1.1"), null);
  assert.equal(ipv4ToInt("::1"), null);
  assert.equal(ipv4ToInt(""), null);
  assert.deepEqual(parseCidr("172.18.5.9/16"), { base: 0xac120000, mask: 0xffff0000 });
  assert.deepEqual(parseCidr("10.1.2.3"), { base: 0x0a010203, mask: 0xffffffff });
  assert.deepEqual(parseCidr("0.0.0.0/0"), { base: 0, mask: 0 });
  for (const bad of ["172.18.0.0/33", "172.18.0.0/x", "172.18.0.0/", "1.2.3/8", "fd00::/8", "1.2.3.4/8/9", "::ffff:1.2.3.4"])
    assert.equal(parseCidr(bad), null, bad);

  const l = parseProxyList(" 172.18.0.0/16, 10.9.8.7 ,, nonsense, 192.168.1.0/33");
  assert.equal(l.ranges.length, 2);
  assert.deepEqual(l.bad, ["nonsense", "192.168.1.0/33"]);
  assert.ok(l.has("172.18.0.2"));
  assert.ok(l.has("172.18.255.255"));
  assert.ok(l.has("::ffff:172.18.3.4"), "IPv4-mapped IPv6 form, as Node reports on a dual-stack socket");
  assert.ok(l.has("10.9.8.7"));
  assert.ok(!l.has("10.9.8.8"));
  assert.ok(!l.has("172.19.0.2"));
  assert.ok(!l.has("172.17.255.255"));
  assert.ok(!l.has("::1"));
  assert.ok(!l.has(undefined));
  assert.ok(!parseProxyList("").has("127.0.0.1"));
  assert.ok(!parseProxyList(undefined).has("172.18.0.2"));
  assert.ok(parseProxyList("172.18.0.1/24").has("172.18.0.200"), "a host address with a prefix means its whole network");
});

// ---------------------------------------------------------------- a real server
function tempDir() { const d = mkdtempSync(join(tmpdir(), "tbot-proxy-")); temps.push(d); return d; }
const setPassword = (dataDir) => spawnSync(process.execPath, [MAIN, "set-password"], {
  input: PASSWORD + "\n", encoding: "utf8", env: { ...cleanEnv, TBOT_DATA_DIR: dataDir } });
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function startServer(env) {
  const dir = tempDir();
  setPassword(dir);
  const proc = spawn(process.execPath, [MAIN], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: {
    ...cleanEnv, TBOT_DATA_DIR: dir, TBOT_PORT: "0", TBOT_HOST: "127.0.0.1",
    DERIV_API_URL: "http://127.0.0.1:9", DERIV_PUBLIC_WS: "ws://127.0.0.1:9/public", ...env } });
  procs.add(proc);
  let out = "";
  const waiters = [];
  const onData = (c) => { out += c; for (const w of [...waiters]) if (w.re.test(out)) { waiters.splice(waiters.indexOf(w), 1); w.done(); } };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  const exited = new Promise((r) => proc.once("exit", (code) => { procs.delete(proc); r(code); }));
  const waitLog = (re, ms = 15000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve();
    const t = setTimeout(() => reject(new Error(`no ${re} in: ${out}`)), ms);
    waiters.push({ re, done: () => { clearTimeout(t); resolve(); } });
  });
  await waitLog(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
  const port = Number(out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)[1]);
  return { port, waitLog, output: () => out, exited, stop: async () => { proc.kill("SIGTERM"); return exited; } };
}

/** An HTTP request from a chosen local address (all of 127.0.0.0/8 is local on Linux). */
function req({ host, port, from, method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
    if (data !== undefined) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); h.origin ??= `http://${host}:${port}`; }
    const r = http.request({ host, port, localAddress: from, method, path, headers: h, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

test("TBOT_EXTRA_HOST: the bot also answers on the extra address, same port", async () => {
  const srv = await startServer({ TBOT_EXTRA_HOST: "127.0.0.2" });
  try {
    await srv.waitLog(/Also listening on http:\/\/127\.0\.0\.2:(\d+)/);
    assert.match(srv.output(), new RegExp(`Also listening on http://127\\.0\\.0\\.2:${srv.port}\\b`));
    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const r = await req({ host, port: srv.port, path: "/healthz" });
      assert.equal(r.status, 200, host);
      assert.equal(r.text, "ok", host);
    }
    await assert.rejects(req({ host: "127.0.0.3", port: srv.port, path: "/healthz" }), /ECONNREFUSED/, "not on every address");
  } finally { assert.equal(await srv.stop(), 0, "both listeners close on SIGTERM"); }
});

test("TBOT_EXTRA_HOST: a failed bind is logged and retried, and the main address keeps working", async () => {
  const port = await freePort();
  // Something else holds 127.0.0.4 on that port at first, like a Docker network that isn't up yet.
  const blocker = net.createServer().listen(port, "127.0.0.4");
  await new Promise((r) => blocker.once("listening", r));
  const srv = await startServer({ TBOT_PORT: String(port), TBOT_EXTRA_HOST: "127.0.0.4", TBOT_EXTRA_RETRY_MS: "200" });
  try {
    await srv.waitLog(/Can't listen on 127\.0\.0\.4:\d+ as well \(EADDRINUSE\)\. Trying again/);
    assert.equal((await req({ host: "127.0.0.1", port, path: "/healthz" })).text, "ok", "the main listener is not affected");
    await new Promise((r) => blocker.close(r));
    await srv.waitLog(/Also listening on http:\/\/127\.0\.0\.4:\d+/);
    assert.equal((await req({ host: "127.0.0.4", port, path: "/healthz" })).text, "ok");
    assert.equal(srv.output().match(/Can't listen/g).length, 1, "the failure is not logged on every try");
  } finally { blocker.close(); await srv.stop(); }
});

test("TBOT_EXTRA_HOST: an address this server doesn't have never stops the bot", async () => {
  const srv = await startServer({ TBOT_EXTRA_HOST: "192.0.2.1", TBOT_EXTRA_RETRY_MS: "100" });
  try {
    await srv.waitLog(/Can't listen on 192\.0\.2\.1:\d+ as well \((EADDRNOTAVAIL|EACCES)\)/);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await req({ host: "127.0.0.1", port: srv.port, path: "/healthz" })).text, "ok");
  } finally { assert.equal(await srv.stop(), 0); }
});

test("TBOT_PROXY_IPS: forwarded headers count only from a trusted address", async () => {
  // The "container" sends from 127.0.0.9 (inside 127.0.0.8/29); 127.0.0.20 is anyone else.
  const srv = await startServer({ TBOT_TRUST_PROXY: "1", TBOT_EXTRA_HOST: "127.0.0.2", TBOT_PROXY_IPS: "127.0.0.8/29, bogus" });
  const at = { host: "127.0.0.2", port: srv.port };
  const login = (from, ip, password = "wrong password") =>
    req({ ...at, from, method: "POST", path: "/api/login", headers: { "x-forwarded-for": ip }, body: { password } });
  try {
    await srv.waitLog(/Also listening/);
    assert.match(srv.output(), /TBOT_PROXY_IPS: ignored "bogus"/);
    // X-Forwarded-Proto: https turns on HSTS only from the trusted proxy.
    const trusted = await req({ ...at, from: "127.0.0.9", headers: { "x-forwarded-proto": "https" } });
    assert.match(trusted.headers["strict-transport-security"] || "", /max-age=\d+/, "trusted proxy: https is honoured");
    const other = await req({ ...at, from: "127.0.0.20", headers: { "x-forwarded-proto": "https" } });
    assert.equal(other.headers["strict-transport-security"], undefined, "anyone else: ignored");

    // X-Forwarded-For: from the proxy, each visitor gets their own login limit...
    for (let i = 0; i < 5; i++) assert.equal((await login("127.0.0.9", "198.51.100.1")).status, 401);
    assert.equal((await login("127.0.0.9", "198.51.100.1")).status, 429, "visitor 1 is limited");
    assert.equal((await login("127.0.0.9", "198.51.100.2", PASSWORD)).status, 200, "visitor 2 is not");
    // ...from anyone else the header is ignored, so changing it doesn't escape the limit.
    for (let i = 0; i < 5; i++) assert.equal((await login("127.0.0.20", `203.0.113.${i + 1}`)).status, 401);
    assert.equal((await login("127.0.0.20", "203.0.113.99", PASSWORD)).status, 429, "limited by its real address");

    // X-Forwarded-Host is honoured for the same-site check only from the proxy.
    const h = { origin: "https://bot.example.com", "x-forwarded-host": "bot.example.com", "x-forwarded-for": "198.51.100.3" };
    assert.equal((await req({ ...at, from: "127.0.0.10", method: "POST", path: "/api/login", headers: h, body: { password: PASSWORD } })).status, 200);
    assert.equal((await req({ ...at, from: "127.0.0.21", method: "POST", path: "/api/login", headers: h, body: { password: PASSWORD } })).status, 403);
  } finally { await srv.stop(); }
});

test("TBOT_PROXY_IPS does nothing without TBOT_TRUST_PROXY=1", async () => {
  const srv = await startServer({ TBOT_EXTRA_HOST: "127.0.0.2", TBOT_PROXY_IPS: "127.0.0.8/29" });
  try {
    await srv.waitLog(/Also listening/);
    const r = await req({ host: "127.0.0.2", port: srv.port, from: "127.0.0.9", headers: { "x-forwarded-proto": "https" } });
    assert.equal(r.headers["strict-transport-security"], undefined);
  } finally { await srv.stop(); }
});
