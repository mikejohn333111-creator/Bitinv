// The markets the bot can trade, from Deriv's own list (active_symbols), with the built-in
// synthetic indices (SYMBOLS in config.js) as the fallback when the list can't be loaded.
// Pure functions: the browser bot and the server bot call Deriv, then hand the answer here.
import { SYMBOLS } from "./config.js";

/**
 * The request: a short list, only markets that offer Multipliers (MULTUP / MULTDOWN).
 * Deriv's trader app asks the same way. If Deriv refuses the contract_type filter, the bot
 * asks again with PLAIN_REQUEST and keeps the market groups that have Multipliers.
 */
export const MARKETS_REQUEST = Object.freeze({ active_symbols: "brief", contract_type: ["MULTUP", "MULTDOWN"] });
export const PLAIN_REQUEST = Object.freeze({ active_symbols: "brief" });

const GROUPS = [
  ["synthetic_index", "Synthetic indices"], ["forex", "Forex"], ["commodities", "Commodities"],
  ["cryptocurrency", "Crypto"], ["indices", "Stock indices"], ["stocks", "Stocks"],
];
const GROUP_ORDER = GROUPS.map(([k]) => k);
const MULTIPLIER_MARKETS = new Set(["synthetic_index", "forex", "commodities", "cryptocurrency"]);

/** The built-in list, in the same shape as a loaded one. */
export const FALLBACK_MARKETS = Object.freeze(SYMBOLS.map(([symbol, name]) => Object.freeze({
  symbol, name, market: "synthetic_index", marketName: "Synthetic indices", submarket: "random_index", open: true, suspended: false,
})));

/**
 * Turns an active_symbols answer into [{symbol, name, market, marketName, submarket, open, suspended}].
 * `filtered` says Deriv already kept only Multiplier markets; otherwise the market groups
 * that offer Multipliers are kept (contracts_for confirms it for the chosen market).
 */
export function parseMarkets(list, { filtered = true } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const symbol = String(a.underlying_symbol ?? a.symbol ?? "");
    if (!/^\w{2,30}$/.test(symbol) || seen.has(symbol)) continue;
    const market = String(a.market || "");
    if (!filtered && !MULTIPLIER_MARKETS.has(market)) continue;
    seen.add(symbol);
    out.push({
      symbol, name: String(a.display_name || a.underlying_symbol_name || symbol), market,
      marketName: GROUPS.find(([k]) => k === market)?.[1] || String(a.market_display_name || market || "Other"),
      submarket: String(a.submarket || ""), order: Number(a.display_order) || 0,
      open: a.exchange_is_open === undefined ? true : Number(a.exchange_is_open) === 1,
      suspended: Number(a.is_trading_suspended) === 1,
    });
  }
  return out;
}

/** Markets grouped for a picker, in a fixed group order: [{market, name, items}]. */
export function groupMarkets(markets) {
  const groups = new Map();
  for (const m of markets) {
    if (!groups.has(m.market)) groups.set(m.market, { market: m.market, name: m.marketName, items: [] });
    groups.get(m.market).items.push(m);
  }
  const rank = (k) => { const i = GROUP_ORDER.indexOf(k); return i < 0 ? GROUP_ORDER.length : i; };
  const list = [...groups.values()].sort((a, b) => rank(a.market) - rank(b.market) || a.name.localeCompare(b.name));
  for (const g of list) g.items.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
  return list;
}

/** The loaded list, or the built-in one when nothing usable came back. Keeps `current` listed. */
export function marketsOrFallback(markets, current) {
  const list = markets?.length ? [...markets] : [...FALLBACK_MARKETS];
  if (current && !list.some((m) => m.symbol === current)) {
    const fb = FALLBACK_MARKETS.find((m) => m.symbol === current);
    list.push(fb || { symbol: current, name: current, market: "other", marketName: "Other", submarket: "", open: true, suspended: false });
  }
  return list;
}

export const findMarket = (markets, symbol) => markets?.find((m) => m.symbol === symbol) || FALLBACK_MARKETS.find((m) => m.symbol === symbol) || null;
export const marketName = (markets, symbol) => findMarket(markets, symbol)?.name || symbol;
/** Synthetic indices run around the clock on a random number generator; everything else is a real market. */
export const isSynthetic = (markets, symbol) => (findMarket(markets, symbol)?.market ?? "synthetic_index") === "synthetic_index";
/** Closed (outside trading hours) or suspended: the bot doesn't trade then. */
export const isClosed = (markets, symbol) => { const m = findMarket(markets, symbol); return !!m && (!m.open || m.suspended); };
