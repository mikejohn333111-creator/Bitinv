# Tbot server

The web bot in `public/` only trades while its page is open. The server bot runs the same trading engine on a Linux server, 24/7. It keeps trading after you close the page, and after a crash, reboot or update it carries on by itself, until you press **Stop**.

You control it from a small password-protected page that works well on a phone.

## Read this first

No bot can guarantee profits. In our tests the strategies roughly broke even before costs and lost money after Deriv's commission (see the main `README.md`). Please stay on a demo account.

- The server starts in **Auto trade** mode on your **demo** account. That is the point of a server bot, and nothing trades until you press Start.
- It refuses real money accounts until you turn on **Allow real money** and type `REAL`.
- Every trade has a stop loss and take profit set at Deriv. Stopping the bot never closes trades. The daily loss limit closes them.

## What it does

- Uses the same strategy, sizing and risk-limit code as the browser (`public/js/strategy.js`, `risk.js`, `deriv.js`), and trades the same way: one check per closed 1-minute candle, a `proposal` then a `buy` with `underlying_symbol` and `limit_order`, open trades followed with `proposal_open_contract`, the daily loss limit checked on equity, and the AI model's time limit.
- Logs in to Deriv with a **Personal Access Token** (PAT) and your App ID. Each WebSocket connection gets a fresh one-time address, also after every reconnect.
- Saves settings, state and the activity log in a data folder, so a restart resumes trading and picks up open trades from Deriv's portfolio.
- If Deriv rejects the token, it stops trading and asks for a new token on the page. Network problems only cause reconnects.

A few things are stricter than in the browser, because a server runs unattended and restarts:

- The daily loss limit starts counting only after open trades are loaded, so money in an open trade never looks like a loss after a restart. Every open Multiplier trade on the account is followed, also one on another market (after you change market) or one you opened yourself on Deriv's site. When the balance drops for a trade the bot doesn't know yet, it reloads the open trades before checking the limit.
- After a trade closes, the daily loss check waits (up to 15 seconds) for Deriv's new balance, so a closed trade's money is never missing for a moment.
- If the daily loss limit is hit and Deriv doesn't close a trade, the bot tries again on every candle, also after a restart.
- If a buy's answer is lost, the bot looks for the trade again after 5, 15, 45 and 90 seconds and trades nothing meanwhile. A trade that turns up late keeps its AI time limit.
- If Deriv's price feed goes quiet for 3 minutes while the connection looks fine, the bot connects again from scratch.
- A trade that closed while the bot was down (during an update or reboot) is looked up once, so its result is in the log and counts for the losing-streak pause.
- Pressing Stop while an order is being prepared cancels it before the buy.
- The limits move to the new day at the first candle of the UTC day, even if nothing else happens.
- The bot never trades twice on the same candle, never trades while it is still reloading open trades after a reconnect, and if a buy's answer is lost it reloads open trades before doing anything else.
- The AI time limit of each trade is saved, so it still applies after a restart. A close that fails is tried again on the next candle.

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
| `TBOT_TRUST_PROXY` | off | Set to `1` behind a reverse proxy on the same machine. `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are then trusted, but only from `127.0.0.1` or `::1`. |
| `TBOT_DEV` | off | Set to `1` for local testing over plain http: the cookies drop the `Secure` flag and the `__Host-` prefix. |
| `DERIV_API_URL` | `https://api.derivws.com` | Deriv's REST API. |
| `DERIV_PUBLIC_WS` | `wss://api.derivws.com/trading/v1/options/ws/public` | Deriv's public prices feed (used when no token is set). |
| `TBOT_GIT_DIR` | the repo | Only for tests: the git checkout that the Update button pulls. |

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

`node tools/e2e-server.mjs` runs the whole thing in a real browser (Playwright and Chromium needed): login, token, start, a restart with an open trade, closing it, settings, real money switch, log out, in light and dark mode. `npm test` runs the engine and API tests.

## The data folder

Mode 0700. Every file in it is mode 0600 and written atomically (temporary file, fsync, rename).

| File | What it holds |
|---|---|
| `auth.json` | scrypt hash of the page password |
| `sessions.json` | logged-in sessions, as SHA-256 hashes of the cookie (at most 20, 30 days each) |
| `devices.json` | devices that logged in before, as SHA-256 hashes of the known-device cookie (at most 20, 1 year each) |
| `secret.json` | Deriv App ID and token |
| `settings.json` | your settings |
| `state.json` | running or not, the chosen account, the last signal and trade candle, notes about open trades |
| `guard.json` | daily risk-limit counters per account |
| `log.jsonl` | the activity log, trimmed to the last 2000 lines |

The token is never written to the log, never printed, and never sent back to the page. The page only sees its last 4 characters.

## Security

- Password check with scrypt and a constant-time comparison. Session cookie `__Host-tbot_sid` (`tbot_sid` with `TBOT_DEV=1`): 32 random bytes, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, 30 days. The `__Host-` prefix means a page on another `*.sslip.io` name can't plant a cookie that hides the real one. If a request carries several values, any valid one counts.
- Login limits: 5 wrong passwords per IP (per /64 for IPv6) and 30 in total per 15 minutes, then 429 with `Retry-After`. Attempts are counted before the password is checked, so a burst can't slip through.
- A successful login also sets a known-device cookie `__Host-tbot_dev` (1 year). Logins from a known device skip the per-IP and shared limits and have their own limit of 5 wrong passwords, after which that device is forgotten. So strangers guessing passwords can't lock the owner out.
- The password-change form needs a session and is limited per session only.
- Every request that changes something must be a `POST` with `Content-Type: application/json`, an `Origin` header of this same site (and no cross-site `Sec-Fetch-Site`), and a body of at most 16 KB.
- On every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Strict-Transport-Security` when the request came over https. API answers have `Cache-Control: no-store`.
- Static files come only from `server/public/`, with dot files, unknown file types, encoded `..` and symlinks out of the folder refused.

## API

All under `/api/`, JSON in and out. Every call needs the session cookie except login and logout. Errors look like `{"error": "code", "message": "Plain text for the user."}`.

| Call | What it does |
|---|---|
| `GET /healthz` | `200 ok`, no login needed. |
| `POST /api/login` `{password}` | Sets the session cookie. 401 wrong password, 429 too many tries. |
| `POST /api/logout` | Ends this session. |
| `GET /api/status` | Everything the page shows: `running`, `mode`, `strategy`, `symbol`, `connection`, `account {id,type,currency}`, `balance`, `equity`, `dayPL` (%), `tradesToday`, `halted`, `haltReason`, `cooldownUntil`, `blockReason`, `lastPrice`, `lastEval` (what the strategy sees), `lastSignal` (kept across restarts), `resumedAt` (when it carried on by itself after a restart), `lastCost`, `open` trades (`id, side, symbol, stake, profit, opened, horizon`), `accounts`, `needsToken`, `hasToken`, `tokenHint` (last 4 characters), `appId`, `error`, `settings`, `limits`, `multipliers`, `version`. |
| `GET /api/log?after=<seq>` | Activity log entries newer than `seq` (up to 200), plus `last`. |
| `POST /api/start` | Starts the bot. 409 with a message if it can't (no token, real account not allowed, not connected yet). |
| `POST /api/stop` | Stops the bot. Open trades keep their stop loss and take profit. |
| `POST /api/settings` `{...}` | Changes some settings. Numbers are clamped to safe ranges. `allowReal: true` also needs `confirmReal: "REAL"`. Switching `mode` needs the bot stopped. A new `symbol` stops the bot. `aiFast: true` turns on fast mode (AI only, demo only: refused on a real account). |
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
- `server/engine.mjs`: the trading engine (a port of the engine in `public/js/app.js`).
- `server/auth.mjs`: password hashing, sessions, login limits.
- `server/store.mjs`: the data folder.
- `server/public/`: the control page (`index.html`, `control.js`, `control.css`).
