# TbotAI walk-forward results (2 October 2026)

All numbers are **out-of-sample**: each test quarter was never seen in training, and the confidence threshold was chosen on data before it. "R" is the risk per trade, so −0.30R means losing 30% of the amount risked on each trade on average. Setup: M1 bars, SL = TP = 3 × ATR(14), 60-bar time exit, one trade at a time.

## Simulated Volatility 75 (Deriv describes it as a random walk with 75% volatility)

Deriv's own price feed was blocked from the machine I worked on, so I simulated the index exactly as Deriv describes it: 540 days, one tick every 2 seconds, zero spread.

| Trades | Win rate | Avg per trade |
|---|---|---|
| 2,130 (5 folds) | 49.6% | −0.003R |

That's a coin flip, which is what you'd expect: with a random number generator there is nothing in the past to learn. Run `train.py` on your own exported V75 history to confirm on the real feed.

## Real EURUSD M1, 2022–2025 (1.44 million bars, 11 quarterly test folds)

Spread assumed at 0.8 pip per round trip (HistData bid prices).

**With the threshold chosen honestly on validation data:** no threshold showed a profit after spread in any of the 11 training windows, so the model **took no trades**. It correctly concluded there was nothing worth trading.

**Forced to trade anyway (to measure the raw signal):**

| Threshold | Trades | Win rate (after spread) | Avg before spread | Avg after spread | Quarters positive before spread |
|---|---|---|---|---|---|
| 0.50 | 10,105 | 49.9% | **+0.036R** | **−0.295R** | 10 of 11 |
| 0.55 | 5,135 | 49.0% | **+0.045R** | **−0.370R** | 9 of 11 |

## What this means

- The model does pick up a small, consistent pattern on EURUSD: a few percent of R per trade before costs.
- On the 1-minute chart, the spread costs about 0.3R per trade, roughly eight times that edge. Net, it loses money steadily.
- Classification accuracy (≈48%) was no better than always guessing the most common outcome. "AI" doesn't make one-minute moves predictable.
- The shipped `TbotAI.onnx` works end to end (Python and ONNX outputs match to 1e-7, and the EA's feature code matches the training code to 5e-7), but `suggested_threshold` is null. **Do not run it in Auto trade with real money.** Signals-only mode is fine for watching what it would do.

## Where an edge might exist

These are ideas to test with the same walk-forward script, not promises:

- Bigger targets (`--barrier 6 --horizon 240`), so the spread is a smaller share of each trade.
- Higher timeframes (M15/H1), where TbotAdaptive works.
- Instruments or account types with lower costs.
