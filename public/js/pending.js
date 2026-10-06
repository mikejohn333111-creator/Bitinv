// "Waiting for price" plans. A strategy can say a setup has formed but price has not come
// back to the entry zone yet (ICT: the fair value gap; Rules: a pullback to the fast EMA).
// The bot keeps at most one such plan and checks it on every price update, not only when a
// candle closes. Pure functions and one small class: no DOM, no network, used by the browser
// bot (public/js/app.js) and the server bot (server/engine.mjs) alike, and unit tested.
//
// The plan is exactly what the bot executes: the stop loss and take profit are fixed prices,
// and the trade opened on a touch uses the distances from the touch price to those prices.

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** Checks a strategy's `pending` and fills in what the bot needs. Returns the plan or null. */
export function makePending(p, { strategy = "", symbol = "", barSec = 60, horizonBars = 0, now = 0 } = {}) {
  if (!p || (p.side !== "BUY" && p.side !== "SELL") || !Array.isArray(p.zone)) return null;
  const lo = Math.min(+p.zone[0], +p.zone[1]), hi = Math.max(+p.zone[0], +p.zone[1]);
  const { sl, tp, expiresAt, invalidateAt } = p;
  if (![lo, hi, sl, tp, expiresAt, invalidateAt].every(fin)) return null;
  const up = p.side === "BUY";
  // stop beyond the zone, target on the other side, invalidation not inside the zone
  if (up ? !(sl < lo && tp > hi && invalidateAt < lo) : !(sl > hi && tp < lo && invalidateAt > hi)) return null;
  return {
    id: String(p.id || `${strategy}:${p.side}:${expiresAt}`), side: p.side, zone: [lo, hi], sl, tp, expiresAt, invalidateAt,
    reason: String(p.reason || ""), sticky: p.sticky !== false, horizonBars: p.horizonBars ?? horizonBars,
    strategy, symbol, barSec, createdAt: now, ...(fin(p.since) && { since: p.since }),
  };
}

/** The zone edge price reaches first: the top for a buy (price comes down), the bottom for a sell. */
export const firstTouch = (plan) => (plan.side === "BUY" ? plan.zone[1] : plan.zone[0]);

/**
 * What a new price does to a waiting plan. nowSec is the time in epoch seconds.
 * Returns {kind: "enter"} | {kind: "cancel", why, text} | {kind: "wait"}.
 */
export function pendingCheck(plan, price, nowSec) {
  if (!plan) return { kind: "wait" };
  if (fin(nowSec) && nowSec >= plan.expiresAt) return { kind: "cancel", why: "expired", text: "price did not come back in time" };
  if (!fin(price)) return { kind: "wait" };
  const up = plan.side === "BUY", [lo, hi] = plan.zone;
  if (up ? price <= plan.invalidateAt : price >= plan.invalidateAt)
    return { kind: "cancel", why: "invalid", text: `price went ${up ? "below" : "above"} ${up ? "the low" : "the high"} the setup was built on` };
  if (price >= lo && price <= hi) return { kind: "enter" };
  if (up ? price < lo : price > hi) return { kind: "cancel", why: "through", text: "price jumped past the entry zone" };
  return { kind: "wait" };
}

/**
 * The trade a touch opens: the same stop loss and take profit prices as the plan, so the
 * distances are measured from the touch price. Null when they would not make sense.
 */
export function pendingEntry(plan, price) {
  const up = plan.side === "BUY";
  const slDist = up ? price - plan.sl : plan.sl - price, tpDist = up ? plan.tp - price : price - plan.tp;
  if (!(slDist > 0) || !(tpDist > 0)) return null;
  return { action: plan.side, slDist, tpDist, horizonBars: plan.horizonBars || 0, entry: price,
           reason: plan.reason.replace(/Waiting for price to come back to/i, "Price came back to").replace(/Waiting for a pullback/i, "Pulled back"),
           pendingId: plan.id, setupId: plan.id };
}

/**
 * Keeps the one waiting plan. The bot calls offer() after each strategy check at a candle
 * close, price() on every price update, and cancel() on stop, market, strategy or timeframe
 * changes. Every method returns an event for the bot to act on and log, or null.
 */
export class PendingPlan {
  constructor() { this.plan = null; this.done = new Set(); }

  /** A strategy result after a candle closed. */
  offer(res, ctx) {
    const next = makePending(res?.pending, ctx);
    const cur = this.plan;
    if (next && this.done.has(next.id)) return null;          // already entered or cancelled
    if (!next) {
      // The setup is no longer there. ICT plans keep their own levels until they expire;
      // a Rules plan follows the indicators, so it goes when they no longer agree.
      if (cur && !cur.sticky) return this.cancel("gone", "the trend no longer agrees");
      return null;
    }
    if (cur && cur.id === next.id) {
      const moved = cur.zone[0] !== next.zone[0] || cur.zone[1] !== next.zone[1] || cur.sl !== next.sl || cur.tp !== next.tp;
      if (cur.sticky || !moved) return null;
      this.plan = { ...next, createdAt: cur.createdAt };
      return { type: "update", plan: this.plan };
    }
    const replaced = cur;
    if (cur) this.#forget(cur);
    this.plan = next;
    return { type: "new", plan: next, replaced };
  }

  /** A new price. Enters, cancels or keeps waiting. */
  price(price, nowSec) {
    const plan = this.plan;
    if (!plan) return null;
    const r = pendingCheck(plan, price, nowSec);
    if (r.kind === "wait") return null;
    if (r.kind === "cancel") return this.cancel(r.why, r.text);
    const sig = pendingEntry(plan, price);
    if (!sig) return this.cancel("bad", "the stop or target would be on the wrong side");
    this.#forget(plan);
    this.plan = null;
    return { type: "enter", plan, signal: sig };
  }

  cancel(why, text) {
    const plan = this.plan;
    if (!plan) return null;
    this.#forget(plan);
    this.plan = null;
    return { type: "cancel", plan, why, text };
  }

  /** True when a closed-candle signal belongs to a setup that was already entered or cancelled. */
  used(setupId) { return !!setupId && this.done.has(setupId); }

  // An ICT setup is used once: after it is entered or cancelled it is never offered again.
  // A Rules plan is the trend's current pullback level, so a later one may come back.
  #forget(plan) {
    if (!plan.sticky) return;
    this.done.add(plan.id);
    if (this.done.size > 50) this.done.delete(this.done.values().next().value);
  }
}

/** One plain line describing a waiting plan, for logs and the status page. */
export function describePending(plan, fmt = (v) => String(v), when = (t) => String(t)) {
  if (!plan) return "";
  const up = plan.side === "BUY";
  return `${up ? "Buy" : "Sell"} if price comes back to ${fmt(plan.zone[0])} to ${fmt(plan.zone[1])}. ` +
         `Stop loss ${fmt(plan.sl)}, take profit ${fmt(plan.tp)}. ` +
         `Cancelled at ${when(plan.expiresAt)} or if price goes ${up ? "below" : "above"} ${fmt(plan.invalidateAt)}.`;
}
