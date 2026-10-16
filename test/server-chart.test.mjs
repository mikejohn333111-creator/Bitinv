// The control page's chart data (server/chart.mjs): which candles the page gets, the trade
// plans it draws, and the Deriv requests for other timeframes (cached, limited, never stuck).
import test from "node:test";
import assert from "node:assert/strict";
import { CHART_TIMEFRAMES, CHART_BARS, ChartFeed, candlesAfter, tradePlan, planView } from "../server/chart.mjs";

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const bars = (from, n, tf, base = 100) => Array.from({ length: n }, (_, i) => ({ epoch: from + i * tf, open: base + i, high: base + i + 2, low: base + i - 1, close: base + i + 1 }));

/** Just what ChartFeed reads from the engine, with a socket that answers ticks_history by hand. */
function fakeEngine({ botTf = 60, symbol = "R_75", connection = "online" } = {}) {
  const e = {
    settings: { symbol }, botTf, bars: [], forming: null, connection, sent: [], answers: [],
    tf() { return this.botTf; },
    socket: {
      send(req) {
        e.sent.push(req);
        if (e.connection !== "online") return Promise.reject(new Error("not connected"));
        return new Promise((resolve, reject) => e.answers.push({ req, resolve, reject }));
      },
    },
  };
  return e;
}
const answer = (e, candles) => e.answers.shift().resolve({ msg_type: "candles", candles: candles.map((b) => ({ ...b, open: String(b.open) })) });

test("candlesAfter: everything at first or after a gap, then only the newest candle and newer", () => {
  const list = bars(600, 5, 60);
  assert.deepEqual(candlesAfter(list, 0), { full: true, candles: list.map((b) => [b.epoch, b.open, b.high, b.low, b.close]) });
  assert.deepEqual(candlesAfter(list, null).full, true);
  assert.deepEqual(candlesAfter(list, 780), { full: false, candles: [[780, 103, 105, 102, 104], [840, 104, 106, 103, 105]] });
  assert.deepEqual(candlesAfter(list, 99999), { full: false, candles: [] }, "nothing new");
  assert.equal(candlesAfter(list, 60).full, true, "the page's newest candle is older than all of these: start again");
  assert.deepEqual(candlesAfter([], 600), { full: true, candles: [] });
});

test("tradePlan: Deriv's entry and limit orders, from the entry candle to the time limit; planView keeps only what the page draws", () => {
  const poc = { contract_type: "MULTUP", entry_spot: "200", buy_price: 10, multiplier: 100, date_start: 1000,
                limit_order: { stop_loss: { order_amount: -1 }, take_profit: { order_amount: 2, value: 204 } } };
  const p = tradePlan(poc, { entryEpoch: 0 });
  assert.equal(p.side, "BUY");
  assert.equal(p.entry, 200);
  assert.equal(p.tp, 204);
  assert.ok(Math.abs(p.sl - 199.8) < 1e-9, "stop from the money: 1 / (10 x 100) x 200");
  assert.equal(p.start, 960, "the minute of the entry");
  assert.equal(p.end, undefined, "no time limit");
  const q = tradePlan({ contract_type: "MULTDOWN", buy_price: 10, multiplier: 100 }, { entryEpoch: 3600, horizon: 4, barSec: 3600 });
  assert.equal(q.start, 7200, "found after a restart: the candle after the signal");
  assert.equal(q.end, 3600 + 5 * 3600);
  assert.deepEqual(planView(p), { side: "BUY", entry: 200, sl: p.sl, tp: 204, slMoney: 1, tpMoney: 2, start: 960, end: null });
  assert.equal(planView(null), null);
  assert.equal(planView(q).entry, null, "unknown numbers are null, not NaN (JSON)");
});

test("ChartFeed: the bot's own timeframe is the engine's candles plus the forming one, capped, and asks Deriv nothing", async () => {
  const e = fakeEngine();
  e.bars = bars(0, 800, 60);
  e.forming = { epoch: 800 * 60, open: 1, high: 2, low: 0.5, close: 1.5 };
  const out = await new ChartFeed(e).candles("60");
  assert.equal(out.full, true);
  assert.equal(out.candles.length, CHART_BARS);
  assert.deepEqual(out.candles.at(-1), [48000, 1, 2, 0.5, 1.5]);
  assert.deepEqual({ symbol: out.symbol, tf: out.tf, botTf: out.botTf, live: out.live, message: out.message }, { symbol: "R_75", tf: 60, botTf: 60, live: true, message: "" });
  const next = await new ChartFeed(e).candles(60, 48000);
  assert.deepEqual(next, { ...out, full: false, candles: [[48000, 1, 2, 0.5, 1.5]] });
  assert.equal(e.sent.length, 0);
  await assert.rejects(new ChartFeed(e).candles("120"), RangeError);
  await assert.rejects(new ChartFeed(e).candles("abc"), RangeError);
  assert.deepEqual(CHART_TIMEFRAMES, [60, 300, 900, 3600, 14400, 86400]);
});

test("ChartFeed: another timeframe is loaded once with ticks_history, then follows the live price until a new candle starts", async () => {
  const t = { now: 1e6 };
  const e = fakeEngine();
  const feed = new ChartFeed(e, { now: () => t.now, minGapMs: 15000 });
  const first = feed.candles(3600);
  await flush();
  assert.deepEqual(e.sent, [{ ticks_history: "R_75", style: "candles", granularity: 3600, count: CHART_BARS, end: "latest", adjust_start_time: 1 }]);
  answer(e, bars(0, 3, 3600));   // 0, 3600 and the forming 7200
  const out = await first;
  assert.equal(out.candles.length, 3);
  assert.deepEqual(out.candles.at(-1), [7200, 102, 104, 101, 103]);

  // The bot's 1-minute candle inside the forming hour moves its close, high and low.
  e.forming = { epoch: 7200 + 600, open: 103, high: 110, low: 103, close: 109 };
  t.now += 60000;
  let r = await feed.candles(3600, 7200);
  assert.deepEqual(r.candles, [[7200, 102, 110, 101, 109]]);
  e.forming = { epoch: 7200 + 660, open: 109, high: 109, low: 100, close: 100.5 };
  r = await feed.candles(3600, 7200);
  assert.deepEqual(r.candles, [[7200, 102, 110, 100, 100.5]], "the high stays");
  assert.equal(e.sent.length, 1, "no new request while the live price keeps it up to date");

  // A new hour began: loaded again (behind the cached candles, which are answered at once).
  e.forming = { epoch: 10800, open: 100, high: 101, low: 99, close: 100 };
  r = await feed.candles(3600, 7200);
  assert.equal(e.sent.length, 2);
  assert.deepEqual(r.candles, [[7200, 102, 110, 100, 100.5]]);
  answer(e, bars(3600, 3, 3600, 200));
  await flush();
  r = await feed.candles(3600, 7200);
  assert.deepEqual(r.candles.map((c) => c[0]), [7200, 10800]);
  assert.equal(r.candles[1][4], 100, "and follows the live price again");
});

test("ChartFeed: a smaller timeframe than the bot's is asked again at most every 15 seconds; one request at a time", async () => {
  const t = { now: 1e6 };
  const e = fakeEngine({ botTf: 3600 });
  const feed = new ChartFeed(e, { now: () => t.now });
  const a = feed.candles(300), b = feed.candles(300);
  await flush();
  assert.equal(e.sent.length, 1, "two pages at once: one request");
  answer(e, bars(0, 4, 300));
  assert.equal((await a).candles.length, 4);
  assert.equal((await b).candles.length, 4);
  t.now += 14000;
  await feed.candles(300);
  assert.equal(e.sent.length, 1);
  t.now += 1000;
  const r = await feed.candles(300);
  assert.equal(e.sent.length, 2, "15 seconds later");
  assert.equal(r.candles.length, 4, "the cached candles meanwhile");
});

test("ChartFeed: not connected, a failed or slow request, and a market change give a clear empty chart, never a stuck one", async () => {
  const t = { now: 1e6 };
  const e = fakeEngine({ connection: "connecting" });
  const feed = new ChartFeed(e, { now: () => t.now, waitMs: 20 });
  let r = await feed.candles(900);
  assert.deepEqual([r.candles, r.live, r.full], [[], false, true]);
  assert.match(r.message, /Not connected to Deriv/);
  assert.equal(e.sent.length, 0, "nothing asked while offline");

  e.connection = "online";
  const p = feed.candles(900);
  await flush();
  e.answers.shift().reject(new Error("rate limit"));
  r = await p;
  assert.match(r.message, /didn't send these candles/);
  t.now += 15000;
  r = await feed.candles(900);   // asked again; Deriv is slow, so the page hears "loading" after waitMs
  assert.equal(e.sent.length, 2);
  assert.match(r.message, /Loading prices/);
  answer(e, bars(0, 2, 900));
  await flush();
  assert.equal((await feed.candles(900)).candles.length, 2);

  // The market changed: the old candles are dropped, and a late answer for the old market is ignored.
  t.now += 15000;
  e.settings.symbol = "R_100";
  r = await feed.candles(900, 900);
  assert.equal(r.symbol, "R_100");
  assert.deepEqual(r.candles, []);
  assert.equal(e.sent.at(-1).ticks_history, "R_100");
});
