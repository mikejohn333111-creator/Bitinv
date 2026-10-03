// Deriv settings for this site.
//
// appId: the App ID you get when you register this site as an OAuth app at
// developers.deriv.com (Dashboard -> register application). It isn't secret. Leave it
// empty to have people paste it into the login card instead.
export const CONFIG = {
  appId: "",
  // The address registered as the app's redirect URL. Other addresses of this site
  // (Vercel preview links) can't log in, so the page points people here instead.
  siteUrl: "https://tbot-mauve-eta.vercel.app",
  authUrl: "https://auth.deriv.com",
  apiUrl: "https://api.derivws.com",
  publicWs: "wss://api.derivws.com/trading/v1/options/ws/public",
};

// Synthetic indices that offer Multipliers. Deriv generates these prices with a
// random number generator, so past prices don't predict future ones.
export const SYMBOLS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"], ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"], ["R_100", "Volatility 100 Index"],
  ["1HZ10V", "Volatility 10 (1s) Index"], ["1HZ25V", "Volatility 25 (1s) Index"],
  ["1HZ50V", "Volatility 50 (1s) Index"], ["1HZ75V", "Volatility 75 (1s) Index"],
  ["1HZ100V", "Volatility 100 (1s) Index"],
];
