// Position sizing for Deriv Multipliers and the daily risk limits.
//
// A Multiplier contract's profit/loss is  stake x multiplier x (price change / entry price),
// and the most it can lose is the stake. Deriv's stop loss and take profit are money
// amounts, so a stop at a price distance `slDist` costs  stake x multiplier x slDist / entry.

const roundDown = (v, d) => Math.floor(v * 10 ** d + 1e-9) / 10 ** d;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Picks the stake so that hitting the stop loses about riskPct of the balance.
 * Returns {ok, stake, stopLoss, takeProfit, risk, reason}.
 */
export function sizeMultiplier({ balance, riskPct, entry, slDist, tpDist, multiplier,
                                 minStake = 1, maxStake = Infinity, decimals = 2, maxStakePct = 50 }) {
  if (!(balance > 0) || !(entry > 0) || !(slDist > 0) || !(multiplier > 0))
    return { ok: false, reason: "missing balance, price or stop distance" };
  const target = (balance * riskPct) / 100;
  const lossPerStake = (multiplier * slDist) / entry;        // loss at the stop per 1 unit of stake
  if (lossPerStake >= 0.95)
    return { ok: false, reason: `x${multiplier} is too high for this stop (it would stop out first). Pick a lower multiplier.` };

  let stake = roundDown(target / lossPerStake, decimals);
  stake = Math.min(stake, maxStake, roundDown((balance * maxStakePct) / 100, decimals));
  if (stake < minStake) {
    if (minStake * lossPerStake > target * 1.5)
      return { ok: false, reason: `minimum stake ${minStake} would risk more than 1.5x your ${riskPct}% limit` };
    stake = minStake;
  }
  const stopLoss = Math.max(round(stake * lossPerStake, decimals), 10 ** -decimals);
  const takeProfit = Math.max(round((stake * multiplier * tpDist) / entry, decimals), 10 ** -decimals);
  return { ok: true, stake, stopLoss, takeProfit, risk: stopLoss };
}

/**
 * Daily loss limit, trade count and losing-streak cooldown. State is kept per
 * account and per UTC day in the given storage (localStorage in the browser).
 */
export class RiskGuard {
  constructor(storage, accountId, limits) {
    this.storage = storage;
    this.key = `tbot:guard:${accountId}`;
    this.limits = limits;
    this.state = this.#load();
  }

  #today(now) { return new Date(now).toISOString().slice(0, 10); }

  #load() {
    try { return JSON.parse(this.storage?.getItem(this.key)) || {}; } catch { return {}; }
  }

  #save() {
    try { this.storage?.setItem(this.key, JSON.stringify(this.state)); } catch { /* private mode */ }
  }

  /** Call with the current balance; starts a new day when the UTC date changes. */
  update(balance, now = Date.now()) {
    const day = this.#today(now);
    if (this.state.day !== day) {
      this.state = { day, startBalance: balance, trades: 0, halted: false, haltReason: "",
                     lossStreak: this.state.lossStreak || 0, cooldownUntil: this.state.cooldownUntil || 0 };
      this.#save();
    }
    const pl = this.dayPL(balance);
    if (!this.state.halted && this.limits.maxDailyLossPct > 0 && pl <= -this.limits.maxDailyLossPct) {
      this.state.halted = true;
      this.state.haltReason = `daily loss limit hit (${pl.toFixed(2)}%)`;
      this.#save();
      return { justHalted: true };
    }
    return { justHalted: false };
  }

  dayPL(balance) {
    return this.state.startBalance > 0 ? ((balance - this.state.startBalance) / this.state.startBalance) * 100 : 0;
  }

  /** Why a new trade is not allowed right now, or "" if it is. */
  blockReason(openCount, now = Date.now()) {
    if (this.state.halted) return this.state.haltReason || "halted for today";
    if (now < (this.state.cooldownUntil || 0)) return `cooling down after ${this.limits.maxConsecLosses} losses`;
    if (this.limits.maxOpen > 0 && openCount >= this.limits.maxOpen) return "max open trades reached";
    if (this.limits.maxTradesPerDay > 0 && this.state.trades >= this.limits.maxTradesPerDay) return "max trades for today reached";
    return "";
  }

  recordEntry() { this.state.trades = (this.state.trades || 0) + 1; this.#save(); }

  recordClose(profit, now = Date.now()) {
    this.state.lossStreak = profit < 0 ? (this.state.lossStreak || 0) + 1 : 0;
    if (this.limits.maxConsecLosses > 0 && this.state.lossStreak >= this.limits.maxConsecLosses) {
      this.state.cooldownUntil = now + this.limits.cooldownMinutes * 60000;
      this.state.lossStreak = 0;
    }
    this.#save();
  }
}
