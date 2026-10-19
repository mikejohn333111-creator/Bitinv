import { test } from "node:test";
import assert from "node:assert/strict";
import { DerivSocket, isStreamClosed } from "../public/js/deriv.js";

// A stand-in WebSocket that records what the bot sends and lets the test play Deriv's side.
class FakeWS {
  static OPEN = 1; static CLOSED = 3; static last = null;
  constructor() { this.readyState = 0; this.sent = []; FakeWS.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  reply(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("isStreamClosed spots Deriv's closed-stream error only", () => {
  assert.equal(isStreamClosed({ message: "subscription closed by server" }), true);
  assert.equal(isStreamClosed({ code: "SubscriptionClosed" }), true);
  assert.equal(isStreamClosed({ message: "Invalid symbol" }), false);
});

test("a stream Deriv closes is asked for again, without an error shown", async (t) => {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  t.after(() => { globalThis.WebSocket = real; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [], got = [];
  const sock = new DerivSocket(async () => "wss://fake", { onError: (e) => errors.push(e.message) });
  await sock.connect();
  t.mock.timers.tick(1);
  const ws = FakeWS.last;
  sock.subscribe({ ticks_history: "R_75", style: "candles" }, (m) => got.push(m));
  const req = ws.sent.at(-1);
  ws.reply({ req_id: req.req_id, candles: [], subscription: { id: "s1" } });
  ws.reply({ req_id: req.req_id, error: { code: "WrongResponse", message: "subscription closed by server" } });
  assert.deepEqual(errors, []);
  assert.equal(got.length, 1);                 // the error isn't passed on as data
  const before = ws.sent.length;
  t.mock.timers.tick(1000);
  assert.equal(ws.sent.length, before + 1);    // asked again
  assert.equal(ws.sent.at(-1).ticks_history, "R_75");
  assert.equal(ws.sent.at(-1).subscribe, 1);
  sock.close?.();
});

test("after several closes in a row with no data, the error is reported", async (t) => {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  t.after(() => { globalThis.WebSocket = real; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [];
  const sock = new DerivSocket(async () => "wss://fake", { onError: (e) => errors.push(e.message) });
  await sock.connect();
  t.mock.timers.tick(1);
  const ws = FakeWS.last;
  sock.subscribe({ proposal_open_contract: 1, contract_id: 5 }, () => {});
  const id = ws.sent.at(-1).req_id;
  for (let i = 0; i < 4; i++) { ws.reply({ req_id: id, error: { message: "subscription closed by server" } }); t.mock.timers.tick(20000); }
  assert.deepEqual(errors, []);
  ws.reply({ req_id: id, error: { message: "subscription closed by server" } });
  assert.deepEqual(errors, ["subscription closed by server"]);
  sock.close?.();
});
