"""Download 1-minute candles from Deriv's public API (no account needed).

Usage:  python fetch_deriv_m1.py R_75 150000      -> data/R_75_M1.csv
Symbols: R_10, R_25, R_50, R_75, R_100 (Volatility indices), frxEURUSD, ...
Note: for training the EA, prefer exporting from your own MT5 terminal with
ExportBars.mq5 so prices match your broker feed exactly.
"""
import json, os, sys, time
import pandas as pd
import websocket

APP_ID = 1089  # Deriv's public demo app id
URL = f"wss://ws.derivws.com/websockets/v3?app_id={APP_ID}"


def fetch(symbol: str, total: int) -> pd.DataFrame:
    ws = websocket.create_connection(URL, timeout=30)
    rows, end = [], "latest"
    while len(rows) < total:
        req = {"ticks_history": symbol, "style": "candles", "granularity": 60,
               "end": end, "count": 5000, "adjust_start_time": 1}
        ws.send(json.dumps(req))
        msg = json.loads(ws.recv())
        if "error" in msg:
            raise RuntimeError(msg["error"])
        candles = msg.get("candles", [])
        if not candles:
            break
        rows = candles + rows
        end = candles[0]["epoch"] - 1
        print(f"{symbol}: {len(rows)} candles, back to {pd.to_datetime(end, unit='s')}", flush=True)
        time.sleep(0.3)
    ws.close()
    df = pd.DataFrame(rows).drop_duplicates("epoch").sort_values("epoch")
    df["time"] = pd.to_datetime(df["epoch"], unit="s")
    return df[["time", "open", "high", "low", "close"]].astype(
        {"open": float, "high": float, "low": float, "close": float}).tail(total).reset_index(drop=True)


if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "R_75"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 150000
    os.makedirs("data", exist_ok=True)
    out = os.path.join("data", f"{sym}_M1.csv")
    fetch(sym, n).to_csv(out, index=False)
    print("saved", out)
