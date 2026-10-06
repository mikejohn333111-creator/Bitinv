// End-to-end check of the server bot in a real browser (Playwright + Chromium):
// the mock Deriv runs inside this process, the server runs as a child process.
//
//   node tools/e2e-server.mjs [--shots dir]
//
// Env: E2E_MOCK_PORT (8801), E2E_SERVER_PORT (8802), PLAYWRIGHT (path to playwright's index.mjs),
//      CHROMIUM (browser executable). Not part of "npm test" because it needs Playwright and a browser.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 8801);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT || 8802);
const PAT = "pat_e2e_TOKEN_5150aa77";
const APP_ID = "4242";
const PASSWORD = "e2e password 123";
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT || "/opt/node22/lib/node_modules/playwright/index.mjs");

// ---------------------------------------------------------------- mock
Object.assign(process.env, { PORT: String(MOCK_PORT), BAR_MS: "1000", MOCK_PAT: PAT });
await import("./mock-deriv.mjs");
const MOCK = `http://localhost:${MOCK_PORT}`;

// --------------------------------------------------------------- server
const dataDir = mkdtempSync(join(tmpdir(), "tbot-e2e-"));
const serverEnv = { ...process.env, TBOT_DATA_DIR: dataDir, TBOT_PORT: String(SERVER_PORT), TBOT_HOST: "127.0.0.1", TBOT_DEV: "1",
                    DERIV_API_URL: MOCK, DERIV_PUBLIC_WS: `ws://localhost:${MOCK_PORT}/trading/v1/options/ws/public` };
for (const k of ["PORT", "BAR_MS", "MOCK_PAT"]) delete serverEnv[k];
const pw = spawnSync(process.execPath, ["server/main.mjs", "set-password"], { cwd: ROOT, input: PASSWORD + "\n", env: serverEnv, encoding: "utf8" });
assert.equal(pw.stdout, "Password saved.\n", pw.stderr);
let server, serverOut = "";
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["server/main.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => reject(new Error("server did not start:\n" + serverOut)), 10000);
    server.stdout.on("data", (c) => { serverOut += c; if (/listening on/.test(serverOut)) { clearTimeout(t); resolve(); } });
    server.stderr.on("data", (c) => { serverOut += c; });
  });
}
const stopServer = () => new Promise((r) => { server.once("exit", r); server.kill("SIGTERM"); });
await startServer();
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

/** Opens a trade from outside the bot, as if it was bought before a restart. */
async function openTradeAtDeriv() {
  const r = await fetch(`${MOCK}/trading/v1/options/accounts/DOT90000001/otp`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Deriv-App-ID": APP_ID } });
  const { data } = await r.json();
  const ws = new WebSocket(data.url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const ask = (req) => new Promise((res) => { ws.onmessage = (ev) => res(JSON.parse(ev.data)); ws.send(JSON.stringify(req)); });
  const p = await ask({ proposal: 1, amount: 10, basis: "stake", contract_type: "MULTUP", currency: "USD", underlying_symbol: "R_75", multiplier: 100, duration_unit: "s" });
  const b = await ask({ buy: p.proposal.id, price: 10 });
  ws.close();
  return String(b.buy.contract_id);
}

// -------------------------------------------------------------- browser
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
const problems = [];
let step = "start";
try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (/Content Security Policy|Refused to/i.test(t)) problems.push(`CSP: ${t}`);
      else if (m.type() === "error" && !/status of 40[13]|status of 409|Failed to load resource/.test(t)) problems.push(`console: ${t}`);
    });
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("dialog", (d) => d.accept());
    const shot = async (name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage: true });

    step = "login";
    await page.goto(BASE + "/");
    await page.waitForSelector("#screenLogin:not([hidden])");
    await page.fill("#loginPassword", "not the password");
    await page.click("#loginBtn");
    await page.waitForSelector("#loginMsg:not([hidden])");
    assert.match(await page.textContent("#loginMsg"), /not right/);
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForSelector("#screenMain:not([hidden])");

    if (scheme === "light") {
      step = "connect Deriv";
      await page.waitForSelector("#notice:not([hidden])");
      assert.match(await page.textContent("#noticeText"), /Add your Deriv token/);
      await page.click("#noticeBtn");
      assert.equal(await page.$eval("#secDeriv", (d) => d.open), true);
      await page.fill("#appIdInput", APP_ID);
      await page.fill("#tokenInput", "pat_wrong_token_0000");
      await page.click("#derivSave");
      await page.waitForFunction(() => /did not accept/.test(document.getElementById("derivMsg").textContent));
      await page.fill("#tokenInput", PAT);
      await page.click("#derivSave");
      await page.waitForFunction(() => /Connected/.test(document.getElementById("derivMsg").textContent));
      assert.equal(await page.inputValue("#tokenInput"), "", "token field cleared");
      await page.waitForFunction(() => /10,000\.00 USD/.test(document.getElementById("balance").textContent));
      assert.equal((await page.textContent("#acctBadge")).trim(), "Demo");
      assert.match(await page.getAttribute("#tokenInput", "placeholder"), /ends in aa77/);
      assert.equal((await page.textContent("#sumDeriv")).trim(), "Connected");

      step = "start";
      await page.click("#runBtn");
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Running");
      assert.equal((await page.textContent("#runBtn")).trim(), "Stop the bot");

      step = "restart with an open trade";
      const id = await openTradeAtDeriv();
      await stopServer();
      await page.waitForFunction(() => /unreachable/i.test(document.getElementById("connText").textContent), null, { timeout: 10000 });
      await startServer();
      await page.waitForSelector(`#openList li[data-id="${id}"]`, { timeout: 15000 });
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Running");
      await page.waitForFunction(() => [...document.querySelectorAll("#logList .title")].some((e) => e.textContent === "Resumed after a restart"));
      await page.waitForFunction((tid) => /\d/.test(document.querySelector(`#openList li[data-id="${tid}"] .profit`).textContent), id);
      await shot("open-trade");

      step = "close the trade";
      await page.click(`#openList li[data-id="${id}"] button`);
      await page.waitForSelector(`#openList li[data-id="${id}"]`, { state: "detached", timeout: 15000 });
      await page.waitForFunction(() => [...document.querySelectorAll("#logList .title")].some((e) => /^Closed BUY R_75/.test(e.textContent)));

      step = "risk limits are clamped";
      await page.click("#secRisk summary");
      await page.fill('#riskForm input[name="riskPct"]', "99");
      await page.click('#riskForm button[type="submit"]');
      await page.waitForFunction(() => /adjusted/.test(document.getElementById("riskMsg").textContent));
      assert.equal(await page.inputValue('#riskForm input[name="riskPct"]'), "5");

      step = "mode can't change while running";
      await page.click("#secMode summary");
      await page.click('#modeSeg label:has(input[value="signals"])');
      await page.waitForFunction(() => /Stop the bot/.test(document.getElementById("modeMsg").textContent));
      assert.equal(await page.$eval('#modeSeg input[value="auto"]', (i) => i.checked), true);

      step = "allow real money";
      await page.click("#secReal summary");
      await page.fill("#realConfirm", "real");
      await page.click("#realOnBtn");
      await page.waitForFunction(() => /capital letters/.test(document.getElementById("realMsg").textContent));
      await page.fill("#realConfirm", "REAL");
      await page.click("#realOnBtn");
      await page.waitForSelector("#realOn:not([hidden])");
      await page.click("#secAccount summary");
      assert.equal(await page.$eval('#accountList input[value="ROT10000001"]', (i) => i.disabled), false);
      await page.click("#realOffBtn");
      await page.waitForSelector("#realOff:not([hidden])");
      await page.waitForFunction(() => document.querySelector('#accountList input[value="ROT10000001"]')?.disabled === true);

      step = "stop";
      await page.click("#runBtn");
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Stopped");
    } else {
      await page.waitForFunction(() => /10,000|USD/.test(document.getElementById("balance").textContent));
    }

    step = "page checks";
    assert.ok(!(await page.content()).includes(PAT), "the token never reaches the page");
    const small = await page.$$eval("button:not([hidden]), summary, .seg span, .choice", (els) => els
      .filter((e) => e.offsetParent !== null && getComputedStyle(e).display !== "none")
      .map((e) => [e.id || e.textContent.trim().slice(0, 30), e.getBoundingClientRect().height])
      .filter(([, h]) => h > 0 && h < 44));
    assert.deepEqual(small, [], "touch targets are at least 44px tall");
    const unlabeled = await page.$$eval("input:not([type=hidden]):not([hidden]), select", (els) => els
      .filter((e) => !e.closest("label") && !e.getAttribute("aria-label") && !(e.id && document.querySelector(`label[for="${e.id}"]`)))
      .map((e) => e.name || e.id));
    assert.deepEqual(unlabeled.filter((n) => n !== "username"), [], "every field has a label");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(wide <= 0, `no sideways scrolling (${wide}px)`);
    await page.evaluate(() => { for (const d of document.querySelectorAll("details.set")) d.open = true; });
    await shot("main");

    step = "log out";
    await page.click("#logoutBtn");
    await page.waitForSelector("#screenLogin:not([hidden])");
    await ctx.close();
  }
  assert.deepEqual(problems, [], "no CSP violations or script errors");
  console.log("e2e passed");
} catch (e) {
  console.error(`e2e failed at step "${step}":`, e.message);
  if (problems.length) console.error(problems.join("\n"));
  console.error("--- server output ---\n" + serverOut.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
