"""Train and walk-forward test the TbotAI model on M1 bars, then export ONNX.

Examples
  # walk-forward test + export using an MT5 export (see ExportBars.mq5)
  python train.py --data data/EURUSD_M1.csv --spread 0.00008

  # several files (e.g. yearly HistData files) are concatenated in time order
  python train.py --data DAT_ASCII_EURUSD_M1_2024.csv DAT_ASCII_EURUSD_M1_2025.csv

  # sanity check on a simulated Volatility 75 index (pure random walk)
  python train.py --simulate-v75 --spread 0

What it does
  1. Builds 17 price features per closed M1 bar (features.py).
  2. Labels each bar: does price move +B or -B first within --horizon bars,
     where B = --barrier x ATR(14). The EA uses the same B as SL and TP.
  3. Walk-forward: train on --train-months, test on the next --test-months
     the model has never seen, then roll forward. The confidence threshold
     is picked on the last 20% of each training window, never on test data.
  4. Reports out-of-sample trades, win rate and expectancy after spread.
  5. Trains the final model on the most recent window and writes
     TbotAI.onnx + TbotAI_config.json for the EA.
"""
import argparse, json, sys
import numpy as np
import pandas as pd
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import (FEATURE_NAMES, N_FEATURES, build_features, build_labels, load_bars)

THRESHOLDS = np.round(np.arange(0.40, 0.76, 0.025), 3)


def simulate_v75(days: int, seed: int = 7) -> pd.DataFrame:
    """Volatility 75 Index as Deriv describes it: a random walk with constant
    75% annualised volatility, one tick every 2 seconds, open 24/7."""
    rng = np.random.default_rng(seed)
    ticks_per_min, minutes = 30, days * 1440
    sigma_tick = 0.75 / np.sqrt(365 * 1440 * ticks_per_min)
    logp = np.log(400000.0) + np.cumsum(rng.normal(0, sigma_tick, minutes * ticks_per_min))
    p = np.exp(logp).reshape(minutes, ticks_per_min)
    t = pd.date_range("2025-01-01", periods=minutes, freq="1min")
    return pd.DataFrame({"time": t, "open": p[:, 0], "high": p.max(1), "low": p.min(1), "close": p[:, -1]})


def make_model(seed: int = 0):
    return make_pipeline(StandardScaler(), MLPClassifier(
        hidden_layer_sizes=(32, 16), alpha=1e-3, batch_size=512, learning_rate_init=1e-3,
        max_iter=40, early_stopping=True, validation_fraction=0.1, n_iter_no_change=4,
        random_state=seed))


def trade_r(proba, y, tmove, tie, cost_r, thr, margin):
    """Net result in R of every trade the model would take at threshold thr.
    Long when P(up) >= thr and P(up) - P(down) >= margin; short mirrored.
    Win = +1R, loss or same-bar tie = -1R, timeout = move at exit; minus spread."""
    p_dn, p_up = proba[:, 0], proba[:, 2]
    longs = (p_up >= thr) & (p_up - p_dn >= margin)
    shorts = (p_dn >= thr) & (p_dn - p_up >= margin) & ~longs
    r_long = np.where(y == 2, 1.0, np.where(y == 0, -1.0, np.clip(tmove, -1, 1)))
    r_long = np.where(tie, -1.0, r_long)
    r_short = np.where(y == 0, 1.0, np.where(y == 2, -1.0, np.clip(-tmove, -1, 1)))
    r_short = np.where(tie, -1.0, r_short)
    r = np.concatenate([r_long[longs], r_short[shorts]])
    c = np.concatenate([cost_r[longs], cost_r[shorts]])
    return r - c, r


def no_overlap(idx_mask: np.ndarray, horizon: int) -> np.ndarray:
    """Keep at most one trade per `horizon` bars, like an EA with 1 open trade."""
    keep = np.zeros_like(idx_mask)
    nxt = -1
    for i in np.flatnonzero(idx_mask):
        if i >= nxt:
            keep[i] = True
            nxt = i + horizon
    return keep


def pick_threshold(proba, y, tmove, tie, cost_r, margin, min_trades):
    best = (None, 0.0)
    for thr in THRESHOLDS:
        net, _ = trade_r(proba, y, tmove, tie, cost_r, thr, margin)
        if len(net) >= min_trades and net.mean() > best[1]:
            best = (float(thr), float(net.mean()))
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="*", default=[])
    ap.add_argument("--simulate-v75", action="store_true")
    ap.add_argument("--sim-days", type=int, default=365)
    ap.add_argument("--barrier", type=float, default=3.0, help="SL = TP = barrier x ATR(14)")
    ap.add_argument("--horizon", type=int, default=60, help="max bars to hold")
    ap.add_argument("--spread", type=float, default=0.00008, help="round-trip cost in price units")
    ap.add_argument("--margin", type=float, default=0.10, help="P(dir) must beat P(opposite) by this")
    ap.add_argument("--train-months", type=int, default=12)
    ap.add_argument("--test-months", type=int, default=3)
    ap.add_argument("--subsample", type=int, default=2, help="use every Nth bar for training")
    ap.add_argument("--fixed-threshold", type=float, default=None,
                    help="skip validation and always use this threshold (diagnostic: shows raw edge)")
    ap.add_argument("--out", default="TbotAI")
    a = ap.parse_args()

    if a.simulate_v75:
        df = simulate_v75(a.sim_days)
    elif a.data:
        df = pd.concat([load_bars(p) for p in a.data]).drop_duplicates("time").sort_values("time").reset_index(drop=True)
    else:
        sys.exit("give --data files or --simulate-v75")
    print(f"bars: {len(df):,}  from {df.time.iloc[0]} to {df.time.iloc[-1]}")

    X, atr = build_features(df)
    y, tmove, tie, valid = build_labels(df, atr, a.barrier, a.horizon)
    ok = valid & np.isfinite(X).all(1)
    cost_r = a.spread / (a.barrier * atr)
    t = df["time"]
    print(f"median barrier = {np.nanmedian(a.barrier * atr):.6g} price units; "
          f"spread = {np.nanmedian(cost_r[ok]):.3f} R per trade")
    print("label mix  down/none/up = " + " / ".join(f"{np.mean(y[ok] == k):.3f}" for k in (0, 1, 2)))

    # ---- walk-forward ---------------------------------------------------
    rows, all_net, all_gross = [], [], []
    start = t.iloc[0] + pd.DateOffset(months=a.train_months)
    while start + pd.DateOffset(months=a.test_months) <= t.iloc[-1] + pd.Timedelta(days=1):
        tr_lo, te_hi = start - pd.DateOffset(months=a.train_months), start + pd.DateOffset(months=a.test_months)
        tr = np.flatnonzero(ok & (t >= tr_lo) & (t < start))
        te = np.flatnonzero(ok & (t >= start) & (t < te_hi))
        # purge: drop training rows whose label window reaches into the test period
        tr = tr[tr < (te[0] - a.horizon if len(te) else len(t))]
        if len(tr) < 5000 or len(te) < 1000:
            start += pd.DateOffset(months=a.test_months); continue
        cut = int(len(tr) * 0.8)
        fit, val = tr[:cut - a.horizon][::a.subsample], tr[cut:]
        m = make_model().fit(X[fit], y[fit])

        if a.fixed_threshold is not None:
            thr = a.fixed_threshold
        else:
            thr, val_exp = pick_threshold(m.predict_proba(X[val]), y[val], tmove[val], tie[val], cost_r[val],
                                          a.margin, min_trades=100)
        pr = m.predict_proba(X[te])
        acc = float((pr.argmax(1) == y[te]).mean())
        base = float(max(np.mean(y[te] == k) for k in (0, 1, 2)))
        if thr is None:
            net = gross = np.array([])
        else:
            # simulate one-trade-at-a-time on the test window
            p_dn, p_up = pr[:, 0], pr[:, 2]
            sig = ((p_up >= thr) & (p_up - p_dn >= a.margin)) | ((p_dn >= thr) & (p_dn - p_up >= a.margin))
            keep = no_overlap(sig, a.horizon)
            net, gross = trade_r(pr[keep], y[te][keep], tmove[te][keep], tie[te][keep], cost_r[te][keep], thr, a.margin)
        all_net.append(net); all_gross.append(gross)
        rows.append(dict(test_from=str(start.date()), threshold=thr, acc=round(acc, 3), majority=round(base, 3),
                         trades=len(net), win_rate=round(float((net > 0).mean()), 3) if len(net) else None,
                         gross_R=round(float(gross.mean()), 3) if len(net) else None,
                         net_R=round(float(net.mean()), 3) if len(net) else None,
                         total_net_R=round(float(net.sum()), 1)))
        print(rows[-1], flush=True)
        start += pd.DateOffset(months=a.test_months)

    net, gross = np.concatenate(all_net) if all_net else np.array([]), np.concatenate(all_gross) if all_gross else np.array([])
    summary = dict(folds=len(rows), trades=int(len(net)),
                   win_rate=round(float((net > 0).mean()), 3) if len(net) else None,
                   avg_gross_R=round(float(gross.mean()), 4) if len(net) else None,
                   avg_net_R=round(float(net.mean()), 4) if len(net) else None,
                   total_net_R=round(float(net.sum()), 1) if len(net) else 0.0)
    print("\nOUT-OF-SAMPLE SUMMARY:", summary)

    # ---- final model on the most recent window ----------------------------
    lo = t.iloc[-1] - pd.DateOffset(months=a.train_months)
    tr = np.flatnonzero(ok & (t >= lo))
    cut = int(len(tr) * 0.8)
    fit, val = tr[:cut - a.horizon][::a.subsample], tr[cut:]
    m = make_model().fit(X[fit], y[fit])
    thr, val_exp = pick_threshold(m.predict_proba(X[val]), y[val], tmove[val], tie[val], cost_r[val], a.margin, 100)
    m = make_model().fit(X[tr[::a.subsample]], y[tr[::a.subsample]])  # refit on the whole window

    from skl2onnx import to_onnx
    onx = to_onnx(m, X[:1], options={"zipmap": False}, target_opset={"": 13, "ai.onnx.ml": 3})
    with open(a.out + ".onnx", "wb") as f:
        f.write(onx.SerializeToString())

    import onnxruntime as ort
    s = ort.InferenceSession(onx.SerializeToString())
    diff = np.abs(s.run(None, {s.get_inputs()[0].name: X[tr[-500:]]})[1] - m.predict_proba(X[tr[-500:]])).max()

    cfg = dict(features=FEATURE_NAMES, n_features=N_FEATURES, classes=["down", "none", "up"],
               barrier_atr=a.barrier, horizon_bars=a.horizon, margin=a.margin,
               suggested_threshold=thr, validation_expectancy_R=round(val_exp, 4),
               trained_from=str(t.iloc[tr[0]]), trained_to=str(t.iloc[tr[-1]]),
               walk_forward=summary, folds=rows, onnx_max_abs_diff=float(diff))
    with open(a.out + "_config.json", "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"\nwrote {a.out}.onnx and {a.out}_config.json (onnx vs sklearn max diff {diff:.2e})")
    if thr is None:
        print("NOTE: no threshold had positive expectancy on validation. The EA should not be run live with this model.")


if __name__ == "__main__":
    main()
