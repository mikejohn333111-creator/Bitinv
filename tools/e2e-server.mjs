// End-to-end check of the scanner-only server bot in a real browser (Playwright + Chromium), auto trade included:
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
Object.assign(process.env, { PORT: String(MOCK_PORT), BAR_MS: "1000", MOCK_PAT: PAT, MOCK_CONTROL: "1", MOCK_SCAN_SETUPS: "1" });
await import("./mock-deriv.mjs");
const MOCK = `http://localhost:${MOCK_PORT}`;

// --------------------------------------------------------------- server
const dataDir = mkdtempSync(join(tmpdir(), "tbot-e2e-"));
const serverEnv = { ...process.env, TBOT_DATA_DIR: dataDir, TBOT_PORT: String(SERVER_PORT), TBOT_HOST: "127.0.0.1", TBOT_DEV: "1", TBOT_SCAN_GAP_MS: "100",
                    DERIV_API_URL: MOCK, DERIV_PUBLIC_WS: `ws://localhost:${MOCK_PORT}/trading/v1/options/ws/public` };
for (const k of ["PORT", "BAR_MS", "MOCK_PAT", "MOCK_CONTROL", "MOCK_SCAN_SETUPS"]) delete serverEnv[k];
const mockClock = (barMs) => fetch(`${MOCK}/mock/clock`, { method: "POST", body: JSON.stringify({ barMs }) });
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

      step = "start (Auto trade is the default)";
      assert.equal(await page.$eval('#modeSeg input[value="auto"]', (i) => i.checked), true);
      assert.match(await page.textContent("#stateDetail"), /Press Start to trade the scanner's ready setups/);
      for (const gone of ["#secMarket", "#signalBox", "#seesText", "#pendingBox", "#scanAutoInput", "#scanOn", "#secMode"])
        assert.equal(await page.$(gone), null, `${gone} is gone`);
      // Signals only until the scanner's fixed setups are on, so a random setup on the mock's forex is never traded.
      await page.click('#modeSeg label:has(input[value="signals"])');
      await page.waitForFunction(() => /Signals only/.test(document.getElementById("stateDetail").textContent));
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
      step = "the chart shows the open trade's market by default";
      await page.waitForFunction(() => document.getElementById("chart").dataset.symbol === "R_75" && Number(document.getElementById("chart").dataset.candles) > 50, null, { timeout: 15000 });
      assert.match(await page.textContent("#focusText"), /Open trade/);
      await shot("open-trade");

      step = "close the trade";
      await page.click(`#openList li[data-id="${id}"] [data-close]`);
      await page.waitForSelector(`#openList li[data-id="${id}"]`, { state: "detached", timeout: 15000 });
      await page.waitForFunction(() => [...document.querySelectorAll("#logList .title")].some((e) => /^Closed BUY R_75/.test(e.textContent)));

      step = "risk limits are clamped";
      await page.click("#secRisk summary");
      await page.fill('#riskForm input[name="riskPct"]', "99");
      await page.fill('#riskForm input[name="scanAutoMaxDay"]', "50");
      await page.click('#riskForm button[type="submit"]');
      await page.waitForFunction(() => /adjusted/.test(document.getElementById("riskMsg").textContent));
      assert.equal(await page.inputValue('#riskForm input[name="riskPct"]'), "5");
      assert.equal(await page.inputValue('#riskForm input[name="scanAutoMaxDay"]'), "10");
      await page.fill('#riskForm input[name="scanAutoMaxDay"]', "4");
      await page.click('#riskForm button[type="submit"]');
      await page.waitForFunction(() => /Saved/.test(document.getElementById("riskMsg").textContent) && document.getElementById("tradesToday").textContent.endsWith("/ 4"));
      await page.click("#secRisk summary");

      step = "the mode switches while running";
      assert.match(await page.textContent("#scanAuto"), /Signals only/);
      await page.click('#modeSeg label:has(input[value="auto"])');
      await page.waitForFunction(() => /Auto trade \(demo\)/.test(document.getElementById("scanAuto").textContent) && /Trading the scanner/.test(document.getElementById("stateDetail").textContent));
      assert.equal((await page.textContent("#stateLabel")), "Running");
      await page.click('#modeSeg label:has(input[value="signals"])');
      await page.waitForFunction(() => /Signals only/.test(document.getElementById("scanAuto").textContent));

      step = "allow real money (in Account)";
      await page.click("#secAccount summary");
      await page.fill("#realConfirm", "real");
      await page.click("#realOnBtn");
      await page.waitForFunction(() => /capital letters/.test(document.getElementById("realMsg").textContent));
      await page.fill("#realConfirm", "REAL");
      await page.click("#realOnBtn");
      await page.waitForSelector("#realOn:not([hidden])");
      assert.equal(await page.$eval('#accountList input[value="ROT10000001"]', (i) => i.disabled), false);
      await page.click("#realOffBtn");
      await page.waitForSelector("#realOff:not([hidden])");
      await page.waitForFunction(() => document.querySelector('#accountList input[value="ROT10000001"]')?.disabled === true);
      await page.click("#secAccount summary");

      step = "stop";
      await page.click("#runBtn");
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Stopped");

      step = "scanner";
      // Real markets only at first; the mock's fixed setups are on two synthetic indices.
      await page.waitForFunction(() => /Checked/.test(document.getElementById("scanWhen").textContent), null, { timeout: 30000 });
      await page.click("#secScanner summary");
      assert.equal(await page.isChecked("#scanSynth"), false, "real markets only by default");
      assert.deepEqual(await page.$$eval('#scanStratSeg input:checked', (els) => els.map((e) => e.value)), ["ict", "smc"]);
      await page.click('label[for="scanSynth"]');
      await page.waitForFunction(() => /Saved/.test(document.getElementById("scanSetMsg").textContent));
      assert.match(await page.textContent("#sumScanner"), /synthetics/);
      await page.click("#secScanner summary");
    } else {
      await page.waitForFunction(() => /10,000|USD/.test(document.getElementById("balance").textContent));
    }

    step = "scanner list and the default chart";
    await page.waitForFunction(() => document.querySelectorAll("#scanList .scan-item").length >= 2 &&
      [...document.querySelectorAll("#scanList .scan-name")].some((e) => e.textContent === "Volatility 50 Index"), null, { timeout: 60000 });
    assert.equal(await page.$eval("#scanList .scan-item", (b) => b.classList.contains("ready")), true, "ready now comes first");
    assert.match(await page.textContent("#scanList"), /Waiting/);
    assert.match(await page.textContent("#scanCard"), /no proven edge/);
    assert.ok(!/%/.test(await page.textContent("#scanList")), "no percentages on the cards");
    assert.equal(await page.$$eval(".scan-more", (els) => els.length), 0, "reasons are folded");
    const top = await page.$eval("#scanList .scan-item", (b) => b.dataset.id.split(":")[0]);
    await page.waitForFunction((sym) => document.getElementById("chart").dataset.symbol === sym && Number(document.getElementById("chart").dataset.candles) > 50, top, { timeout: 15000 });
    // The home screen as it looks on arrival: every settings group folded, no toast.
    await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = false; document.getElementById("toast").hidden = true; window.scrollTo(0, 0); });
    await shot("home");
    await page.$eval("#scanCard", (e) => e.scrollIntoView());
    if (SHOTS) await page.locator("#scanCard").screenshot({ path: join(SHOTS, `scanner-card-${scheme}.png`) });

    step = "a tapped setup: its reason and its chart";
    await page.click('#scanList .scan-item:has(.scan-name:text-is("Volatility 50 Index"))');
    await page.waitForSelector(".scan-more .scan-reason");
    await page.waitForFunction(() => document.getElementById("chart").dataset.symbol === "R_50" &&
      document.getElementById("chart").dataset.plans?.split(" ").includes("scan") && Number(document.getElementById("chart").dataset.candles) > 50, null, { timeout: 15000 });
    assert.match(await page.textContent("#chartMarket"), /Volatility 50/);
    assert.match(await page.textContent("#focusText"), /Waiting for price/);
    await page.click('[data-tf="300"]');
    await page.waitForFunction(() => document.getElementById("chart").getAttribute("aria-label").startsWith("5m") &&
                                     Number(document.getElementById("chart").dataset.candles) > 5, null, { timeout: 15000 });
    if (SHOTS) await page.locator("#chartCard").screenshot({ path: join(SHOTS, `scanner-chart-${scheme}.png`) });
    if (scheme === "light") {
      step = "auto trade (demo): Start, Scan now";
      await mockClock(6000);   // slower prices, so the trade stays open long enough to look at
      await page.click('#modeSeg label:has(input[value="auto"])');
      await page.waitForFunction(() => /Auto trade \(demo\) · 0 of 4 today/.test(document.getElementById("scanAuto").textContent) &&
                                       /press Start/.test(document.getElementById("scanAuto").textContent));
      await page.click("#runBtn");
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Running");
      await page.click("#scanBtn");
      await page.waitForFunction(() => /Scan again in|Scanning/.test(document.getElementById("scanBtn").textContent));
      assert.equal(await page.isDisabled("#scanBtn"), true, "cooldown");

      step = "auto trade (demo): the trade, its tag and the Traded badge";
      await page.waitForFunction(() => [...document.querySelectorAll("#openList .from")].some((e) => /^from Scanner · ICT (15m|1h) Volatility 100 Index$/.test(e.textContent)),
                                 null, { timeout: 60000 });
      await page.waitForFunction(() => /Auto trade \(demo\) · 1 of 4 today/.test(document.getElementById("scanAuto").textContent), null, { timeout: 20000 });
      await page.waitForFunction(() => [...document.querySelectorAll("#scanList .scan-item")].some((b) =>
        b.querySelector(".scan-name")?.textContent === "Volatility 100 Index" && b.querySelector(".scan-traded")), null, { timeout: 30000 });
      assert.ok([...(await page.$$eval("#logList .title", (els) => els.map((e) => e.textContent)))].some((t) => /^Opened BUY R_100 from the scanner/.test(t)));
      const tradeId = await page.$eval("#openList li:has(.from)", (li) => li.dataset.id);
      await page.evaluate(() => { document.getElementById("toast").hidden = true; window.scrollTo(0, 0); });
      await shot("home-trading");
      if (SHOTS) await page.locator("#openList").screenshot({ path: join(SHOTS, "auto-open-trade-light.png") });

      step = "auto trade (demo): the trade's plan on its market's chart";
      await page.click(`#openList li[data-id="${tradeId}"] [data-chart]`);
      await page.waitForFunction((id) => document.getElementById("chart").dataset.symbol === "R_100" &&
        document.getElementById("chart").dataset.plans?.split(" ").includes(id) && Number(document.getElementById("chart").dataset.candles) > 50, tradeId, { timeout: 20000 });
      assert.match(await page.textContent("#focusText"), /ICT on (15m|1h) · Open trade/);
      if (SHOTS) await page.locator("#chartCard").screenshot({ path: join(SHOTS, "auto-trade-chart-light.png") });

      step = "auto trade (demo): Stop leaves the trade open; then close it";
      await page.click("#runBtn");
      await page.waitForFunction(() => document.getElementById("stateLabel").textContent === "Stopped");
      assert.ok(await page.$(`#openList li[data-id="${tradeId}"]`), "Stop closes nothing");
      await page.click(`#openList li[data-id="${tradeId}"] [data-close]`);
      await page.waitForSelector(`#openList li[data-id="${tradeId}"]`, { state: "detached", timeout: 15000 });
      await mockClock(1000);
    } else {
      step = "auto trade (demo): shown while the bot is stopped";
      await page.waitForFunction(() => /Auto trade \(demo\) · 1 of 4 today/.test(document.getElementById("scanAuto").textContent), null, { timeout: 20000 });
    }

    step = "page checks";
    assert.ok(!(await page.content()).includes(PAT), "the token never reaches the page");
    await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
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
    await shot("settings");

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
