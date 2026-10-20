# Tbot server

The web bot in `public/` only trades while its page is open. The server bot runs on a Linux server, 24/7, and is **scanner-only**: it checks many markets with the strategies (ICT, Rules, AI model) and, in Auto trade on a demo account, trades the setups it finds. It has no single market or strategy of its own to pick. It keeps going after you close the page, and after a crash, reboot or update it carries on by itself, until you press **Stop**.

You control it from a small password-protected page that works well on a phone.

## Read this first

No bot can guarantee profits. In our tests the strategies roughly broke even before costs and lost money after Deriv's commission (see the main `README.md`). Please stay on a demo account.

- Two modes, next to the Start button: **Signals only** (the scanner shows setups, nothing is traded) and **Auto trade (demo)** (while the bot runs, it trades the scanner's ready setups). A new install starts in Auto trade on your **demo** account, and nothing trades until you press Start.
- Auto trade is **demo only**. It never trades real money, whatever **Allow real money** says (that only lets you pick a real account for Signals only).
- Every trade has a stop loss and take profit set at Deriv. Stopping the bot never closes trades. The daily loss limit closes them.

## What it does

- Uses the same strategy, sizing and risk-limit code as the browser (`public/js/strategy.js`, `risk.js`, `deriv.js`) inside the scanner, and places orders the same way: a `proposal` then a `buy` with `underlying_symbol` and `limit_order`, open trades followed with `proposal_open_contract`, the daily loss limit checked on equity, and time limits.
- A 1-minute candle stream of one synthetic index (R_75, open around the clock) is the bot's clock: every candle close runs the time limits and the daily loss check, and a quiet stream means a stuck connection.
- Logs in to Deriv with a **Personal Access Token** (PAT) and your App ID. Each WebSocket connection gets a fresh one-time address, also after every reconnect.
- Saves settings, state and the activity log in a data folder, so a restart resumes trading and picks up open trades from Deriv's portfolio.
- If Deriv rejects the token, it stops trading and asks for a new token on the page. Network problems only cause reconnects.

### The scanner

The **Scanner** card, at the top of the page, lists setups the strategies find on many markets at once, like the "AI trade scanners" you see online, but honest about what they are: setups, not predictions, and our backtests found no proven edge after fees. In Signals only nothing is traded; see **Auto trade** below.

- It watches up to 20 open markets from Deriv's Multiplier list: real markets by default (forex majors first, then gold and silver, stock indices, other pairs), synthetic indices only if you turn them on under **Settings > Scanner**.
- After every 15-minute and 1-hour candle close (30 seconds later) it asks Deriv for each market's candles with a one-off `ticks_history` on the bot's own connection: one request every 2 seconds, never while the bot is placing an order or reloading its trades. If Deriv answers with its rate limit, it pauses (1, 2, 5, 10, then 15 minutes) and says so on the page and in Activity. **Scan now** runs it at once, at most every 2 minutes.
- Each market is checked with the strategies picked under **Settings > Scanner > What the scanner looks for**: ICT (with the real-market filters) and Rules by default, the AI model when you pick it (it was trained on 1-minute candles and is untested on 15m and 1h). A card is **Ready now** (a setup on the last closed candle; entry, stop loss and take profit as the bot's signal) or **Waiting for price** (an ICT plan; its zone, stop and target, until it expires or price cancels it), with entry, stop loss and take profit on one line; tapping it opens the reason in words, the reward to risk ratio and what agrees.
- Sorted by status, then freshness, then "Agrees": the 4-hour trend and the other strategies or timeframes on the same market pointing the same way. It is a count, not a win chance; there are no confidence percentages.
- The chart shows the first open trade's market, else the top setup's. Tapping a card (or an open trade's **Chart** button) shows that market, timeframe and plan instead.

### Auto trade (demo only)

With **Auto trade (demo)** chosen and the bot started, it takes the scanner's setups by itself, aiming at a few price-action trades a day. **Start** starts this; **Stop** stops new trades and leaves open trades alone (they keep their stop loss and take profit, and the bot keeps watching them). The mode can be switched while the bot runs.

- **Demo only**: switching to Auto trade while a real money account is connected is refused (403 `scanner_demo_only`), Start is refused on a real account in Auto trade, every order checks the account again, and the page says so in plain words (`scanAutoBlocked` in the status). Signals only works on any account.
- It takes **"Ready now"** setups only, as soon as a scan finishes, best first (the scanner's order: ready, freshest, most agreement). A setup must be from the newest closed candle of its timeframe, and the latest price must still be inside the plan: not past its stop loss or take profit, and within 0.25R (a quarter of the stop distance) of the entry either way. Just before buying, Deriv's quoted price is checked again against the stop loss and take profit.
- "Waiting for price" ICT plans are **not** auto-traded: the scanner reads candles at each candle close, not every tick, so it can't see the moment price touches the zone. (An ICT setup that entered its zone on the last closed candle shows as Ready now and can be taken.)
- Under **Settings > Risk**: risk per trade, the daily loss limit, **trades per day** (4, from 1 to 10) and **open at once** (2, from 1 to 5, counting every open trade), the pause after losses in a row. Only one open trade per market, from any source. What it trades is what the scanner shows: its timeframes and strategies.
- Orders: a `proposal` with the stop loss and take profit as money (from the setup's stop and target distances), then a `buy`, sized with your **Risk per trade** at the lowest Multiplier that market offers, using that market's own Multiplier range and stake limits (`contracts_for`, asked once an hour).
- The trades are followed in Open trades as "from Scanner · ICT 15m EUR/USD" with a **Chart** button, picked up again after a restart, closed by the daily loss limit, and counted by the risk guard (trades per day, the pause after losses; the daily loss limit stops everything).
- Each setup is taken at most once (also after a restart), and today's count is kept in `state.json`. Every reason a setup was not taken is written once in Activity. The Scanner card shows "Auto trade (demo) · 2 of 4 today" and a **Traded** badge on setups it took.

### Updating from the single-market bot

Older versions traded one market with one strategy, plus optional scanner auto-trade. On the first start after the update, the saved settings are moved over once (they get `"v": 2`), and Activity says what happened:

- Scanner auto-trade was **on** (and the bot was in Auto trade): the mode stays **Auto trade**, and the scanner keeps the strategies and timeframes auto-trade used, so nothing new is traded.
- Otherwise: the mode becomes **Signals only**, so an update never starts trading by itself. Pick Auto trade when you want it.
- The old market, strategy, timeframe, fast mode, multiplier, signal gap and max-open settings are ignored (left out of the file). The smaller of the old two "trades per day" limits is kept. The scanner is turned on.
- A running bot keeps running. Trades the old strategy opened are still watched, closed at their time limit and by the daily loss limit.

A few things are stricter than in the browser, because a server runs unattended and restarts:

- The daily loss limit starts counting only after open trades are loaded, so money in an open trade never looks like a loss after a restart. Every open Multiplier trade on the account is followed, also one you opened yourself on Deriv's site. When the balance drops for a trade the bot doesn't know yet, it reloads the open trades before checking the limit.
- After a trade closes, the daily loss check waits (up to 15 seconds) for Deriv's new balance, so a closed trade's money is never missing for a moment.
- If the daily loss limit is hit and Deriv doesn't close a trade, the bot tries again on every candle, also after a restart.
- If a buy's answer is lost, the bot looks for the trade again after 5, 15, 45 and 90 seconds and trades nothing meanwhile. A trade that turns up late keeps its time limit.
- If Deriv's price feed goes quiet for 3 minutes while the connection looks fine, the bot connects again from scratch.
- A trade that closed while the bot was down (during an update or reboot) is looked up once, so its result is in the log and counts for the losing-streak pause.
- Pressing Stop while an order is being prepared cancels it before the buy.
- The limits move to the new day at the first candle of the UTC day, even if nothing else happens.
- The bot never takes the same setup twice, never trades while it is still reloading open trades after a reconnect, and if a buy's answer is lost it reloads open trades before doing anything else.
- The time limit of each trade is saved, so it still applies after a restart. A close that fails is tried again on the next candle.

## Running it

From the repository folder:

```
node server/main.mjs set-password     # type a password of at least 10 characters (read from stdin)
node server/main.mjs                  # starts on http://127.0.0.1:8080
```

There are no packages to install. It needs Node 22 or newer (for the built-in `fetch` and `WebSocket`).

| Setting | Default | What it does |
|---|---|---|
| `TBOT_DATA_DIR` | `.tbot-data` in the repo | Where everything is saved. Production: `/var/lib/tbot`. |
| `TBOT_HOST` | `127.0.0.1` | Address to listen on. |
| `TBOT_PORT` | `8080` | Port to listen on (`0` picks a free one). |
| `TBOT_TRUST_PROXY` | off | Set to `1` behind a reverse proxy on the same machine. `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are then trusted, but only from `127.0.0.1` or `::1` (and `TBOT_PROXY_IPS`). |
| `TBOT_EXTRA_HOST` | none | A second address to listen on as well, on the same port, such as a Docker network's gateway (`172.18.0.1`) so a web server in a container can reach the bot. If it can't be used yet (the network isn't up at boot), the bot logs it once, keeps running on `TBOT_HOST`, and tries again every 10 seconds. |
| `TBOT_PROXY_IPS` | none | More addresses to trust as the reverse proxy when `TBOT_TRUST_PROXY=1`: comma-separated IPv4 addresses or ranges, such as `172.18.0.0/16`. Invalid entries are logged and ignored. Without `TBOT_TRUST_PROXY=1` it does nothing. |
| `TBOT_DEV` | off | Set to `1` for local testing over plain http: the cookies drop the `Secure` flag and the `__Host-` prefix. |
| `DERIV_API_URL` | `https://api.derivws.com` | Deriv's REST API. |
| `DERIV_PUBLIC_WS` | `wss://api.derivws.com/trading/v1/options/ws/public` | Deriv's public prices feed (used when no token is set). |
| `TBOT_GIT_DIR` | the repo | Only for tests: the git checkout that the Update button pulls. |

### Behind Caddy in a Docker container

`server/docker-caddy.sh` (served as `/docker-caddy.sh`) puts the bot behind a Caddy that runs in a container and already holds ports 80 and 443. It sets `TBOT_EXTRA_HOST` to the gateway of the container's network and `TBOT_PROXY_IPS` to that network's range in `/etc/tbot.env` (the setup keeps those lines), and records what it changed in comment lines there (`# tbot-docker-caddy...`) so `--remove` and the uninstall script can undo it. Every container on that Docker network can then reach the bot and is trusted to send `X-Forwarded-*` headers. Those are your own containers; the login limits still apply (the overall limit of 30 wrong passwords per 15 minutes counts every source). See `docs/server-setup.md`.

### The password

`node server/main.mjs set-password` reads the new password from stdin (never from the command line), needs at least 10 characters, writes a scrypt hash to `$TBOT_DATA_DIR/auth.json` with mode 0600, prints only `Password saved.` and exits 0. Anything else exits with a short message and a non-zero code. In a terminal it asks twice without showing what you type.

The running server notices the new file by itself. A new password logs out every device.

Until a password is set, the page says "No password is set yet. Run the setup script again to set one." and every API call except `/healthz` answers 503. The page never lets you create the first password, because bots watch new certificates and would get there first.

### Updates

The **Update the bot** section shows the version and whether the remote branch has new commits (`git fetch`, 20 second limit). **Update now** runs `git pull --ff-only` in the app folder. If anything changed, it first runs `node server/main.mjs self-test` with the new code (it loads all of the server's code and the AI model, then exits). If that fails, or if the new version needs npm packages, it goes back to the version that was running (`git reset --hard` to the old commit), keeps running, and says so on the page. Only when the check passes does it exit with code 0 after answering. The service manager has to start it again, so the systemd unit needs `Restart=always` (not `on-failure`). The bot then resumes on its own.

`SIGTERM` (as sent by `systemctl stop` or `restart`) stops timers and connections and keeps the "running" flag, so the bot resumes when it starts again.

### Trying it locally against the fake Deriv

```
PORT=8801 BAR_MS=1000 MOCK_PAT=pat_local_test_1234 node tools/mock-deriv.mjs
printf 'my local password\n' | TBOT_DATA_DIR=/tmp/tbot-data node server/main.mjs set-password
TBOT_DATA_DIR=/tmp/tbot-data TBOT_PORT=8802 TBOT_DEV=1 DERIV_API_URL=http://localhost:8801 \
  DERIV_PUBLIC_WS=ws://localhost:8801/trading/v1/options/ws/public node server/main.mjs
```

Open http://127.0.0.1:8802, log in, and under **Deriv connection** paste any App ID with the token `pat_local_test_1234`. The mock's time runs fast (one candle per `BAR_MS`).

`node tools/e2e-server.mjs` runs the whole thing in a real browser (Playwright and Chromium needed): login, token, start, a restart with an open trade, closing it, settings, real money switch, the scanner (its setups and one on the chart), scanner auto-trade on demo (the trade, its tag, its plan on the chart), log out, in light and dark mode. `npm test` runs the engine and API tests.

## The data folder

Mode 0700. Every file in it is mode 0600 and written atomically (temporary file, fsync, rename).

| File | What it holds |
|---|---|
| `auth.json` | scrypt hash of the page password |
| `sessions.json` | logged-in sessions, as SHA-256 hashes of the cookie (at most 20, 30 days each) |
| `devices.json` | devices that logged in before, as SHA-256 hashes of the known-device cookie (at most 20, 1 year each) |
| `secret.json` | Deriv App ID and token |
| `settings.json` | your settings |
| `state.json` | running or not, the chosen account, notes about open trades, the scanner setups taken and today's count |
| `guard.json` | daily risk-limit counters per account |
| `log.jsonl` | the activity log, trimmed to the last 2000 lines |
| `scanner.json` | the scanner's settings |

The token is never written to the log, never printed, and never sent back to the page. The page only sees its last 4 characters.

## Security

- Password check with scrypt and a constant-time comparison. Session cookie `__Host-tbot_sid` (`tbot_sid` with `TBOT_DEV=1`): 32 random bytes, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, 30 days. The `__Host-` prefix means a page on another `*.sslip.io` name can't plant a cookie that hides the real one. If a request carries several values, any valid one counts.
- Login limits: 5 wrong passwords per IP (per /64 for IPv6) and 30 in total per 15 minutes, then 429 with `Retry-After`. Attempts are counted before the password is checked, so a burst can't slip through.
- A successful login also sets a known-device cookie `__Host-tbot_dev` (1 year). Logins from a known device skip the per-IP and shared limits and have their own limit of 5 wrong passwords, after which that device is forgotten. So strangers guessing passwords can't lock the owner out.
- The password-change form needs a session and is limited per session only.
- Every request that changes something must be a `POST` with `Content-Type: application/json`, an `Origin` header of this same site (and no cross-site `Sec-Fetch-Site`), and a body of at most 16 KB.
- On every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Strict-Transport-Security` when the request came over https. API answers have `Cache-Control: no-store`.
- Static files come only from `server/public/`, with dot files, unknown file types, encoded `..` and symlinks out of the folder refused. The two exceptions are the website's chart code, served by name as it is: `/lib/plan.js` (`public/js/plan.js`) and `/lib/lightweight-charts.mjs` (`public/vendor/`).

## API

All under `/api/`, JSON in and out. Every call needs the session cookie except login and logout. Errors look like `{"error": "code", "message": "Plain text for the user."}`.

| Call | What it does |
|---|---|
| `GET /healthz` | `200 ok`, no login needed. |
| `POST /api/login` `{password}` | Sets the session cookie. 401 wrong password, 429 too many tries. |
| `POST /api/logout` | Ends this session. |
| `GET /api/status` | Everything the page shows: `running`, `mode` (`auto` or `signals`), `connection`, `account {id,type,currency}`, `balance`, `equity`, `dayPL` (%), `tradesToday`, `halted`, `haltReason`, `cooldownUntil`, `marks` (recent trades as `{t, side, symbol}`, for chart arrows), `resumedAt` (when it carried on by itself after a restart), `lastCost`, `open` trades (`id, side, symbol, name, stake, profit, opened, horizon, barSec, plan, source` ("bot" or "scanner"), and `scan: {strategy, tf, name}` for scanner trades; `plan` is `{side, entry, sl, tp, slMoney, tpMoney, start, end}` from Deriv's numbers, or null), `scanAutoBlocked`, `scanAuto` (`{on, demoOnly, blocked, today, maxDay, open, maxOpen, waiting}`), `accounts`, `needsToken`, `hasToken`, `tokenHint` (last 4 characters), `appId`, `error`, `modelLoaded`, `settings`, `limits`, `version`. |
| `GET /api/candles?tf=<sec>&symbol=<code>[&after=<epoch>]` | The chart's candles of a market (a scanner setup's or an open trade's), `tf` one of 60, 300, 900, 3600, 14400, 86400: `{symbol, tf, botTf, live, full, candles: [[epoch, open, high, low, close], ...], message}`. Loaded on the bot's Deriv connection (at most every 15 seconds per market and timeframe, 500 candles). With `after`, only that candle and newer ones (`full: false`). An empty list comes with a `message` (not connected, loading). 400 for another `tf`; the code must be one Deriv lists, else 400 `bad_symbol`. Without `symbol`: the clock market (R_75). |
| `GET /api/scanner` | The scanner: `{settings: {on, synthetics, timeframes, strategies}, now, scanning, progress: {done, total}, lastScanAt, nextScanAt, cooldownUntil, pausedUntil, markets, failed, modelLoaded, message, items}`. Each item: `id, symbol, name, tf, strategy, side, status` ("ready" or "waiting"), `entry, sl, tp, zone, rr, reason, inZone, at, start, end, agree, against, score, traded`; ready ones also `slDist, tpDist, horizonBars, price` (the latest price when scanned). `auto` is the same as `scanAuto` in the status. At most 40, gzipped. |
| `POST /api/scanner/scan` | Scan every market now. 429 within 2 minutes of the last one, 409 when off or not connected. |
| `POST /api/scanner/settings` `{on, synthetics, timeframes, strategies}` | Changes the scanner settings (saved in `scanner.json`). `timeframes` is `[900]`, `[3600]` or both; `strategies` some of `ict`, `rules`, `ai` (what the scanner shows and auto trade takes). |
| `GET /api/log?after=<seq>` | Activity log entries newer than `seq` (up to 200), plus `last`. |
| `POST /api/start` | Starts the bot: in Auto trade the scanner's ready setups are traded (demo only). 409 with a message if it can't (no token, not connected yet), 403 `scanner_demo_only` on a real account in Auto trade. |
| `POST /api/stop` | Stops the bot: no new trades. Open trades keep their stop loss and take profit and are still watched. |
| `POST /api/settings` `{...}` | Changes some settings. Numbers are clamped to safe ranges: `riskPct`, `maxDailyLossPct`, `scanAutoMaxDay` (trades per day, 1-10), `scanAutoMaxOpen` (open at once, 1-5), `maxConsecLosses`, `cooldownMinutes`. `mode` is `auto` or `signals` (can change while running; `auto` is 403 `scanner_demo_only` on a real account). `allowReal: true` also needs `confirmReal: "REAL"`. Old keys (`symbol`, `strategy`, `botTf`, `aiFast`, `multiplier`, `scanAuto`, ...) are ignored. |
| `POST /api/deriv` `{appId, token}` | Checks them by listing the accounts at Deriv, then saves them and connects (demo account first). Returns the accounts, never the token. |
| `POST /api/deriv/forget` | Stops the bot and deletes the saved token. |
| `GET /api/accounts[?refresh=1]` | The accounts on the token (refresh asks Deriv again). |
| `POST /api/account` `{id}` | Switches account (stops the bot). Real accounts need Allow real money (403). |
| `POST /api/close` `{id}` | Closes one open trade now. |
| `POST /api/close-all` | Closes every open trade now. |
| `POST /api/password` `{current, next}` | Changes the password and logs out other devices. |
| `GET /api/update` | `{commit, date, subject, branch, upstream, behind, ahead, message}`. |
| `POST /api/update` | `git pull --ff-only`, a self-test of the new code, then a restart if something changed: `{updated, from, to, message}`. If the new code can't start, or needs npm packages, it goes back to the current version and answers 502. |

## Files

- `server/main.mjs`: HTTP server, API, security, `set-password` and `self-test` commands.
- `server/engine.mjs`: the trading engine: Deriv connection, account, risk limits, open trades, and the demo-only auto trade of scanner setups (no single-market strategy of its own).
- `server/scanner.mjs`: the multi-market scanner (read-only market data; its ready setups go to the engine's demo-only auto-trade).
- `server/chart.mjs`: the chart's candles for the control page.
- `server/auth.mjs`: password hashing, sessions, login limits.
- `server/proxy-ips.mjs`: `TBOT_PROXY_IPS` parsing and matching.
- `server/setup.sh`, `server/uninstall.sh`, `server/docker-caddy.sh`: install, remove, and the Caddy-in-Docker step (tested by `tools/test-setup.sh`).
- `server/store.mjs`: the data folder.
- `server/public/`: the control page (`index.html`, `control.js`, `control.css`, and `chart.js`, the live chart, loaded once you are logged in).
- `server/chart.mjs`: the chart's candles for `/api/candles` and the open trades' plans.
