# Strategy backtests: ICT, Rules and AI (6 October 2026, updated 16 and 20 October 2026)

Short version: none of the three strategies makes money after realistic costs in an out-of-sample test. The new ICT strategy behaves like a coin flip on simulated Volatility 75 (as anything must on a random walk), and on real EURUSD it loses after costs on M1 and M15. One row (ICT on H1) is slightly positive, but with 75 trades in two years its uncertainty is about five times the result, so it is not evidence of an edge.

All numbers are in R: 1R is the amount risked on a trade, so a stop loss costs -1R and +0.05R means winning 5% of the risk per trade on average. "±" is the 95% confidence interval of the average. If the interval includes zero, the result cannot be told apart from luck.

## Update, 20 October 2026: ICT audit on 11 markets, and five standard ICT additions

**Short version.** The ICT code is not missing entries by mistake: an independent re-count of every stage agrees with the bot's own trades to within 2%. It is selective on purpose. Of every 100 liquidity sweeps, about 35 break structure, 17 to 19 do so with a big enough candle, and 3 to 5 end up as trades. Five standard ICT ideas were added as options: previous-day and Asian-session liquidity, breaker block and OTE entries, a market structure shift by any close, and a second gap when price never came back to the first. They were chosen on 2010 to 2021 and tested once on 2022 to 2025, on 11 markets. None of them makes ICT profitable after costs. Before costs, every row is within about ±0.05R of zero.

- **1 hour (real markets): changed.** The pick was *MSS by close* together with *a later gap*. It gives about 60% more trades (0.90 a day across the 11 markets, up from 0.55). Out of sample it lost less: −0.03 ± 0.06R a trade, against −0.07 ± 0.08R. Total R, worst drawdown and losing months were the same or better. That passes the rule "not worse out of sample", so `ictParamsFor` now turns both on for real markets on 1h. The difference is well inside the noise. It is **not** evidence of an edge, and the strategy still loses a little after costs.
- **15 minutes: unchanged.** The pick (*a later gap*) was slightly worse out of sample: −0.080R against −0.071R a trade, and −203R against −157R in total. It stays off.
- **Liquidity pools (previous day, Asian range), order block, breaker and OTE entries** were all worse in the 2010 to 2021 training years on both timeframes. They stay in the code as options, off.
- **More trades is possible, but not for free.** Everything on together gives 2.8 trades a day on 15m (instead of 1.5) and 1.4 on 1h (instead of 0.55). On 15m the average per trade stays about the same, so the total loss doubles (−315R against −157R in 2022 to 2025). On 1h it looked better in 2022 to 2025 (−0.01R a trade) but was worse than the pick in training. The biggest single cut in the funnel is the kill zone: on 15m it removes 63% of otherwise valid entries. Turning it off would roughly triple the trades. It was not part of this test, and on EURUSD (16 October) trading all day did not do better.

### Funnel: where the setups go (current rules, 2010 to 2025, 11 markets, buys and sells)

Re-counted bar by bar with the same rules as `ictBullish` (15m with kill zones, 1h with the 4h trend, as the bot runs them on real markets). Per day is per calendar day, summed over the 11 markets.

| Stage | 15m count | 15m per day | 1h count | 1h per day |
|---|---:|---:|---:|---:|
| Wick through the latest untouched swing low/high | 530,598 | 91.3 | 139,926 | 24.1 |
| ... and the bar closes back inside (the sweep) | 247,545 | 42.6 | 68,230 | 11.7 |
| Close beyond the internal swing within 10 bars (MSS) | 87,205 | 15.0 | 24,543 | 4.2 |
| That breaking bar's body is ≥ 1 ATR (displacement) | 42,629 | 7.3 | 12,749 | 2.2 |
| A fair value gap in the leg | 36,216 | 6.2 | 10,572 | 1.8 |
| First revisit within 15 bars, closing in or above the gap | 24,311 | 4.2 | 6,614 | 1.1 |
| Stop at least 0.5 ATR | 24,309 | 4.2 | 6,614 | 1.1 |
| Inside a kill zone (15m) / with the 4h trend (1h) | 9,017 | 1.55 | 3,475 | 0.60 |
| Became a trade in the backtest | 8,214 | 1.41 | 3,159 | 0.54 |

What each condition removes:

- **No structure shift within 10 bars:** 65% of sweeps on both timeframes. Most sweeps are not reversals, and this is the core of the setup.
- **The breaking bar must itself be ≥ 1 ATR:** about half of the remaining shifts (51% on 15m, 48% on 1h). At 0.7 ATR, 68% to 70% would pass. If the big candle may be anywhere in the leg, 65% to 67% pass.
- **No gap in the leg:** 15% to 17%.
- **Revisit:** a third are lost. On 15m that is 6,847 never revisited in 15 bars (3,050 of them were revisited 16 to 60 bars later), 4,121 that closed through the gap, and 937 that hit the stop first. The 1h split is similar.
- **Minimum stop (0.5 ATR):** removes nothing. The sweep already puts the stop far enough away.
- **Kill zone:** 63% of otherwise valid 15m entries. **4h trend:** 47% of 1h entries (40% against the trend, 7% with no clear trend).
- **Already in a trade, or a newer setup takes over:** about 9%.
- **Bars required (history):** only affects the first 109 to 220 bars of the data.

### Results (pooled over the 11 markets; costs as a round trip in basis points of price)

Costs: FX 0.8bp (pessimistic 1.5), EURJPY/GBPJPY/SPX 1.5 (3), gold 2 (4). Win rate and gross R are before costs. Max drawdown is in R over the pooled trade sequence. Losing months counts calendar months with a negative total after main costs.

Chosen on 2010 to 2021 (best average after main costs), then tested once on 2022 to 2025:

| Timeframe | Variant | Period | Trades | Per day (11 mk) | Win | Gross R | Avg R, main costs | Avg R, pessimistic | Total R (main) | Max DD (R) | Losing months |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 15m | current | 2010-21 | 6030 | 1.38 | 40.2% | +0.012 | −0.049 ± 0.031 | −0.107 ± 0.031 | −297 | 354 | 60% |
| 15m | current | **2022-25** | 2212 | 1.51 | 38.4% | −0.009 | **−0.071 ± 0.052** | −0.129 ± 0.052 | −157 | 161 | 67% |
| 15m | pick: later gap | 2010-21 | 7078 | 1.61 | 42.0% | +0.018 | −0.036 ± 0.027 | −0.087 ± 0.027 | −255 | 281 | 57% |
| 15m | pick: later gap | **2022-25** | 2530 | 1.73 | 39.4% | −0.025 | **−0.080 ± 0.046** | −0.131 ± 0.046 | −203 | 233 | 69% |
| 1h | current | 2010-21 | 2419 | 0.55 | 43.4% | +0.008 | −0.019 ± 0.044 | −0.044 ± 0.044 | −45 | 89 | 53% |
| 1h | current | **2022-25** | 800 | 0.55 | 39.5% | −0.039 | **−0.066 ± 0.079** | −0.091 ± 0.079 | −53 | 58 | 60% |
| 1h | pick: MSS by close + later gap | 2010-21 | 3816 | 0.87 | 45.9% | +0.017 | −0.005 ± 0.031 | −0.026 ± 0.031 | −19 | 81 | 55% |
| 1h | pick: MSS by close + later gap | **2022-25** | 1322 | 0.90 | 43.3% | −0.006 | **−0.028 ± 0.055** | −0.048 ± 0.055 | −37 | 57 | 60% |

The 10 variants on 2010 to 2021 (these chose the picks):

| Variant | 15m trades/day | 15m avg R (main) | 1h trades/day | 1h avg R (main) |
|---|---:|---:|---:|---:|
| current | 1.38 | −0.049 ± 0.031 | 0.55 | −0.019 ± 0.044 |
| + previous-day and Asian (00-05 UTC) liquidity | 1.59 | −0.059 ± 0.029 | 0.71 | −0.049 ± 0.038 |
| order block entry | 1.28 | −0.126 ± 0.036 | 0.44 | −0.067 ± 0.060 |
| breaker block entry | 1.46 | −0.106 ± 0.032 | 0.50 | −0.050 ± 0.053 |
| OTE entry (62-79%) | 1.45 | −0.098 ± 0.033 | 0.50 | −0.075 ± 0.054 |
| displacement 0.7 ATR | 1.63 | −0.046 ± 0.028 | 0.68 | −0.029 ± 0.040 |
| MSS by close (displacement anywhere in the leg) | 1.56 | −0.048 ± 0.029 | 0.66 | −0.015 ± 0.040 |
| later gap (fvgAfterBars 10) | 1.61 | **−0.036 ± 0.027** | 0.72 | −0.008 ± 0.035 |
| MSS by close + later gap | 1.85 | −0.041 ± 0.025 | 0.87 | **−0.005 ± 0.031** |
| all of the "more entries" options (liquidity, MSS by close, 0.7 ATR, later gap) | 2.53 | −0.047 ± 0.022 | 1.33 | −0.022 ± 0.025 |

For information only (not used to choose), 2022 to 2025 for every variant, average R after main costs: 15m from −0.061 (0.7 ATR) to −0.186 (order block). 1h from −0.005 (breaker, 768 trades) to −0.081 (liquidity pools). The breaker and order block rows look better on 1h in these years, the opposite of training. That flip is what noise looks like at these sample sizes. On 1h the new default made money on 6 of the 11 markets out of sample (current rules: 3 of 11).

### What the new options do (all in `ICT_DEFAULTS`, off)

- `liqPrevDay`, `liqAsia`, `asiaHours`: besides the latest swing low, the previous trading day's low (Friday on a Monday) and today's Asian-range low (00:00 to 05:00 UTC, swept only after the range closes) count as liquidity, if still untouched. The bot needs 4 days of candles for this (capped at 4000).
- `entryZone: "breaker"`: the last up-close candle before the down move that took the low. Displacement must close above it, and the entry is on the way back. The stop goes beyond the sweep low. `entryZone: "ote"`: entry when price comes 62% to 79% back from the highest high since the sweep toward the swept low. `entryZone: "ob"` (order block, 16 October) is unchanged.
- `mssClose`: the first close above the internal swing high is the structure shift, whatever the size of that candle. The displacement (`dispATR`) may come from any candle of the leg from the sweep to that close.
- `fvgAfterBars`: gaps that form up to N bars after the shift count too. The newest gap is the entry, but only while no gap of the setup has been revisited. So a second gap is used only when price never came back to the first, and a setup is never traded twice. A plan for a later gap gets its own id, so the "Waiting for price" plan moves to it.

Unit tests: `test/ict-audit.test.mjs`. With all options off the backtest trades are identical, trade for trade, to the code before the audit (checked on all 22 market and timeframe files).

### Method notes

- Data: HistData M1, 2010 to 2025, resampled to 15m and 1h exactly as `tools/backtest.mjs` does. The driver runs the bot's own `evaluateICT` with `ictParamsFor(tf, {real: true})` and the trade loop copied from `tools/backtest.mjs`: entry at the signal bar's close, stop first if both are hit in one bar, a time exit, one trade at a time per market.
- Ten variants in all, chosen per timeframe by the best average R after main costs on 2010 to 2021, all 11 markets pooled. Each was tested once on 2022 to 2025. The rule for changing a default was decided before the test: only if the pick is not worse out of sample, and more trades alone is not a reason.

## Update, 16 October 2026: a "smarter" ICT, and an SMC test

**Short version.** Four ICT upgrades and an SMC-style order block entry were tested on real EURUSD with the same honest method as below, plus four extra years (2018 to 2021) as a second out-of-sample check. Two small upgrades did no harm out of sample and are now on for real markets only: the **4-hour trend filter on 1-hour candles** and **kill zones on 15-minute candles**. Premium/discount, OTE, the daily trend, and 4-hour structure as the trend all tested worse, so they stay off. Nothing here shows a proven edge. Every interval still includes zero, and on H1 the bot now trades about once every 20 days. SMC order blocks lost money on M15. On H1 they looked better, but the uncertainty is too large to tell, so SMC is **not** added as a strategy (see below).

### What was tested

All on top of the ICT rules described in the next section. The higher timeframe is built from the same bars, using closed higher-timeframe candles only (no lookahead; unit-tested).

1. **Higher-timeframe bias.** Only buy when the higher timeframe trends up, only sell when it trends down. Three standard definitions were tested:
   - **4h EMA**: the last closed 4-hour candle is above its 50-EMA, and the EMA is higher than 3 candles ago.
   - **Daily EMA**: the same with daily candles and a 20-EMA.
   - **4h structure**: the last close beyond a 4-hour swing high or low (a fractal of 2) decides the trend.
2. **Premium/discount.** A buy only enters in the lower half (the "discount" half) of the dealing range, which runs from the swept low to the highest high since; sells are the mirror. The **OTE** variant only enters 62% to 79% of the way back.
3. **Kill zones**: London 07:00 to 10:00 and New York 12:00 to 15:00 UTC (the existing option).
4. **Timeframe settings**: 3R and 60 bars (T, the earlier H1 pick) against the defaults of 2R and 30 bars (D).
5. **SMC order block** (`entryZone: "ob"`). The setup is unchanged: a sweep, then displacement that breaks structure. The entry is different: the first return to the last opposite-colour candle before the displacement (the order block, its full high-to-low range), with the stop beyond the block. No fair value gap is needed. It was tested alone and with the filters above, which together are the standard SMC model.

That makes 23 candidates on each of M15 and H1, with all rows shown below.

**Method.** The same as before: EURUSD M1 bid prices from HistData, resampled to M15 and H1, with a 0.8 pip round-trip cost charged as cost / stop distance. One trade at a time. Every candidate starts on the same bar (the longest warm-up, about 5 weeks). The rule, fixed before any test numbers were seen: on 2022 to 2023, pick the candidate with the best average after costs and at least 30 trades, then run it once on 2024 to 2025. All candidates were then also run on 2024 to 2025 and on 2018 to 2021 as an ablation, so that each upgrade can be judged against its base. **Caveat:** the defaults chosen below were set after seeing those out-of-sample rows, so no clean holdout period is left. Treat the results as "not worse", not as validation.

### Picks made on 2022 to 2023 only, then tested once

| Strategy | Bars | Picked on train | Train (after 0.8 pip) | Test 2024-25 (after 0.8 pip) | Extra 2018-21 (after 0.8 pip) |
|---|---|---|---|---|---|
| ICT | H1 | 3R, 60 bars | +0.05 ± 0.37 (70) | +0.08 ± 0.34 (74) | −0.08 ± 0.24 (125) |
| ICT | M15 | defaults + 4h EMA trend | +0.26 ± 0.25 (105) | −0.05 ± 0.21 (117) | −0.09 ± 0.14 (279) |
| SMC | H1 | order block, 3R, 60 bars | +0.26 ± 0.46 (63) | +0.27 ± 0.48 (58) | −0.11 ± 0.26 (149) |
| SMC | M15 | order block, 3R, 60, 4h trend, discount | +0.09 ± 0.52 (49) | −0.13 ± 0.48 (48) | −0.22 ± 0.30 (114) |

Average R per trade, ± 95% interval, with the number of trades in brackets. As before, the picks made on the training years fall back toward zero or below on the years they were not picked on.

### ICT before and after (what the bot now does on real markets)

| Variant | Period | Trades | Per day | Win rate | Avg R before costs | After 0.8 pip | Total R after 0.8 pip |
|---|---|---|---|---|---|---|---|
| ICT H1 before (defaults) | train 2022-23 | 74 | 0.102 | 43% | +0.02 | −0.00 ± 0.27 | −0.2 |
| ICT H1 before (defaults) | test 2024-25 | 79 | 0.108 | 47% | +0.19 | +0.17 ± 0.26 | +13.2 |
| ICT H1 before (defaults) | extra 2018-21 | 134 | 0.092 | 43% | −0.06 | −0.09 ± 0.18 | −11.4 |
| ICT H1 pick on train (3R, 60 bars) | train 2022-23 | 70 | 0.096 | 33% | +0.07 | +0.05 ± 0.37 | +3.4 |
| ICT H1 pick on train (3R, 60 bars) | test 2024-25 | 74 | 0.101 | 36% | +0.10 | +0.08 ± 0.34 | +5.7 |
| ICT H1 pick on train (3R, 60 bars) | extra 2018-21 | 125 | 0.086 | 34% | −0.06 | −0.08 ± 0.24 | −10.5 |
| ICT H1 new (4h trend) | train 2022-23 | 34 | 0.047 | 47% | +0.04 | +0.02 ± 0.38 | +0.5 |
| ICT H1 new (4h trend) | test 2024-25 | 46 | 0.063 | 43% | +0.23 | +0.20 ± 0.35 | +9.4 |
| ICT H1 new (4h trend) | extra 2018-21 | 72 | 0.049 | 46% | +0.09 | +0.06 ± 0.25 | +4.4 |
| ICT M15 before (defaults) | train 2022-23 | 232 | 0.320 | 47% | +0.20 | +0.15 ± 0.17 | +35.4 |
| ICT M15 before (defaults) | test 2024-25 | 254 | 0.348 | 37% | −0.06 | −0.12 ± 0.14 | −31.2 |
| ICT M15 before (defaults) | extra 2018-21 | 545 | 0.373 | 42% | +0.02 | −0.04 ± 0.10 | −21.0 |
| ICT M15 pick on train (4h trend) | train 2022-23 | 105 | 0.145 | 51% | +0.31 | +0.26 ± 0.25 | +27.2 |
| ICT M15 pick on train (4h trend) | test 2024-25 | 117 | 0.160 | 41% | +0.02 | −0.05 ± 0.21 | −5.7 |
| ICT M15 pick on train (4h trend) | extra 2018-21 | 279 | 0.191 | 41% | −0.02 | −0.09 ± 0.14 | −25.0 |
| ICT M15 new (kill zones) | train 2022-23 | 100 | 0.138 | 45% | +0.17 | +0.13 ± 0.26 | +12.6 |
| ICT M15 new (kill zones) | test 2024-25 | 103 | 0.141 | 40% | −0.03 | −0.09 ± 0.24 | −8.8 |
| ICT M15 new (kill zones) | extra 2018-21 | 223 | 0.153 | 42% | +0.07 | +0.01 ± 0.17 | +2.8 |

"Before" is the old default (2R, 30 bars, no filters). "New" is what `ictParamsFor` now gives a real market: on H1, the defaults plus the 4h EMA trend; on M15, the defaults plus kill zones. Win rate is before costs. Per day counts calendar days.

What it means:

- **H1, 4h trend (on).** It was better than without the filter in both out-of-sample periods: +0.20 against +0.17 on 2024-25, and +0.06 against −0.09 on 2018-21. Over all eight years it averaged +0.09 ± 0.18R on 152 trades, against +0.01 ± 0.13R on 287 trades without the filter. The difference is far smaller than the noise. The filter is kept because it is a faithful ICT idea, it did no harm out of sample, and it halves the number of trades, and with them the costs. With it the bot takes about 19 trades a year on H1.
- **M15, kill zones (on).** Out of sample it did better than the defaults in both periods: −0.09 against −0.12, and +0.01 against −0.04. With 3R and 60 bars it also did better: +0.05 against −0.06, and +0.06 against −0.04. Over eight years: +0.02 ± 0.12R (426 trades) against −0.02 ± 0.07R (1,031 trades). This is still roughly zero, with fewer trades.
- **H1, kill zones (off).** On H1 they were worse in training and on 2024-25. With 3R and 60 bars they were also worse on 2018-21.
- **M15, 4h trend (off).** It was the training pick, but it lost money in both out-of-sample periods (−0.05 and −0.09). It did better than no filter on 2024-25 and worse on 2018-21.
- **Daily EMA and 4h structure as the trend (off).** The daily EMA did worse than no filter on both timeframes. The 4h structure did worse than no filter on H1 and was mixed on M15.
- **Premium/discount and OTE (off).** On H1 they leave only 7 to 29 trades per period, so they cannot be judged, and they were negative on 2018-21. On M15 discount lost −0.41 and −0.31 on 2024-25. OTE almost never triggers, because the gap usually sits in the upper part of the leg.
- **3R and 60 bars on H1 (off).** No better than 2R and 30 bars out of sample (+0.08 against +0.17 on 2024-25, and the same −0.08 on 2018-21). The defaults stay.
- **Synthetic indices.** None of these filters is used on Deriv's synthetic indices. Those are a random number generator around the clock, with no sessions and no higher-timeframe trend that means anything. There, ICT behaves exactly as before.

### SMC (order block entries)

| Variant | Period | Trades | Per day | Win rate | Avg R before costs | After 0.8 pip | Total R after 0.8 pip |
|---|---|---|---|---|---|---|---|
| SMC H1 pick on train (3R, 60 bars) | train 2022-23 | 63 | 0.087 | 35% | +0.31 | +0.26 ± 0.46 | +16.3 |
| SMC H1 pick on train (3R, 60 bars) | test 2024-25 | 58 | 0.079 | 34% | +0.32 | +0.27 ± 0.48 | +15.3 |
| SMC H1 pick on train (3R, 60 bars) | extra 2018-21 | 149 | 0.102 | 26% | −0.06 | −0.11 ± 0.26 | −17.0 |
| SMC H1 + 4h trend (3R, 60) | train 2022-23 | 27 | 0.037 | 41% | +0.63 | +0.58 ± 0.76 | +15.6 |
| SMC H1 + 4h trend (3R, 60) | test 2024-25 | 37 | 0.051 | 32% | +0.32 | +0.27 ± 0.61 | +9.9 |
| SMC H1 + 4h trend (3R, 60) | extra 2018-21 | 66 | 0.045 | 32% | +0.18 | +0.12 ± 0.43 | +7.6 |
| SMC H1 + 4h trend (2R, 30) | train 2022-23 | 27 | 0.037 | 48% | +0.41 | +0.36 ± 0.57 | +9.8 |
| SMC H1 + 4h trend (2R, 30) | test 2024-25 | 37 | 0.051 | 32% | −0.03 | −0.09 ± 0.45 | −3.1 |
| SMC H1 + 4h trend (2R, 30) | extra 2018-21 | 68 | 0.047 | 49% | +0.44 | +0.38 ± 0.35 | +25.6 |
| SMC M15 pick on train (3R, 60, 4h trend, discount) | train 2022-23 | 49 | 0.067 | 31% | +0.22 | +0.09 ± 0.52 | +4.4 |
| SMC M15 pick on train (3R, 60, 4h trend, discount) | test 2024-25 | 48 | 0.066 | 29% | +0.03 | −0.13 ± 0.48 | −6.3 |
| SMC M15 pick on train (3R, 60, 4h trend, discount) | extra 2018-21 | 114 | 0.078 | 26% | −0.06 | −0.22 ± 0.30 | −25.0 |
| SMC M15 plain (2R, 30) | train 2022-23 | 209 | 0.288 | 36% | +0.02 | −0.08 ± 0.19 | −17.3 |
| SMC M15 plain (2R, 30) | test 2024-25 | 199 | 0.273 | 32% | −0.12 | −0.26 ± 0.18 | −52.5 |
| SMC M15 plain (2R, 30) | extra 2018-21 | 476 | 0.326 | 40% | +0.14 | −0.00 ± 0.13 | −0.5 |

**Verdict: it does not hold up well enough to add as a strategy.**

- On M15, every SMC row lost after costs over the eight years (−0.08 to −0.16R per trade), worse than ICT's fair value gap entry. The order block is a deeper entry with a wider stop, so it fills more often on moves that then fail.
- On H1, SMC with the 4h trend was the best-looking row in the whole study: positive in all three periods, at +0.26 ± 0.32R per trade over eight years on 130 trades. But it was not the pre-registered pick (it had only 27 training trades, below the 30-trade minimum), every interval includes zero, and it is the best of 46 rows. That is exactly what picking a winner from noise looks like. The same model with 2R and 30 bars lost on 2024-25.
- Recommendation: do not add SMC as a fourth strategy now. If the user still wants it, add it as **signals only (no auto trade), on H1 only, with the 4h trend filter**, and judge it on a few months of forward signals before trusting it. The order block entry is already in the code as an ICT option (`entryZone: "ob"`, off by default; it reads "entering the bullish order block ..." and drives the "Waiting for price" zone), so wiring it up later is a small change.

### All candidates


**H1** (avg R per trade after the 0.8 pip cost, ± 95%; trades in brackets)

| # | Candidate | Train 2022-23 | Test 2024-25 | Extra 2018-21 |
|---|---|---|---|---|
| 0 | D defaults 2R/30 | −0.00 ± 0.27 (74) | +0.17 ± 0.26 (79) | −0.09 ± 0.18 (134) |
| 1 | T 3R/60 | +0.05 ± 0.37 (70) | +0.08 ± 0.34 (74) | −0.08 ± 0.24 (125) |
| 2 | T + H4 EMA bias | −0.02 ± 0.49 (34) | +0.09 ± 0.45 (44) | +0.05 ± 0.34 (68) |
| 3 | T + D1 EMA bias | +0.10 ± 0.57 (27) | −0.13 ± 0.46 (38) | −0.14 ± 0.33 (62) |
| 4 | T + H4 structure bias | −0.05 ± 0.49 (37) | +0.01 ± 0.44 (44) | −0.13 ± 0.29 (81) |
| 5 | T + discount | +0.07 ± 0.70 (21) | +0.66 ± 1.58 (7) | −0.41 ± 0.52 (29) |
| 6 | T + OTE | −0.03 ± 1.28 (8) | +1.60 ± 2.60 (3) | −1.07 ± 0.02 (4) |
| 7 | T + kill zone | −0.22 ± 0.55 (30) | +0.07 ± 0.70 (21) | −0.25 ± 0.46 (37) |
| 8 | D + H4 EMA bias | +0.02 ± 0.38 (34) | +0.20 ± 0.35 (46) | +0.06 ± 0.25 (72) |
| 9 | D + discount | −0.22 ± 0.49 (22) | +0.23 ± 1.19 (7) | −0.23 ± 0.44 (29) |
| 10 | D + kill zone | −0.16 ± 0.45 (30) | −0.00 ± 0.54 (21) | +0.00 ± 0.39 (38) |
| 11 | T + H4 EMA + discount | −0.18 ± 0.90 (10) | +0.29 ± 2.64 (3) | −0.16 ± 0.80 (16) |
| 12 | T + H4 EMA + kill zone | +0.40 ± 1.04 (14) | −0.04 ± 1.02 (10) | −0.18 ± 0.63 (21) |
| 13 | T + H4 EMA + discount + KZ | −0.36 ± 1.30 (6) | −1.05 ± – (1) | −0.02 ± 1.35 (6) |
| 14 | T + H4 structure + discount | +0.24 ± 1.27 (8) | +0.96 ± 2.28 (4) | −0.44 ± 0.64 (20) |
| 15 | T + D1 EMA + discount | −0.32 ± 0.95 (9) | −0.04 ± 1.98 (4) | −0.37 ± 0.74 (15) |
| 16 | SMC OB 2R/30 | +0.06 ± 0.35 (64) | −0.08 ± 0.35 (58) | +0.03 ± 0.22 (153) |
| 17 | SMC OB 3R/60 | +0.26 ± 0.46 (63) | +0.27 ± 0.48 (58) | −0.11 ± 0.26 (149) |
| 18 | SMC OB T + H4 EMA | +0.58 ± 0.76 (27) | +0.27 ± 0.61 (37) | +0.12 ± 0.43 (66) |
| 19 | SMC OB T + discount | +0.11 ± 0.59 (38) | +0.37 ± 0.72 (28) | −0.07 ± 0.41 (67) |
| 20 | SMC OB T + H4 EMA + discount | +0.35 ± 0.94 (17) | +0.50 ± 0.93 (18) | +0.09 ± 0.65 (30) |
| 21 | SMC OB D + H4 EMA | +0.36 ± 0.57 (27) | −0.09 ± 0.45 (37) | +0.38 ± 0.35 (68) |
| 22 | SMC OB D + H4 EMA + discount | −0.05 ± 0.68 (17) | +0.11 ± 0.70 (18) | +0.41 ± 0.54 (30) |

**M15** (avg R per trade after the 0.8 pip cost, ± 95%; trades in brackets)

| # | Candidate | Train 2022-23 | Test 2024-25 | Extra 2018-21 |
|---|---|---|---|---|
| 0 | D defaults 2R/30 | +0.15 ± 0.17 (232) | −0.12 ± 0.14 (254) | −0.04 ± 0.10 (545) |
| 1 | T 3R/60 | +0.14 ± 0.21 (219) | −0.06 ± 0.18 (245) | −0.04 ± 0.12 (514) |
| 2 | T + H4 EMA bias | +0.23 ± 0.32 (103) | +0.07 ± 0.28 (115) | −0.12 ± 0.17 (268) |
| 3 | T + D1 EMA bias | +0.22 ± 0.36 (87) | −0.20 ± 0.26 (112) | −0.09 ± 0.18 (241) |
| 4 | T + H4 structure bias | +0.17 ± 0.30 (112) | +0.01 ± 0.25 (138) | −0.06 ± 0.17 (271) |
| 5 | T + discount | +0.42 ± 0.57 (39) | −0.41 ± 0.35 (55) | +0.01 ± 0.37 (77) |
| 6 | T + OTE | +0.06 ± 0.87 (13) | −1.12 ± 0.03 (9) | +0.33 ± 0.81 (20) |
| 7 | T + kill zone | +0.15 ± 0.32 (100) | +0.05 ± 0.30 (102) | +0.06 ± 0.19 (222) |
| 8 | D + H4 EMA bias | +0.26 ± 0.25 (105) | −0.05 ± 0.21 (117) | −0.09 ± 0.14 (279) |
| 9 | D + discount | +0.26 ± 0.45 (39) | −0.31 ± 0.31 (55) | +0.00 ± 0.30 (78) |
| 10 | D + kill zone | +0.13 ± 0.26 (100) | −0.09 ± 0.24 (103) | +0.01 ± 0.17 (223) |
| 11 | T + H4 EMA + discount | +0.16 ± 0.85 (17) | −0.11 ± 0.63 (26) | −0.01 ± 0.50 (45) |
| 12 | T + H4 EMA + kill zone | −0.01 ± 0.45 (47) | +0.29 ± 0.46 (48) | −0.06 ± 0.27 (112) |
| 13 | T + H4 EMA + discount + KZ | −1.07 ± 0.04 (8) | +0.31 ± 0.93 (16) | +0.18 ± 0.82 (20) |
| 14 | T + H4 structure + discount | +0.24 ± 0.82 (19) | −0.06 ± 0.54 (32) | +0.16 ± 0.56 (40) |
| 15 | T + D1 EMA + discount | +0.45 ± 1.09 (13) | −0.50 ± 0.45 (30) | +0.04 ± 0.58 (37) |
| 16 | SMC OB 2R/30 | −0.08 ± 0.19 (209) | −0.26 ± 0.18 (199) | −0.00 ± 0.13 (476) |
| 17 | SMC OB 3R/60 | +0.01 ± 0.24 (207) | −0.30 ± 0.22 (194) | −0.05 ± 0.15 (459) |
| 18 | SMC OB T + H4 EMA | +0.01 ± 0.34 (108) | −0.30 ± 0.33 (84) | −0.07 ± 0.21 (245) |
| 19 | SMC OB T + discount | +0.06 ± 0.37 (94) | −0.35 ± 0.30 (106) | −0.06 ± 0.23 (217) |
| 20 | SMC OB T + H4 EMA + discount | +0.09 ± 0.52 (49) | −0.13 ± 0.48 (48) | −0.22 ± 0.30 (114) |
| 21 | SMC OB D + H4 EMA | −0.11 ± 0.27 (108) | −0.34 ± 0.27 (85) | −0.01 ± 0.17 (253) |
| 22 | SMC OB D + H4 EMA + discount | −0.22 ± 0.39 (49) | −0.26 ± 0.38 (48) | −0.08 ± 0.25 (115) |

D = defaults (2R target, 30-bar time exit). T = 3R, 60 bars. Rows with fewer than about 30 trades are noise whatever their sign.

### Reproduce

```
node tools/backtest.mjs --train DAT_ASCII_EURUSD_M1_2022.csv,DAT_ASCII_EURUSD_M1_2023.csv \
  --test DAT_ASCII_EURUSD_M1_2024.csv,DAT_ASCII_EURUSD_M1_2025.csv --tf 60 --strategy ict --grid upgrades
```

Use `--tf 15` for M15. For the 2018 to 2021 check, pass those four files as `--test`. The pick is made on `--train`, so it is the same. Training rows print the win rate after costs.

---

## Original report (6 October 2026)

## The ICT rules (as coded in `evaluateICT`)

The strategy looks only at closed bars. For a buy (sells are the exact mirror):

1. **Liquidity.** Find the most recent swing low (a bar whose low is lower than the 2 bars on each side) within the last 60 bars, which price has not traded below since.
2. **Sweep.** A bar wicks below that swing low and closes back above it.
3. **Structure shift with displacement.** Within 10 bars of the sweep, a bar with a body of at least 1 x ATR(14) closes above the most recent swing high that formed after the swept low. It must be the first close above that high.
4. **Fair value gap.** The up move leaves a 3-bar gap: the low of the third bar is above the high of the first.
5. **Entry.** The first time a later bar trades back into the gap (and does not close below it), within 15 bars of the structure shift, the bot buys at that bar's close.
6. **Exits.** Stop below the lowest point of the sweep plus 0.1 x ATR. Target 2R by default (or the nearest swing high, "liquidity" target). Time exit after 30 bars.
7. **Kill zones** (London 07:00 to 10:00 UTC, New York 12:00 to 15:00 UTC) are optional and off by default. Deriv's synthetic indices are generated by a random number generator around the clock, so they have no sessions and nothing special happens at these hours. (Since 16 October 2026 they are on for real markets on 15-minute candles, and real markets on 1-hour candles also follow the 4-hour trend: see the update above.)

The reason shown for a trade reads like: "Swept the low at 1.03623, broke structure up above 1.03639, entering the fair value gap (1.03628 to 1.03637); target 2R".

## Test 1: simulated Volatility 75 (60 days, 3 seeds, M1)

Deriv describes Volatility 75 as a random walk with 75% annual volatility, which is what the simulator produces (a tick every 2 seconds). On a random walk no rule can have an edge, so this test checks the code and shows how big pure noise looks. Commission is given as a share of R, as the bot shows it.

| ICT defaults | Trades | Per day | Win rate | Avg R before costs | After 2% | After 5% |
|---|---|---|---|---|---|---|
| Seed 1 | 449 | 7.5 | 41.9% | +0.024 ± 0.111 | +0.004 | -0.026 |
| Seed 2 | 452 | 7.5 | 37.8% | -0.076 ± 0.105 | -0.096 | -0.126 |
| Seed 3 | 469 | 7.8 | 44.8% | +0.097 ± 0.110 | +0.077 | +0.047 |
| **All 3 seeds** | **1,370** | **7.6** | **41.5%** | **+0.016 ± 0.063** | **-0.004** | **-0.034** |

Seed 3 alone would look like a working strategy and seed 2 like a broken one. Both are luck. For comparison, on the same three seeds Rules made 13.4 trades a day at -0.012 ± 0.056R and AI (threshold 0.55) 3.8 a day at +0.025 ± 0.075R, also zero within noise.

### Parameter sweep on the same V75 data (all 19 settings, all shown)

| Target | Time exit | Kill zone | Trades | Per day | Win rate | Avg R | ± 95% | After 2% | After 5% |
|---|---|---|---|---|---|---|---|---|---|
| 1.5R | 15 | off | 1,433 | 8.0 | 47.4% | +0.013 | 0.049 | -0.007 | -0.037 |
| 1.5R | 30 | off | 1,383 | 7.7 | 43.7% | +0.003 | 0.057 | -0.017 | -0.047 |
| 1.5R | 60 | off | 1,348 | 7.5 | 41.6% | +0.003 | 0.063 | -0.017 | -0.047 |
| 2R | 15 | off | 1,429 | 7.9 | 46.2% | +0.017 | 0.052 | -0.003 | -0.033 |
| 2R | 30 | off | 1,370 | 7.6 | 41.5% | +0.016 | 0.063 | -0.004 | -0.034 |
| 2R | 60 | off | 1,320 | 7.3 | 37.8% | +0.027 | 0.072 | +0.007 | -0.023 |
| 3R | 15 | off | 1,425 | 7.9 | 46.0% | +0.022 | 0.055 | +0.002 | -0.028 |
| 3R | 30 | off | 1,360 | 7.6 | 40.5% | +0.021 | 0.068 | +0.001 | -0.029 |
| 3R | 60 | off | 1,289 | 7.2 | 34.3% | +0.041 | 0.083 | +0.021 | -0.009 |
| 1.5R | 15 | on | 348 | 1.9 | 46.8% | +0.031 | 0.096 | +0.011 | -0.019 |
| 1.5R | 30 | on | 337 | 1.9 | 40.9% | -0.038 | 0.115 | -0.058 | -0.088 |
| 1.5R | 60 | on | 333 | 1.9 | 41.1% | -0.007 | 0.127 | -0.027 | -0.057 |
| 2R | 15 | on | 347 | 1.9 | 46.1% | +0.036 | 0.101 | +0.016 | -0.014 |
| 2R | 30 | on | 333 | 1.9 | 38.4% | -0.050 | 0.124 | -0.070 | -0.100 |
| 2R | 60 | on | 328 | 1.8 | 36.6% | -0.009 | 0.143 | -0.029 | -0.059 |
| 3R | 15 | on | 347 | 1.9 | 45.8% | +0.054 | 0.109 | +0.034 | +0.004 |
| 3R | 30 | on | 333 | 1.9 | 37.8% | -0.006 | 0.138 | -0.026 | -0.056 |
| 3R | 60 | on | 324 | 1.8 | 35.2% | +0.095 | 0.173 | +0.075 | +0.045 |
| Liquidity | 30 | off | 1,466 | 8.1 | 76.4% | -0.013 | 0.031 | -0.033 | -0.063 |

Every interval includes zero. The best-looking row (3R, 60 bars, kill zone on, +0.095R) uses a session filter on a market that has no sessions, so it cannot be real. This is exactly what picking the best of 19 tries looks like on noise. Do not choose settings from this table.

The liquidity target wins 76% of the time because the nearest swing high is usually close, but the losses are bigger than the wins, so the average is the same zero. A high win rate on its own says nothing about profit.

## Test 2: real EURUSD, walk-forward (M1, M15, H1)

**Data.** HistData EURUSD M1 bid prices, 2022 to 2025 (about 1.44 million bars), already cached on this machine from the earlier AI work. Times are converted from EST to UTC so the kill zones line up. M15 and H1 bars are built from the M1 bars.

**Method.** For each strategy and timeframe, every candidate setting was run on 2022 to 2023; the one with the best average after the 0.8 pip cost (and at least 30 trades) was then run once on 2024 to 2025. Only the 2024 to 2025 numbers are shown below. Candidates: ICT, the 19 settings above; Rules, trend and range / trend only / range only (higher timeframe M15 for M1, H1 for M15, H4 for H1, as in TbotAdaptive); AI, thresholds 0.5 / 0.55 / 0.6.

**Costs.** Deriv charges Multipliers on forex a commission that grows with stake x multiplier, which works like a spread. It is charged here as a round-trip spread of 0.8 pip and of 1.5 pip, converted to R for each trade from its own stop distance (cost in R = spread / stop distance). Tight M1 stops make the same pip cost a much bigger share of R.

Trades per day count calendar days, including weekends with no trading. Win rate is before costs.

| Strategy | Bars | Setting picked on 2022-23 | Trades | Per day | Win rate | Avg R before costs | After 0.8 pip | After 1.5 pip | Total R after 0.8 pip |
|---|---|---|---|---|---|---|---|---|---|
| ICT | M1 | 2R, 60 bars, kill zone on | 733 | 1.00 | 37.5% | +0.029 ± 0.096 | -0.154 ± 0.095 | -0.313 ± 0.096 | -112.6 |
| ICT | M15 | 3R, 30 bars, kill zone off | 268 | 0.37 | 33.6% | -0.066 ± 0.157 | -0.130 ± 0.157 | -0.186 ± 0.158 | -34.9 |
| ICT | H1 | 3R, 60 bars, kill zone off | 75 | 0.10 | 36.0% | +0.090 ± 0.340 | +0.063 ± 0.339 | +0.040 ± 0.338 | +4.7 |
| Rules | M1 | trend only | 6,762 | 9.26 | 31.9% | -0.042 ± 0.033 | -0.540 ± 0.035 | -0.975 ± 0.038 | -3,649.0 |
| Rules | M15 | trend only | 632 | 0.87 | 32.1% | -0.036 ± 0.109 | -0.131 ± 0.109 | -0.214 ± 0.109 | -82.7 |
| Rules | H1 | trend only | 200 | 0.27 | 35.0% | +0.054 ± 0.199 | +0.005 ± 0.199 | -0.037 ± 0.199 | +1.1 |
| AI | M1 | threshold 0.5 (test 2024 only, see note) | 9,309 | 25.50 | 52.3% | +0.048 ± 0.020 | -0.365 ± 0.021 | -0.726 ± 0.024 | -3,398.6 |
| AI | M15 | threshold 0.5 | 764 | 1.05 | 50.1% | -0.006 ± 0.068 | -0.068 ± 0.068 | -0.121 ± 0.068 | -51.6 |
| AI | H1 | threshold 0.55 | 82 | 0.11 | 45.1% | -0.119 ± 0.213 | -0.146 ± 0.213 | -0.170 ± 0.214 | -12.0 |

Notes on the table:

- **AI on M1.** The shipped model was trained on EURUSD 2025, so 2025 is not out of sample for it. The row above uses 2024 only. On 2024 to 2025 together it showed +0.065 ± 0.015R before costs, inflated by the training year. The 2024 figure (+0.048R) is the only result in this report that is clearly above zero before costs, and it matches the earlier finding in `mt5/ai/RESULTS.md` (+0.036 to +0.045R). But the 0.8 pip cost is about 0.4R per trade on its tight M1 stops, eight times the edge.
- **AI on M15 and H1** feeds the M1-trained model bars it has never seen the like of. Treat those rows as a curiosity, not a test of the model.
- **ICT on H1** is the only row above zero after costs, and it is far inside its own noise (+0.063 ± 0.339R). In training its 19 settings ranged from -0.125R to +0.127R (the one picked). Expect it to fall back toward zero, and after costs below.
- **Rules on H1** is roughly break-even after 0.8 pip and negative after 1.5 pip, again within noise.

### How much choosing settings flatters the training period

ICT on M15 shows the problem clearly. On 2022 to 2023 all 18 R-target settings were positive after the 0.8 pip cost (+0.05R to +0.14R), and the best was +0.135R. The same setting on 2024 to 2025 lost -0.130R. On M1 the reverse is true: every one of the 19 settings lost after costs in training, so choosing "the best" only chose the smallest loss.

## Conclusions

1. **On Deriv's synthetic indices (V75):** the ICT strategy cannot have an edge, because the price is a random number generator. It trades about 7.6 times a day on M1 (1.9 a day with the kill-zone filter) with an average of zero before costs, so it loses roughly the commission on every trade. The same is true of the Rules and AI strategies.
2. **On real EURUSD:** before costs, ICT is within noise of zero on every timeframe. After a realistic cost it loses on M1 (about -0.15R per trade) and M15 (about -0.13R per trade). H1 is not conclusive with about one trade every ten days.
3. **The cost, not the signal, decides M1.** One-minute stops are small, so a fixed cost per trade is a large share of R. Any M1 strategy needs an edge of several tenths of R per trade just to break even on forex, and none here comes close.
4. **The sweep is not a menu.** Picking the best row from any table above is curve fitting. The walk-forward rows are the honest numbers, and they say "no edge after costs".

The ICT strategy is safe to keep for watching signals (it explains each one in plain words), but there is no evidence it should trade real money on any of these markets.

## Live ICT bot: entries on a touch (not in these numbers)

The ICT tables above enter at the close of the candle that comes back into the gap. The live ICT bot also keeps a "Waiting for price" plan once a setup has formed, and enters on the first tick inside the zone, with the same stop loss and take profit prices as the plan.

The two also give a setup different amounts of time:

- Backtest: the entry candle must close back in the gap within 15 candles of the structure shift.
- Live plan: it stays up for 30 candles counted from the candle that formed the gap, so price has up to twice as long to come back.

Neither the touch entry nor the longer life is backtested here, so the results above do not prove anything about them either way. Rules has no such plan: live and in the backtest it enters only at the close of a candle that passes all its checks.

## Reproduce

```
node tools/backtest.mjs --strategy ict --seeds 1,2,3            # V75, defaults
node tools/backtest.mjs --strategy ict --seeds 1,2,3 --sweep    # V75, all 19 settings
node tools/backtest.mjs --train DAT_ASCII_EURUSD_M1_2022.csv,DAT_ASCII_EURUSD_M1_2023.csv \
  --test DAT_ASCII_EURUSD_M1_2024.csv,DAT_ASCII_EURUSD_M1_2025.csv --tf 60 --strategy ict --spreads 0.00008,0.00015
```

`--tf` takes 1, 15 or 60. HistData files (semicolon format, EST) are recognised automatically; the bot's own CSV export also works.
