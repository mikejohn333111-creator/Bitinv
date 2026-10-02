"""Feature and label definitions shared by training and the EA.

IMPORTANT: TbotAI.mq5 computes exactly these features in MQL5 (function
BuildFeatures). If you change anything here, change it there too, in the
same order, or the model will receive garbage in live trading.

Row t is the last CLOSED bar. Every feature uses only rows <= t.
ATR(t) = simple mean of the true range over the last 14 bars.
"""
import numpy as np
import pandas as pd

ATR_N = 14
RET_LAGS = (1, 2, 3, 5, 10, 15, 30, 60)
SMA_FAST, SMA_SLOW = 20, 60
RSI_N = 14
VOL_N = 240
RANGE_N = 60
WARMUP = max(VOL_N, max(RET_LAGS), SMA_SLOW, RANGE_N) + 2

FEATURE_NAMES = (
    [f"ret_{k}" for k in RET_LAGS]
    + ["dist_sma20", "dist_sma60", "range", "body", "upper_wick", "lower_wick",
       "rsi14", "vol_ratio", "pos_in_range60"]
)
N_FEATURES = len(FEATURE_NAMES)  # 17


def load_bars(path: str) -> pd.DataFrame:
    """Reads either an MT5 export (time,open,high,low,close[,...]) or a
    HistData ASCII file (YYYYMMDD HHMMSS;open;high;low;close;volume)."""
    with open(path) as f:
        first = f.readline()
    if ";" in first and first[:8].isdigit():
        df = pd.read_csv(path, sep=";", header=None,
                         names=["time", "open", "high", "low", "close", "volume"])
        df["time"] = pd.to_datetime(df["time"], format="%Y%m%d %H%M%S")
    else:
        df = pd.read_csv(path)
        df.columns = [c.lower() for c in df.columns]
        df["time"] = pd.to_datetime(df["time"])
    return df[["time", "open", "high", "low", "close"]].sort_values("time").reset_index(drop=True)


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift(1)
    return pd.concat([df["high"], pc], axis=1).max(axis=1) - pd.concat([df["low"], pc], axis=1).min(axis=1)


def build_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Returns (X float32 [N, 17], atr [N]). Rows inside the warm-up are NaN."""
    o, h, l, c = (df[k].astype(float) for k in ("open", "high", "low", "close"))
    tr = true_range(df)
    atr = tr.rolling(ATR_N).mean()

    cols = {}
    for k in RET_LAGS:
        cols[f"ret_{k}"] = (c - c.shift(k)) / atr
    cols["dist_sma20"] = (c - c.rolling(SMA_FAST).mean()) / atr
    cols["dist_sma60"] = (c - c.rolling(SMA_SLOW).mean()) / atr
    cols["range"] = (h - l) / atr
    cols["body"] = (c - o) / atr
    cols["upper_wick"] = (h - np.maximum(o, c)) / atr
    cols["lower_wick"] = (np.minimum(o, c) - l) / atr

    d = c.diff()
    gain = d.clip(lower=0).rolling(RSI_N).sum()
    loss = (-d.clip(upper=0)).rolling(RSI_N).sum()
    cols["rsi14"] = np.where(gain + loss > 0, gain / (gain + loss), 0.5) - 0.5
    cols["vol_ratio"] = atr / tr.rolling(VOL_N).mean()
    hh = h.rolling(RANGE_N).max()
    ll = l.rolling(RANGE_N).min()
    cols["pos_in_range60"] = np.where(hh > ll, (c - ll) / (hh - ll), 0.5) - 0.5

    X = pd.DataFrame(cols)[FEATURE_NAMES]
    X.iloc[:WARMUP] = np.nan
    X = X.replace([np.inf, -np.inf], np.nan).clip(-50, 50)
    return X.to_numpy(np.float32), atr.to_numpy()


def build_labels(df: pd.DataFrame, atr: np.ndarray, barrier_atr: float, horizon: int):
    """Triple-barrier labels. Entry at close of bar t, barrier B = barrier_atr*ATR(t).
    2 = price hit +B first (long wins), 0 = hit -B first (short wins),
    1 = neither within `horizon` bars, or both inside the same bar (ambiguous).
    Also returns the move at timeout in units of B (for P/L of timed-out trades)
    and a flag for bars where both barriers were touched in the same bar."""
    h, l, c = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    n = len(c)
    B = barrier_atr * atr
    up, dn = c + B, c - B
    first_up = np.full(n, horizon + 1)
    first_dn = np.full(n, horizon + 1)
    for j in range(horizon, 0, -1):          # iterate backwards so the smallest j wins
        hj = np.full(n, np.nan); lj = np.full(n, np.nan)
        hj[:n - j] = h[j:]; lj[:n - j] = l[j:]
        first_up = np.where(hj >= up, j, first_up)
        first_dn = np.where(lj <= dn, j, first_dn)
    y = np.ones(n, dtype=np.int64)
    y[first_up < first_dn] = 2
    y[first_dn < first_up] = 0
    ct = np.full(n, np.nan); ct[:n - horizon] = c[horizon:]
    timeout_move = (ct - c) / B
    tie = (first_up == first_dn) & (first_up <= horizon)
    valid = np.isfinite(B) & (B > 0) & (np.arange(n) < n - horizon)
    return y, timeout_move, tie, valid
