#!/usr/bin/env node
// Tbot server: runs the trading engine 24/7 and serves a password-protected control page.
//
//   node server/main.mjs                 start the server (see server/README.md for the settings)
//   node server/main.mjs set-password    read a new password from stdin and save it
//   node server/main.mjs self-test       load all of the server's code and the AI model, then exit 0
//                                        (the in-page Update runs it before restarting)
//
// No frameworks and no npm packages: only Node's own modules and the bot's code in public/js.
import { createServer } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../public/js/config.js";
import { TradingEngine, cleanSettings, UserError } from "./engine.mjs";
import { FileStore, ensureDataDir } from "./store.mjs";
import { PasswordFile, Sessions, Devices, LoginLimiter, ipBucket, hashPassword, verifyPassword, writeAuthFile, checkNewPassword,
         SESSION_DAYS, DEVICE_DAYS } from "./auth.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const STATIC_DIR = join(ROOT, "server", "public");
const env = process.env;
const DATA_DIR = env.TBOT_DATA_DIR ? resolve(env.TBOT_DATA_DIR) : join(ROOT, ".tbot-data");
const GIT_DIR = env.TBOT_GIT_DIR ? resolve(env.TBOT_GIT_DIR) : ROOT;   // TBOT_GIT_DIR is for tests only
const BODY_LIMIT = 16 * 1024;
const NO_PASSWORD_MSG = "No password is set yet. Run the setup script again to set one.";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};

// ================================================================ set-password
function fail(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

/** Reads a line without showing it, for when someone types the password in a terminal. */
function promptHidden(question) {
  return new Promise((done) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let chars = [];
    const finish = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write("\n"); done(chars.join("")); };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") { stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") chars.pop();
        else if (ch >= " ") chars.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

async function readNewPassword() {
  if (process.stdin.isTTY) {
    const a = await promptHidden("New password (at least 10 characters): ");
    const b = await promptHidden("Type it again: ");
    if (a !== b) fail("The two passwords are not the same. Nothing was changed.");
    return a;
  }
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > 64 * 1024) fail("That is too much input for a password. Nothing was changed.");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
}

async function setPasswordCli() {
  const pw = await readNewPassword();
  const problem = checkNewPassword(pw);
  if (problem) fail(`${problem} Nothing was changed.`);
  try {
    ensureDataDir(DATA_DIR);
    writeAuthFile(DATA_DIR, await hashPassword(pw));
  } catch (e) {
    fail(`Couldn't save the password (${e.code || e.message}). Nothing was changed.`);
  }
  process.stdout.write("Password saved.\n");
  process.exit(0);
}

// ================================================================== server
async function startServer() {
  const host = env.TBOT_HOST || "127.0.0.1";
  const port = Number(env.TBOT_PORT ?? 8080);
  const dev = env.TBOT_DEV === "1";
  const trustProxy = env.TBOT_TRUST_PROXY === "1";

  const store = new FileStore(DATA_DIR);
  const passwords = new PasswordFile(DATA_DIR);
  const sessions = new Sessions(store);
  const devices = new Devices(store);
  const limiter = new LoginLimiter();
  // Changing the password needs a session already, so it is limited per session only:
  // strangers' wrong logins never stop the owner from changing it.
  const pwLimiter = new LoginLimiter({ global: Infinity });
  const engine = new TradingEngine({
    cfg: { apiUrl: env.DERIV_API_URL || CONFIG.apiUrl, publicWs: env.DERIV_PUBLIC_WS || CONFIG.publicWs },
    store,
    log: (e) => console.log(`${e.tag} ${e.title}${e.detail ? `: ${e.detail}` : ""}`),
  });

  // ------------------------------------------------------------ helpers
  const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  const viaProxy = (req) => trustProxy && LOCAL.has(req.socket.remoteAddress);
  const lastValue = (h) => String(h || "").split(",").map((s) => s.trim()).filter(Boolean).at(-1) || "";
  const clientIp = (req) => ipBucket((viaProxy(req) && lastValue(req.headers["x-forwarded-for"]).slice(0, 64)) || req.socket.remoteAddress || "?");
  const isHttps = (req) => !!req.socket.encrypted || (viaProxy(req) && lastValue(req.headers["x-forwarded-proto"]).toLowerCase() === "https");

  function securityHeaders(res, https) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  function json(res, status, obj, headers = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                            "Content-Length": Buffer.byteLength(body), ...headers });
    res.end(body);
  }
  const text = (res, status, body, headers = {}) =>
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers }).end(body);

  // Over https the cookies use the __Host- prefix: browsers refuse a __Host- cookie that names a
  // Domain, so a page on another *.sslip.io name can't plant one that hides the real session.
  const SID = dev ? "tbot_sid" : "__Host-tbot_sid";
  const DEVICE = dev ? "tbot_dev" : "__Host-tbot_dev";
  const trimSp = (v) => v.replace(/^[ \t]+|[ \t]+$/g, "");
  /** Every value sent for this cookie name (a planted copy may come first). */
  function getCookies(req, name) {
    const out = [];
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && trimSp(part.slice(0, i)) === name) out.push(trimSp(part.slice(i + 1)));
    }
    return out;
  }
  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${dev ? "" : "; Secure"}`;
  const sessionCookie = (value, maxAge) => cookie(SID, value, maxAge);
  const findSession = (req, pwId) => { for (const v of getCookies(req, SID)) { const s = sessions.find(v, pwId); if (s) return s; } return null; };
  const findDevice = (req) => { for (const v of getCookies(req, DEVICE)) { const h = devices.find(v); if (h) return h; } return ""; };

  /** A same-origin check for every state-changing request (CSRF protection). */
  function sameOrigin(req, https) {
    let o;
    try { o = new URL(req.headers.origin); } catch { return false; }
    if (o.protocol !== "https:" && (https || o.protocol !== "http:")) return false;
    const hosts = [req.headers.host];
    if (viaProxy(req) && req.headers["x-forwarded-host"]) hosts.push(lastValue(req.headers["x-forwarded-host"]));
    return hosts.some((h) => h && String(h).toLowerCase() === o.host.toLowerCase());
  }
  /** A web server in front of the bot that doesn't pass the site name on (nginx's default). */
  const proxyHidesHost = (req) => viaProxy(req) && !req.headers["x-forwarded-host"] &&
    /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ""));
  const tooMany = (res, wait) => json(res, 429, { error: "too_many_attempts", message: `Too many wrong passwords. Please wait ${Math.ceil(wait / 60)} minutes and try again.` },
                                      { "Retry-After": String(wait) });

  function readBody(req) {
    return new Promise((done) => {
      if (Number(req.headers["content-length"] || 0) > BODY_LIMIT) return done({ tooBig: true });
      const chunks = [];
      let size = 0, over = false;
      req.on("data", (c) => {
        size += c.length;
        if (size <= BODY_LIMIT) chunks.push(c);
        else if (!over) { over = true; done({ tooBig: true }); }   // answered at once; the connection is then closed
      });
      req.on("end", () => { if (!over) done({ text: Buffer.concat(chunks).toString("utf8") }); });
      req.on("error", () => done({ tooBig: true }));
    });
  }

  // ------------------------------------------------------------ git update
  const scrub = (s) => String(s || "").replace(/\/\/[^@/\s]+@/g, "//***@").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
  const git = (args, timeout = 20000) => new Promise((done) => {
    execFile("git", ["-C", GIT_DIR, ...args], { timeout, maxBuffer: 1 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", LC_ALL: "C",
             GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" } },
    (err, stdout, stderr) => done({ ok: !err, out: String(stdout).trim(), err: scrub(stderr) || (err?.killed ? "timed out" : err?.message || "") }));
  });
  async function versionInfo() {
    const [h, l, b] = await Promise.all([git(["rev-parse", "HEAD"], 5000), git(["log", "-1", "--format=%cI%n%s"], 5000),
                                         git(["rev-parse", "--abbrev-ref", "HEAD"], 5000)]);
    if (!h.ok) return { commit: null };
    const [date, subject] = l.out.split("\n");
    return { commit: h.out.slice(0, 10), date: date || null, subject: subject || "", branch: b.ok ? b.out : null };
  }
  let updateCache = null, updating = false;
  /** True when the checked-out package.json lists packages the bot needs at run time. */
  function needsPackages() {
    try { return Object.keys(JSON.parse(readFileSync(join(GIT_DIR, "package.json"), "utf8")).dependencies || {}).length > 0; }
    catch { return true; }
  }
  /** Starts the checked-out code with "self-test" using the bot's own Node. */
  const selfTest = () => new Promise((done) => {
    execFile(process.execPath, [join(GIT_DIR, "server", "main.mjs"), "self-test"], { cwd: GIT_DIR, timeout: 30000, maxBuffer: 1 << 20, env: process.env },
      (err, _out, stderr) => {
        const lines = String(stderr).split("\n");
        const why = lines.find((l) => /^[A-Z]\w*(Error|Exception)\b/.test(l)) || lines.find((l) => /\S/.test(l)) || (err?.killed ? "timed out" : `exit ${err?.code}`);
        done({ ok: !err, err: err ? why.slice(0, 200) : "" });
      });
  });
  async function checkUpdate() {
    if (updateCache && Date.now() - updateCache.at < 60000) return updateCache.data;
    const v = await versionInfo();
    if (!v.commit) return { ...v, ahead: null, behind: null, message: "This copy of the bot isn't a git checkout, so it can't update itself." };
    const f = await git(["fetch", "--quiet", "--no-tags"], 20000);
    const u = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 5000);
    const ref = u.ok && u.out ? u.out : "origin/main";
    const c = await git(["rev-list", "--count", `HEAD..${ref}`], 5000);
    const behind = c.ok ? Number(c.out) : null;
    const data = { ...v, upstream: ref, behind, ahead: behind === null ? null : behind > 0, checked: f.ok,
      message: !f.ok ? `Couldn't check for updates right now (${f.err || "no answer"}).`
             : behind > 0 ? `An update is ready (${behind} new change${behind === 1 ? "" : "s"}).` : "You have the latest version." };
    if (f.ok) updateCache = { at: Date.now(), data };
    return data;
  }

  // ------------------------------------------------------------ routes
  const routes = {
    "POST /api/login": { public: true, fn: async ({ req, res, ip, body, pw }) => {
      const device = findDevice(req);
      const wait = limiter.retryAfter(ip, Date.now(), device);
      if (wait) return tooMany(res, wait);
      const mark = limiter.attempt(ip, Date.now(), device);
      if (!(await verifyPassword(pw, String(body.password ?? "")))) {
        if (limiter.deviceSpent(device)) devices.drop(device);   // too many wrong passwords: not trusted any more
        return json(res, 401, { error: "bad_password", message: "That password is not right." });
      }
      limiter.succeed(ip, mark);
      const cookies = [sessionCookie(sessions.create(pw.id), SESSION_DAYS * 86400)];
      if (device) devices.touch(device);
      else cookies.push(cookie(DEVICE, devices.create(), DEVICE_DAYS * 86400));
      return json(res, 200, { ok: true }, { "Set-Cookie": cookies });
    } },
    "POST /api/logout": { public: true, fn: ({ req, res }) => {
      for (const v of getCookies(req, SID)) sessions.remove(v);
      return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    } },
    "GET /api/status": { fn: () => ({ ...engine.status(), version: version.commit ? version : null }) },
    "GET /api/log": { fn: ({ url }) => {
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      return { entries: engine.logsAfter(after), last: engine.seq };
    } },
    "POST /api/start": { fn: () => { engine.start(); return engine.status(); } },
    "POST /api/stop": { fn: () => { engine.stop(); return engine.status(); } },
    "POST /api/settings": { fn: ({ body }) => {
      const { settings, errors } = cleanSettings(body, engine.settings, engine.knownSymbols());
      if (errors.length) throw new UserError(errors.join(" "), 400, "bad_settings");
      engine.updateSettings(settings);
      return { settings: engine.settings, status: engine.status() };
    } },
    "POST /api/deriv": { fn: async ({ body }) => {
      const out = await engine.setCredentials({ appId: body.appId, token: body.token });
      return { ok: true, ...out };
    } },
    "POST /api/deriv/forget": { fn: () => { engine.forgetCredentials(); return { ok: true }; } },
    "GET /api/accounts": { fn: async ({ url }) => {
      const accounts = url.searchParams.get("refresh") === "1" ? await engine.refreshAccounts() : engine.publicAccounts();
      return { accounts, current: engine.publicAccount(), allowReal: engine.settings.allowReal };
    } },
    "POST /api/account": { fn: ({ body }) => ({ ok: true, account: engine.selectAccount(String(body.id ?? "")) }) },
    "POST /api/close": { fn: async ({ body }) => {
      const id = String(body.id ?? "");
      if (!engine.contracts.has(id) || engine.contracts.get(id).stale) throw new UserError("That trade isn't open any more.", 404, "no_such_trade");
      if (!(await engine.closeContract(id, "closed by you"))) throw new UserError("Deriv didn't close the trade. Please try again.", 502, "close_failed");
      return { ok: true };
    } },
    "POST /api/close-all": { fn: async () => {
      const n = engine.openCount();
      const results = await engine.closeAll("closed by you");
      return { ok: results.every(Boolean), count: n };
    } },
    "POST /api/password": { fn: async ({ res, body, pw, session }) => {
      const wait = pwLimiter.retryAfter(session.h);
      if (wait) return tooMany(res, wait);
      const next = typeof body.next === "string" ? body.next : "";
      const problem = checkNewPassword(next);
      if (problem) throw new UserError(problem, 400, "weak_password");
      const mark = pwLimiter.attempt(session.h);
      if (!(await verifyPassword(pw, String(body.current ?? "")))) throw new UserError("Your current password is not right.", 400, "bad_password");
      pwLimiter.succeed(session.h, mark);
      const rec = await hashPassword(next);
      writeAuthFile(DATA_DIR, rec);
      passwords.current();
      sessions.keepOnly(session, rec.id);   // other devices are logged out
      engine.log("INFO", "Password changed", "Other devices were logged out.");
      return { ok: true };
    } },
    "GET /api/update": { fn: () => checkUpdate() },
    "POST /api/update": { fn: async ({ res }) => {
      if (updating) throw new UserError("An update is already running.", 409, "busy");
      updating = true;
      try {
        const before = await git(["rev-parse", "HEAD"], 5000);
        if (!before.ok) throw new UserError("This copy of the bot isn't a git checkout, so it can't update itself.", 409, "no_git");
        const pull = await git(["pull", "--ff-only", "--quiet"], 120000);
        if (!pull.ok) throw new UserError(`The update didn't work (${pull.err}). The bot keeps running the current version.`, 502, "update_failed");
        const after = await git(["rev-parse", "HEAD"], 5000);
        updateCache = null;
        if (after.out === before.out) return { updated: false, message: "You already have the latest version." };
        // Before restarting, make sure the new version can start. If not, go back to this one,
        // so a bad update can never leave the bot down and restarting over and over.
        const rollback = async (why, message) => {
          const r = await git(["reset", "--hard", "--quiet", before.out], 20000);
          updateCache = null;
          engine.log("ERROR", "The update didn't work, so the bot went back to its current version", r.ok ? why : `${why}; going back failed too: ${r.err}`);
          throw new UserError(message, 502, "update_failed");
        };
        const deps = await git(["diff", "--name-only", before.out, after.out, "--", "package.json", "package-lock.json"], 5000);
        if (!deps.ok || (deps.out && needsPackages()))
          await rollback(deps.ok ? "it needs new packages" : deps.err, "This update needs the setup line to be run again. The bot keeps running the current version.");
        const test = await selfTest();
        if (!test.ok) await rollback(test.err, "The update didn't work. The bot keeps running the current version.");
        engine.log("INFO", "Bot updated. Restarting now.", `${before.out.slice(0, 10)} to ${after.out.slice(0, 10)}`);
        res.once("finish", () => setTimeout(() => shutdown(0, "update"), 300));
        return { updated: true, from: before.out.slice(0, 10), to: after.out.slice(0, 10), message: "Updated. The bot restarts in a few seconds." };
      } finally { updating = false; }
    } },
  };
  const knownPaths = new Set(Object.keys(routes).map((k) => k.split(" ")[1]));

  // ------------------------------------------------------------ handlers
  async function api(ctx, url) {
    const { req, res } = ctx;
    const pw = passwords.current();
    if (!pw) return json(res, 503, { error: "no_password", message: NO_PASSWORD_MSG });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return knownPaths.has(url.pathname) ? json(res, 405, { error: "method_not_allowed", message: "Method not allowed." })
                                                     : json(res, 404, { error: "not_found", message: "Not found." });
    let body = {};
    if (req.method === "POST") {
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] || "")))
        return json(res, 415, { error: "bad_content_type", message: "Requests must be sent as JSON." });
      const site = req.headers["sec-fetch-site"];
      if (!sameOrigin(req, ctx.https) || (site && site !== "same-origin" && site !== "none")) {
        if (proxyHidesHost(req) && site !== "cross-site")
          return json(res, 403, { error: "proxy_host", message: "The web server in front of the bot doesn't pass the site name on, so this was blocked. " +
                                  "For nginx, add this line next to proxy_pass: proxy_set_header Host $host;" });
        return json(res, 403, { error: "bad_origin", message: "This request came from another site, so it was blocked." });
      }
      const raw = await readBody(req);
      if (raw.tooBig) return json(res, 413, { error: "too_big", message: "That request is too big." }, { Connection: "close" });
      if (raw.text.trim()) {
        try { body = JSON.parse(raw.text); } catch { return json(res, 400, { error: "bad_json", message: "That request isn't valid JSON." }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad_json", message: "Send a JSON object." });
      }
    }
    let session = null;
    if (!route.public) {
      session = findSession(req, pw.id);
      if (!session) return json(res, 401, { error: "login_required", message: "Please log in." });
    }
    try {
      const out = await route.fn({ ...ctx, url, body, pw, session });
      if (!res.headersSent) json(res, 200, out ?? { ok: true });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      if (!res.headersSent) json(res, e.status, { error: e.code, message: e.message });
    }
  }

  async function serveStatic(ctx, url) {
    const { req, res } = ctx;
    const notFound = () => text(res, 404, "Not found");
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return notFound(); }
    if (p.includes("\0") || p.includes("\\")) return notFound();
    if (p.endsWith("/")) p += "index.html";
    const segs = p.split("/").filter(Boolean);
    if (!segs.length || segs.some((s) => s.startsWith(".")) || !TYPES[extname(p).toLowerCase()]) return notFound();
    const file = resolve(STATIC_DIR, ...segs);
    if (!file.startsWith(STATIC_DIR + sep)) return notFound();
    let data;
    try {
      const real = await realpath(file);
      if (!real.startsWith(staticReal + sep) || !(await stat(real)).isFile()) return notFound();
      data = await readFile(real);
    } catch { return notFound(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(p).toLowerCase()], "Content-Length": data.length, "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  async function handle(req, res) {
    const ctx = { req, res, ip: clientIp(req), https: isHttps(req) };
    securityHeaders(res, ctx.https);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return text(res, 400, "Bad request"); }
    if (url.pathname === "/healthz") return req.method === "GET" || req.method === "HEAD" ? text(res, 200, "ok", { "Cache-Control": "no-store" }) : text(res, 405, "Method not allowed");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(ctx, url);
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return serveStatic(ctx, url);
  }

  // ------------------------------------------------------------ start
  const staticReal = await realpath(STATIC_DIR);
  let version = { commit: null };
  versionInfo().then((v) => { version = v; }).catch(() => {});

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("Request failed:", e?.stack || e);
      if (!res.headersSent) json(res, 500, { error: "server_error", message: "Something went wrong on the server." });
      else res.end();
    });
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  let closing = false;
  function shutdown(code, why) {
    if (closing) return;
    closing = true;
    console.log(`Shutting down (${why}). The bot ${engine.running ? "resumes" : "stays stopped"} when it starts again.`);
    engine.shutdown();
    try { sessions.flush(); } catch { /* best effort */ }
    server.close(() => process.exit(code));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(code), 3000).unref();
  }
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e?.stack || e));

  server.on("error", (e) => { console.error(`Can't listen on ${host}:${port} (${e.code || e.message}).`); process.exit(1); });
  server.listen(port, host, () => {
    const a = server.address();
    console.log(`Tbot server listening on http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`);
    if (!passwords.current()) console.log(NO_PASSWORD_MSG);
  });
  engine.init().catch((e) => console.error("Engine start failed:", e?.stack || e));
}

// ==================================================================== main
const cmd = process.argv[2];
if (cmd === "self-test") {
  // Every import above has loaded by now (config, engine, strategy, risk, deriv, store, auth).
  try {
    JSON.parse(readFileSync(new URL("../public/model/tbotai-model.json", import.meta.url), "utf8"));
    readFileSync(join(STATIC_DIR, "index.html"));
  } catch (e) { fail(`Self-test failed: ${e.message}`); }
  process.stdout.write("Self-test passed.\n");
  process.exit(0);
}
if (cmd === "set-password") await setPasswordCli();
else if (cmd) fail(`Unknown command "${String(cmd).slice(0, 40)}". Use "set-password" or "self-test", or no command to start the server.`, 2);
else await startServer();
