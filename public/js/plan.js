// The trade plan on the chart, like TradingView's long/short position tool: for every signal
// and every open trade, a green box from the entry to the take profit, a red box from the
// entry to the stop loss (from the entry candle to the planned close time, or the chart's
// right edge), and labelled price lines for the entry, stop loss and take profit.
//
// A "Waiting for price" plan (kind "pending") is drawn as a dashed entry zone box labelled
// "Waiting for price", with dashed stop loss and take profit lines, until price reaches the
// zone (it then becomes a normal trade plan) or the plan is cancelled (it is removed).
//
// The boxes are a series primitive (Lightweight Charts 4.1+), so they move with scrolling,
// zooming and the price scale by themselves. The pure helpers at the top have no DOM and
// are unit tested.

/** A number from Deriv (number or numeric string), or NaN. */
const n = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/**
 * The price level of a Deriv limit order (proposal_open_contract.limit_order.stop_loss or
 * .take_profit). Uses its price (value) when Deriv sends one; otherwise turns the money
 * amount (order_amount) into a price: distance = amount / (stake * multiplier) * entry.
 * Returns {price, money} (money is positive for both; NaN when unknown) or null.
 */
export function limitLevel(order, { side, kind, entry, stake, multiplier }) {
  if (!order || typeof order !== "object") return null;
  const money = Math.abs(n(order.order_amount));
  let price = n(order.value ?? order.price);
  if (!Number.isFinite(price) && Number.isFinite(money) && entry > 0 && stake > 0 && multiplier > 0) {
    const dist = (money / (stake * multiplier)) * entry;
    const up = side === "BUY";
    price = kind === "tp" ? (up ? entry + dist : entry - dist) : (up ? entry - dist : entry + dist);
  }
  if (!Number.isFinite(price)) return null;
  return { price, money: Number.isFinite(money) ? money : NaN };
}

/**
 * Updates a trade's plan from a proposal_open_contract message. `plan` is what the bot
 * already knows (from the signal), or {} for a trade picked up from the portfolio.
 * Returns the merged plan: {side, entry, sl, tp, slMoney, tpMoney, start, multiplier, stake}.
 */
export function planFromContract(poc, plan = {}) {
  const side = String(poc.contract_type || "").includes("DOWN") ? "SELL" : poc.contract_type ? "BUY" : plan.side;
  const entry = n(poc.entry_spot ?? poc.entry_tick);
  const out = { ...plan, side };
  if (Number.isFinite(entry) && entry > 0) out.entry = entry;
  const stake = n(poc.buy_price), multiplier = n(poc.multiplier);
  if (stake > 0) out.stake = stake;
  if (multiplier > 0) out.multiplier = multiplier;
  const t = n(poc.entry_tick_time ?? poc.date_start);
  if (Number.isFinite(t) && t > 0 && !out.start) out.start = Math.floor(t / 60) * 60;
  const lo = poc.limit_order || {};
  const ctx = { side, entry: out.entry, stake: out.stake, multiplier: out.multiplier };
  const sl = limitLevel(lo.stop_loss, { ...ctx, kind: "sl" }), tp = limitLevel(lo.take_profit, { ...ctx, kind: "tp" });
  if (sl) { out.sl = sl.price; if (Number.isFinite(sl.money)) out.slMoney = sl.money; }
  if (tp) { out.tp = tp.price; if (Number.isFinite(tp.money)) out.tpMoney = tp.money; }
  return out;
}

/** True when a plan can be drawn: entry (or the waiting zone), stop loss and take profit on the right sides. */
export function drawable(p) {
  if (p?.kind === "pending") {
    if (!Array.isArray(p.zone) || ![p.zone[0], p.zone[1], p.sl, p.tp].every(Number.isFinite)) return false;
    const lo = Math.min(...p.zone), hi = Math.max(...p.zone);
    return p.side === "SELL" ? p.tp < lo && p.sl > hi : p.tp > hi && p.sl < lo;
  }
  if (!p || ![p.entry, p.sl, p.tp].every(Number.isFinite)) return false;
  return p.side === "SELL" ? p.tp < p.entry && p.sl > p.entry : p.tp > p.entry && p.sl < p.entry;
}

// ------------------------------------------------------------------ drawing
const FADE_MS = 2500;

/** Draws the plans' boxes. One instance is attached to the candle series. */
class PlanPrimitive {
  constructor(layer) { this.layer = layer; this.view = { zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached({ chart, series, requestUpdate }) { Object.assign(this, { chart, series, requestUpdate }); }
  detached() { this.chart = this.series = this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }

  /** A waiting plan's zone, stop and target stay in view: the price scale makes room for them. */
  autoscaleInfo() {
    const L = this.layer;
    if (!L.visible) return null;
    let lo = Infinity, hi = -Infinity;
    for (const p of L.plans.values()) {
      if (p.kind !== "pending" || p.closedAt || !drawable(p)) continue;
      lo = Math.min(lo, p.sl, p.tp, ...p.zone); hi = Math.max(hi, p.sl, p.tp, ...p.zone);
    }
    return Number.isFinite(lo) ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }

  /**
   * x of a time on the chart's timeframe (tf seconds per candle): the candle that contains it,
   * also for times to the right of the last candle. With `within`, the part of the candle
   * already passed is added (for the planned close time).
   */
  x(time, within = false) {
    const ts = this.chart.timeScale(), tf = this.layer.tf();
    const candle = Math.floor(time / tf) * tf, frac = within ? (time - candle) / tf : 0;
    const last = this.layer.lastTime();
    let ref = candle, steps = frac;
    if (last && candle > last) { ref = last; steps += (candle - last) / tf; }
    if (!steps) return ts.timeToCoordinate(ref);
    const xr = ts.timeToCoordinate(ref);
    const l = xr === null ? null : ts.coordinateToLogical(xr);
    return l === null ? null : ts.logicalToCoordinate(l + steps);
  }

  draw(target) {
    const L = this.layer;
    if (!L.visible || !this.series) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const pal = L.palette(), now = Date.now();
      for (const p of L.plans.values()) {
        if (!drawable(p)) continue;
        let alpha = p.stale ? 0.45 : 1;
        if (p.closedAt) alpha *= Math.max(0, 1 - (now - p.closedAt) / FADE_MS);
        if (alpha <= 0) continue;
        if (p.kind === "pending") { this.drawPending(ctx, p, pal, alpha, { bitmapSize, hr, vr }); continue; }
        const yE = this.series.priceToCoordinate(p.entry), yS = this.series.priceToCoordinate(p.sl), yT = this.series.priceToCoordinate(p.tp);
        if ([yE, yS, yT].some((v) => v === null)) continue;
        let x0 = p.start ? this.x(p.start) : null;
        if (x0 === null) x0 = 0;
        let x1 = p.end ? this.x(p.end, true) : null;
        if (x1 === null || x1 <= x0) x1 = bitmapSize.width / hr;
        const X0 = Math.round(x0 * hr), X1 = Math.round(x1 * hr);
        const box = (yA, yB, fill, line) => {
          const top = Math.round(Math.min(yA, yB) * vr), h = Math.max(1, Math.round(Math.abs(yB - yA) * vr));
          ctx.globalAlpha = alpha;
          ctx.fillStyle = fill;
          ctx.fillRect(X0, top, X1 - X0, h);
          ctx.fillStyle = line;
          ctx.fillRect(X0, top, Math.max(1, Math.round(hr)), h);   // left edge at the entry candle
        };
        box(yE, yT, pal.tpFill, pal.tpLine);
        box(yE, yS, pal.slFill, pal.slLine);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = pal.entry;
        ctx.fillRect(X0, Math.round(yE * vr) - Math.round(vr / 2), X1 - X0, Math.max(1, Math.round(vr * 1.5)));
      }
      ctx.globalAlpha = 1;
    });
  }

  /** The waiting zone: a dashed box from when the plan was made to when it expires, labelled. */
  drawPending(ctx, p, pal, alpha, { bitmapSize, hr, vr }) {
    const yA = this.series.priceToCoordinate(Math.max(...p.zone)), yB = this.series.priceToCoordinate(Math.min(...p.zone));
    if (yA === null || yB === null) return;
    let x0 = p.start ? this.x(p.start) : null;
    if (x0 === null) x0 = 0;
    let x1 = p.end ? this.x(p.end, true) : null;
    if (x1 === null || x1 <= x0) x1 = bitmapSize.width / hr;
    const X0 = Math.round(x0 * hr), X1 = Math.round(x1 * hr);
    const top = Math.round(Math.min(yA, yB) * vr), h = Math.max(2, Math.round(Math.abs(yB - yA) * vr));
    const up = p.side !== "SELL";
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = up ? pal.tpFill : pal.slFill;
    ctx.fillRect(X0, top, X1 - X0, h);
    ctx.strokeStyle = up ? pal.tpLine : pal.slLine;
    ctx.lineWidth = Math.max(1, Math.round(hr * 1.2));
    ctx.setLineDash([Math.round(5 * hr), Math.round(4 * hr)]);
    ctx.strokeRect(X0 + 0.5, top + 0.5, X1 - X0 - 1, h - 1);
    ctx.setLineDash([]);
    const fs = Math.round(11 * vr);
    ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = pal.entry;
    ctx.textBaseline = up ? "bottom" : "top";
    // above the box for a buy (price comes down into it), below it for a sell; kept inside the chart
    const text = `Waiting for price · ${up ? "Buy" : "Sell"}`, pad = Math.round(4 * hr);
    const tx = Math.max(pad, Math.min(X0 + pad, Math.min(X1, bitmapSize.width) - ctx.measureText(text).width - pad));
    ctx.fillText(text, tx, up ? top - Math.round(3 * vr) : top + h + Math.round(3 * vr));
    ctx.restore();
  }
}

/**
 * Keeps the plans, their price lines and the drawing in step.
 * @param {object} o  {chart, series, palette: () => colours, label: (plan, kind) => line title,
 *                    lastTime: () => epoch of the chart's last candle, tf: () => seconds per chart candle}
 */
export class TradePlanLayer {
  constructor({ chart, series, palette, label, lastTime, tf = () => 60, onChange = () => {} }) {
    Object.assign(this, { chart, series, palette, label, lastTime, tf, onChange });
    this.plans = new Map();          // id -> plan {side, entry, sl, tp, slMoney, tpMoney, start, end, kind, stale, closedAt, lines}
    this.visible = true;
    this.primitive = new PlanPrimitive(this);
    series.attachPrimitive(this.primitive);
    this.fadeTimer = null;
  }

  /** Adds or updates a plan and redraws. */
  set(id, plan) {
    const old = this.plans.get(id);
    const p = { ...(old || {}), ...plan, lines: old?.lines || [] };
    this.plans.set(id, p);
    // Price lines are rebuilt only when what they show changes, not on every price update.
    const sig = JSON.stringify([p.kind, p.side, p.entry, p.sl, p.tp, p.slMoney, p.tpMoney, !!p.stale]);
    if (sig !== p.sig || !p.lines.length) { p.sig = sig; this.#lines(p); }
    this.redraw();
    return p;
  }

  get(id) { return this.plans.get(id); }

  /** Fades a plan out (a trade closed) and then removes it. */
  close(id) {
    const p = this.plans.get(id);
    if (!p || p.closedAt) return;
    p.closedAt = Date.now();
    this.#clearLines(p);
    clearInterval(this.fadeTimer);
    this.fadeTimer = setInterval(() => {
      const t = Date.now();
      for (const [k, q] of this.plans) if (q.closedAt && t - q.closedAt > FADE_MS) this.plans.delete(k);
      this.redraw();
      if (![...this.plans.values()].some((q) => q.closedAt)) clearInterval(this.fadeTimer);
    }, 120);
  }

  remove(id) { const p = this.plans.get(id); if (p) { this.#clearLines(p); this.plans.delete(id); this.redraw(); } }
  clear() { for (const id of [...this.plans.keys()]) this.remove(id); }

  setVisible(on) {
    this.visible = !!on;
    for (const p of this.plans.values()) this.#lines(p);
    this.redraw();
  }

  /** Colours changed (light/dark): rebuild the lines. */
  restyle() { for (const p of this.plans.values()) { this.#clearLines(p); this.#lines(p); } this.redraw(); }

  redraw() { this.primitive.requestUpdate?.(); try { this.onChange(this); } catch { /* display only */ } }

  /** True when a plan is showing (not fading out). */
  active() { return this.visible && [...this.plans.values()].some((p) => !p.closedAt && drawable(p)); }

  #clearLines(p) { for (const l of p.lines) { try { this.series.removePriceLine(l); } catch { /* already gone */ } } p.lines = []; }

  #lines(p) {
    this.#clearLines(p);
    if (!this.visible || p.closedAt || !drawable(p)) return;
    const pal = this.palette(), dim = p.stale;
    const line = (price, color, title, style) => this.series.createPriceLine({
      price, color: dim ? pal.dim : color, lineWidth: 1, lineStyle: style, axisLabelVisible: !dim, title, lineVisible: true,
    });
    p.lines = p.kind === "pending" ? [
      line(p.sl, pal.slLine, this.label(p, "sl"), 2),
      line(p.tp, pal.tpLine, this.label(p, "tp"), 2),
    ] : [
      line(p.entry, pal.entry, this.label(p, "entry"), 0),
      line(p.sl, pal.slLine, this.label(p, "sl"), 2),
      line(p.tp, pal.tpLine, this.label(p, "tp"), 2),
    ];
  }
}
