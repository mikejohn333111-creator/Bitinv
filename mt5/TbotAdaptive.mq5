//+------------------------------------------------------------------+
//|                                                 TbotAdaptive.mq5 |
//|  Adaptive trend / range Expert Advisor for Deriv MT5             |
//|  (synthetic indices such as Volatility 75, and forex pairs)      |
//|                                                                  |
//|  How it decides:                                                 |
//|   1. Regime filter  : ADX classifies the market as TREND, RANGE  |
//|                       or UNCLEAR (no trading when unclear).      |
//|   2. Higher TF bias : trend trades only in the direction of the  |
//|                       higher-timeframe EMA and its slope.        |
//|   3. Entry          : TREND  -> pullback to the fast EMA, then a |
//|                                confirming candle + RSI momentum. |
//|                       RANGE  -> Bollinger re-entry after an      |
//|                                RSI extreme (mean reversion).     |
//|   4. Exits          : ATR stop loss / take profit, break-even,   |
//|                       ATR trailing stop.                         |
//|   5. Protection     : risk % per trade, daily loss limit, max    |
//|                       trades per day, max open trades, spread    |
//|                       and volatility-spike filters, cooldown     |
//|                       after a losing streak.                     |
//|                                                                  |
//|  No strategy wins every trade. Backtest, then run on a DEMO      |
//|  account before risking real money.                              |
//+------------------------------------------------------------------+
#property copyright "Tbot"
#property version   "1.00"
#property description "Adaptive trend/range EA with ATR risk management for Deriv MT5."

#include <Trade\Trade.mqh>

#define BOT_NAME "TbotAdaptive"

//--- run mode -------------------------------------------------------
enum ENUM_RUN_MODE
{
   MODE_SIGNALS = 0,   // Signals only (alerts, no trading)
   MODE_AUTO    = 1    // Auto trade (places orders itself)
};

//--- inputs ---------------------------------------------------------
input group "Mode"
input ENUM_RUN_MODE   InpMode             = MODE_SIGNALS;   // Mode: signals only or auto trade
input bool            InpAlertPopup       = true;           // Signals: pop-up alert + sound in the terminal
input bool            InpPushNotify       = true;           // Signals: push notification to the MT5 mobile app
input bool            InpDrawSignals      = true;           // Draw entry arrow, SL and TP on the chart
input int             InpSignalGapBars    = 8;              // Signals only: min bars between signals

input group "General"
input long            InpMagic            = 7501001;        // Magic number (unique per chart)
input ENUM_TIMEFRAMES InpTF               = PERIOD_M15;     // Entry timeframe
input ENUM_TIMEFRAMES InpHTF              = PERIOD_H1;      // Higher (confirmation) timeframe
input string          InpComment          = "Tbot";         // Order comment

input group "Regime filter (ADX)"
input int             InpADXPeriod        = 14;             // ADX period
input double          InpADXTrend         = 25.0;           // ADX >= this -> TREND regime
input double          InpADXRange         = 20.0;           // ADX <= this -> RANGE regime

input group "Trend logic"
input bool            InpUseTrend         = true;           // Enable trend trades
input int             InpFastEMA          = 21;             // Fast EMA (entry TF)
input int             InpSlowEMA          = 50;             // Slow EMA (entry TF)
input int             InpHTFEMA           = 50;             // Higher-TF EMA
input int             InpHTFSlopeBars     = 3;              // Higher-TF EMA slope lookback (bars)
input double          InpPullbackATR      = 0.3;            // Pullback must reach fast EMA +/- this x ATR
input int             InpRSIPeriod        = 14;             // RSI period
input double          InpRSITrendMin      = 50.0;           // Buy: RSI above this (sell: below 100-this)
input double          InpRSITrendMax      = 70.0;           // Buy: RSI below this (sell: above 100-this)
input double          InpTrendSL_ATR      = 1.5;            // Trend stop loss (x ATR)
input double          InpTrendTP_ATR      = 3.0;            // Trend take profit (x ATR)

input group "Range logic"
input bool            InpUseRange         = true;           // Enable range (mean-reversion) trades
input int             InpBBPeriod         = 20;             // Bollinger period
input double          InpBBDev            = 2.0;            // Bollinger deviation
input double          InpRSIOversold      = 30.0;           // RSI oversold (overbought = 100-this)
input double          InpRangeSL_ATR      = 1.2;            // Range stop loss (x ATR)
input double          InpRangeTP_ATR      = 1.5;            // Range take profit (x ATR)

input group "Trade management"
input int             InpATRPeriod        = 14;             // ATR period
input double          InpBreakEvenR       = 1.0;            // Move SL to break-even after this many R (0 = off)
input double          InpTrailStartATR    = 1.5;            // Start trailing after this x ATR in profit (0 = off)
input double          InpTrailATR         = 1.0;            // Trailing distance (x ATR)
input double          InpTrailStepATR     = 0.1;            // Minimum SL improvement per modify (x ATR)

input group "Risk management"
input double          InpRiskPercent      = 1.0;            // Risk per trade (% of balance)
input double          InpMaxDailyLossPct  = 3.0;            // Daily loss limit (% of day-start balance, 0 = off)
input double          InpDailyTargetPct   = 0.0;            // Stop for the day at this profit % (0 = off)
input int             InpMaxOpenTrades    = 1;              // Max open positions (this EA, this symbol)
input int             InpMaxTradesPerDay  = 6;              // Max new trades per day (0 = unlimited)
input int             InpMaxConsecLosses  = 3;              // Losing streak that triggers cooldown (0 = off)
input int             InpCooldownBars     = 8;              // Cooldown length (entry-TF bars)

input group "Filters"
input double          InpMaxSpreadATR     = 0.25;           // Max spread as a fraction of ATR (0 = off)
input double          InpMaxATRSpike      = 2.5;            // Skip if ATR > this x its 50-bar average (0 = off)
input bool            InpUseHours         = false;          // Restrict trading hours (server time)
input int             InpStartHour        = 7;              // Start hour
input int             InpEndHour          = 20;             // End hour (exclusive)
input bool            InpShowPanel        = true;           // Show info panel on chart

input group "Web dashboard (optional)"
input string          InpWebURL           = "";             // Dashboard address, e.g. https://tbot-yourname.vercel.app (empty = off)
input string          InpWebSecret        = "";             // Secret (same value as TBOT_SECRET on Vercel)
input int             InpHeartbeatMin     = 5;              // Send bot status every N minutes

//--- globals --------------------------------------------------------
CTrade   g_trade;
ENUM_TIMEFRAMES g_tf, g_htf;

int g_hFast = INVALID_HANDLE, g_hSlow = INVALID_HANDLE, g_hHTF = INVALID_HANDLE;
int g_hADX  = INVALID_HANDLE, g_hRSI  = INVALID_HANDLE, g_hATR = INVALID_HANDLE, g_hBB = INVALID_HANDLE;

datetime g_lastBar       = 0;
datetime g_day           = 0;
double   g_dayStartBal   = 0.0;
bool     g_haltedToday   = false;
string   g_haltReason    = "";
int      g_tradesToday   = 0;
int      g_lossStreak    = 0;
datetime g_cooldownUntil = 0;
string   g_lastRegime    = "-";
string   g_lastSignal    = "-";
datetime g_lastSignalTime = 0;

enum ENUM_REGIME { REGIME_UNCLEAR = 0, REGIME_TREND = 1, REGIME_RANGE = 2 };

//+------------------------------------------------------------------+
string GVName(const string key)
{
   return "Tbot_" + _Symbol + "_" + IntegerToString(InpMagic) + "_" + key;
}

//+------------------------------------------------------------------+
int OnInit()
{
   g_tf  = (InpTF  == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)_Period : InpTF;
   g_htf = (InpHTF == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)_Period : InpHTF;

   if(PeriodSeconds(g_htf) <= PeriodSeconds(g_tf))
   {
      Print("Higher timeframe must be larger than the entry timeframe.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(InpFastEMA >= InpSlowEMA || InpADXRange > InpADXTrend || InpRiskPercent <= 0 || InpRiskPercent > 10)
   {
      Print("Check inputs: FastEMA < SlowEMA, ADXRange <= ADXTrend, 0 < Risk% <= 10.");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_hFast = iMA(_Symbol, g_tf,  InpFastEMA, 0, MODE_EMA, PRICE_CLOSE);
   g_hSlow = iMA(_Symbol, g_tf,  InpSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   g_hHTF  = iMA(_Symbol, g_htf, InpHTFEMA,  0, MODE_EMA, PRICE_CLOSE);
   g_hADX  = iADX(_Symbol, g_tf, InpADXPeriod);
   g_hRSI  = iRSI(_Symbol, g_tf, InpRSIPeriod, PRICE_CLOSE);
   g_hATR  = iATR(_Symbol, g_tf, InpATRPeriod);
   g_hBB   = iBands(_Symbol, g_tf, InpBBPeriod, 0, InpBBDev, PRICE_CLOSE);

   if(g_hFast == INVALID_HANDLE || g_hSlow == INVALID_HANDLE || g_hHTF == INVALID_HANDLE ||
      g_hADX  == INVALID_HANDLE || g_hRSI  == INVALID_HANDLE || g_hATR == INVALID_HANDLE ||
      g_hBB   == INVALID_HANDLE)
   {
      Print("Failed to create indicator handles, error ", GetLastError());
      return INIT_FAILED;
   }

   g_trade.SetExpertMagicNumber((ulong)InpMagic);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_trade.SetDeviationInPoints(50);

   // Restore daily state so a restart mid-day keeps the loss limit honest.
   if(GlobalVariableCheck(GVName("day")))
   {
      g_day         = (datetime)GlobalVariableGet(GVName("day"));
      g_dayStartBal = GlobalVariableGet(GVName("bal"));
      g_tradesToday = (int)GlobalVariableGet(GVName("trades"));
      g_haltedToday = GlobalVariableGet(GVName("halt")) > 0.5;
      if(g_haltedToday) g_haltReason = "restored halt";
   }
   if(InpMode == MODE_AUTO && !MQLInfoInteger(MQL_TESTER) &&
      (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)))
      Print("Auto trade mode, but Algo Trading is OFF. Turn on the Algo Trading button and 'Allow Algo Trading' in the EA settings.");
   if(InpMode == MODE_SIGNALS && MQLInfoInteger(MQL_TESTER))
      Print("Signals-only mode places no trades, so a backtest will show nothing. Switch Mode to Auto trade for backtesting.");
   if(InpMode == MODE_SIGNALS && InpPushNotify && !MQLInfoInteger(MQL_TESTER) && !TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED))
      Print("Push notifications are off. Add your MetaQuotes ID in Tools > Options > Notifications to get signals on your phone.");
   if(WebOn()) EventSetTimer(30);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   IndicatorRelease(g_hFast); IndicatorRelease(g_hSlow); IndicatorRelease(g_hHTF);
   IndicatorRelease(g_hADX);  IndicatorRelease(g_hRSI);  IndicatorRelease(g_hATR);
   IndicatorRelease(g_hBB);
   Comment("");
}

//+------------------------------------------------------------------+
double Buf(const int handle, const int buffer, const int shift)
{
   double v[1];
   if(CopyBuffer(handle, buffer, shift, 1, v) != 1) return EMPTY_VALUE;
   return v[0];
}

//+------------------------------------------------------------------+
double RoundToTick(const double price)
{
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(ts <= 0) return NormalizeDouble(price, _Digits);
   return NormalizeDouble(MathRound(price / ts) * ts, _Digits);
}

//+------------------------------------------------------------------+
bool IsNewBar()
{
   datetime t = iTime(_Symbol, g_tf, 0);
   if(t == 0 || t == g_lastBar) return false;
   g_lastBar = t;
   return true;
}

//+------------------------------------------------------------------+
int CountPositions()
{
   int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         n++;
   }
   return n;
}

//+------------------------------------------------------------------+
void CloseAll(const string why)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         if(!g_trade.PositionClose(ticket))
            Print("Close failed for ", ticket, ": ", g_trade.ResultRetcodeDescription());
   }
   Print("Closed all positions: ", why);
}

//+------------------------------------------------------------------+
void SaveDayState()
{
   GlobalVariableSet(GVName("day"),    (double)g_day);
   GlobalVariableSet(GVName("bal"),    g_dayStartBal);
   GlobalVariableSet(GVName("trades"), g_tradesToday);
   GlobalVariableSet(GVName("halt"),   g_haltedToday ? 1.0 : 0.0);
}

//+------------------------------------------------------------------+
//| Daily loss limit / profit target. Returns true if trading is OK. |
//+------------------------------------------------------------------+
bool DailyGuard()
{
   datetime today = iTime(_Symbol, PERIOD_D1, 0);
   if(today == 0)
   {
      MqlDateTime dt; TimeCurrent(dt); dt.hour = 0; dt.min = 0; dt.sec = 0;
      today = StructToTime(dt);
   }
   if(today != g_day)
   {
      g_day         = today;
      g_dayStartBal = AccountInfoDouble(ACCOUNT_BALANCE);
      g_haltedToday = false;
      g_haltReason  = "";
      g_tradesToday = 0;
      SaveDayState();
   }
   if(g_haltedToday) return false;

   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   double chg  = (g_dayStartBal > 0) ? (eq - g_dayStartBal) / g_dayStartBal * 100.0 : 0.0;

   if(InpMaxDailyLossPct > 0 && chg <= -InpMaxDailyLossPct)
   {
      g_haltedToday = true;
      g_haltReason  = StringFormat("daily loss limit hit (%.2f%%)", chg);
   }
   else if(InpDailyTargetPct > 0 && chg >= InpDailyTargetPct)
   {
      g_haltedToday = true;
      g_haltReason  = StringFormat("daily target reached (%.2f%%)", chg);
   }
   if(g_haltedToday)
   {
      CloseAll(g_haltReason);
      SaveDayState();
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Position size so that hitting the SL loses ~InpRiskPercent.      |
//+------------------------------------------------------------------+
double CalcLots(const ENUM_ORDER_TYPE type, const double entry, const double sl)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step    = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double riskAmt = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;

   double pl = 0.0;
   if(!OrderCalcProfit(type, _Symbol, 1.0, entry, sl, pl) || pl >= 0)
   {
      // Fallback: tick value maths
      double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tv <= 0 || ts <= 0) return 0.0;
      pl = -MathAbs(entry - sl) / ts * tv;
   }
   double lossPerLot = MathAbs(pl);
   if(lossPerLot <= 0 || step <= 0) return 0.0;

   double lots = MathFloor((riskAmt / lossPerLot) / step + 1e-9) * step;

   if(lots < minLot)
   {
      // Minimum lot would risk too much (more than 1.5x the target) -> skip trade.
      if(minLot * lossPerLot > riskAmt * 1.5)
      {
         Print("Skip: min lot ", minLot, " would risk ", DoubleToString(minLot * lossPerLot, 2),
               " > allowed ", DoubleToString(riskAmt, 2));
         return 0.0;
      }
      lots = minLot;
   }
   lots = MathMin(lots, maxLot);

   // Make sure we have the margin for it.
   double margin = 0.0;
   double free   = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   while(lots >= minLot && OrderCalcMargin(type, _Symbol, lots, entry, margin) && margin > free * 0.9)
      lots -= step;
   if(lots < minLot) return 0.0;

   int digits = (int)MathMax(0, MathCeil(-MathLog10(step)));
   return NormalizeDouble(lots, digits);
}

//+------------------------------------------------------------------+
bool HoursOK()
{
   if(!InpUseHours) return true;
   MqlDateTime dt; TimeCurrent(dt);
   if(InpStartHour <= InpEndHour) return dt.hour >= InpStartHour && dt.hour < InpEndHour;
   return dt.hour >= InpStartHour || dt.hour < InpEndHour;   // overnight window
}

//+------------------------------------------------------------------+
double AverageATR(const int bars)
{
   double v[];
   int got = CopyBuffer(g_hATR, 0, 1, bars, v);
   if(got <= 0) return 0.0;
   double s = 0.0;
   for(int i = 0; i < got; i++) s += v[i];
   return s / got;
}

//+------------------------------------------------------------------+
//| Web dashboard (optional): posts events to <URL>/api/event.       |
//+------------------------------------------------------------------+
bool     g_webWarned = false;
datetime g_lastBeat  = 0;

bool WebOn() { return InpWebURL != "" && !MQLInfoInteger(MQL_TESTER) && !MQLInfoInteger(MQL_OPTIMIZATION); }

string JsonEsc(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", " ");
   StringReplace(r, "\r", " ");
   return r;
}

string JNum(const string key, const double v, const int digits) { return ",\"" + key + "\":" + DoubleToString(v, digits); }
string JStr(const string key, const string v)                     { return ",\"" + key + "\":\"" + JsonEsc(v) + "\""; }

string JsonHead(const string type)
{
   return "{\"type\":\"" + type + "\"" + JStr("bot", BOT_NAME) + JStr("symbol", _Symbol) +
          JStr("mode", InpMode == MODE_AUTO ? "auto" : "signals") + ",\"time\":" + IntegerToString((long)TimeGMT());
}

void PostEvent(const string json)
{
   if(!WebOn()) return;
   string url = InpWebURL;
   while(StringLen(url) > 0 && StringGetCharacter(url, StringLen(url) - 1) == '/')
      url = StringSubstr(url, 0, StringLen(url) - 1);
   url += "/api/event";

   char data[], result[];
   int n = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);            // drop the trailing zero
   string headers = "Content-Type: application/json\r\nX-Tbot-Secret: " + InpWebSecret + "\r\n";
   string resHeaders;

   ResetLastError();
   int code = WebRequest("POST", url, headers, 4000, data, result, resHeaders);
   if(code == -1)
   {
      if(!g_webWarned)
         PrintFormat("Dashboard post failed (error %d). In MT5 open Tools > Options > Expert Advisors, tick "
                     "'Allow WebRequest for listed URL' and add %s", GetLastError(), InpWebURL);
      g_webWarned = true;
   }
   else if(code != 200)
      Print("Dashboard replied ", code, ": ", CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8));
}

void PostTrade(const string type, const ENUM_ORDER_TYPE side, const double entry, const double sl, const double tp,
               const double lots, const double confidence, const string why)
{
   string j = JsonHead(type) + JStr("side", side == ORDER_TYPE_BUY ? "BUY" : "SELL") +
              JNum("entry", entry, _Digits) + JNum("sl", sl, _Digits) + JNum("tp", tp, _Digits);
   if(lots > 0)       j += JNum("lots", lots, 3);
   if(confidence > 0) j += JNum("confidence", confidence, 3);
   PostEvent(j + JStr("reason", why) + "}");
}

void PostClose(const ulong deal, const double net)
{
   long dtype = HistoryDealGetInteger(deal, DEAL_TYPE);   // a SELL deal closes a BUY position
   PostEvent(JsonHead("close") + JStr("side", dtype == DEAL_TYPE_SELL ? "BUY" : "SELL") +
             JNum("profit", net, 2) + JNum("price", HistoryDealGetDouble(deal, DEAL_PRICE), _Digits) + "}");
}

void PostStatus(const string state, const string regime, const double dayPct, const int openPos, const int tradesToday,
                const string note)
{
   string j = JsonHead("status") + JStr("state", state) +
              JNum("equity", AccountInfoDouble(ACCOUNT_EQUITY), 2) + JNum("balance", AccountInfoDouble(ACCOUNT_BALANCE), 2) +
              JNum("day_pl_pct", dayPct, 2) + JNum("open_positions", openPos, 0) + JNum("trades_today", tradesToday, 0) +
              JStr("currency", AccountInfoString(ACCOUNT_CURRENCY));
   if(regime != "") j += JStr("regime", regime);
   PostEvent(j + JStr("reason", note) + "}");
}

//+------------------------------------------------------------------+
//| Signals: alert, push notification and chart drawing.             |
//+------------------------------------------------------------------+
void DrawSignal(const ENUM_ORDER_TYPE type, const double entry, const double sl, const double tp, const int barsAhead)
{
   if(!InpDrawSignals) return;
   datetime t0 = iTime(_Symbol, g_tf, 0);
   datetime t1 = t0 + barsAhead * PeriodSeconds(g_tf);
   string id   = "TbotSig_" + IntegerToString((long)t0) + "_";
   bool  buy   = (type == ORDER_TYPE_BUY);

   ObjectCreate(0, id + "arrow", buy ? OBJ_ARROW_BUY : OBJ_ARROW_SELL, 0, t0, entry);
   ObjectSetInteger(0, id + "arrow", OBJPROP_COLOR, buy ? clrDodgerBlue : clrOrangeRed);
   ObjectSetInteger(0, id + "arrow", OBJPROP_WIDTH, 3);

   ObjectCreate(0, id + "sl", OBJ_TREND, 0, t0, sl, t1, sl);
   ObjectSetInteger(0, id + "sl", OBJPROP_COLOR, clrRed);
   ObjectSetInteger(0, id + "sl", OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, id + "sl", OBJPROP_RAY_RIGHT, false);

   ObjectCreate(0, id + "tp", OBJ_TREND, 0, t0, tp, t1, tp);
   ObjectSetInteger(0, id + "tp", OBJPROP_COLOR, clrLimeGreen);
   ObjectSetInteger(0, id + "tp", OBJPROP_STYLE, STYLE_DASH);
   ObjectSetInteger(0, id + "tp", OBJPROP_RAY_RIGHT, false);
   ChartRedraw();
}

void SendSignal(const ENUM_ORDER_TYPE type, const double entry, const double sl, const double tp,
                const double lots, const string why)
{
   string lotTxt = (lots > 0) ? DoubleToString(lots, 3) : "below broker minimum at this risk";
   string msg = StringFormat("%s %s %s @ %s | SL %s | TP %s | lot %s | %s",
                             InpComment, _Symbol, (type == ORDER_TYPE_BUY ? "BUY" : "SELL"),
                             DoubleToString(entry, _Digits), DoubleToString(sl, _Digits),
                             DoubleToString(tp, _Digits), lotTxt, why);
   Print(msg);
   PostTrade("signal", type, entry, sl, tp, lots, 0, why);
   if(MQLInfoInteger(MQL_TESTER)) return;
   if(InpAlertPopup) Alert(msg);
   if(InpPushNotify && TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED))
      if(!SendNotification(StringSubstr(msg, 0, 255)))
         Print("Push notification failed: ", GetLastError());
}

//+------------------------------------------------------------------+
void OpenTrade(const ENUM_ORDER_TYPE type, const double slATR, const double tpATR, const double atr, const string why)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minDist = (double)MathMax(SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL),
                                    SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL)) * pt;

   double slDist = MathMax(slATR * atr, minDist + 2 * pt);
   double tpDist = MathMax(tpATR * atr, minDist + 2 * pt);

   double entry, sl, tp;
   if(type == ORDER_TYPE_BUY) { entry = ask; sl = RoundToTick(entry - slDist); tp = RoundToTick(entry + tpDist); }
   else                       { entry = bid; sl = RoundToTick(entry + slDist); tp = RoundToTick(entry - tpDist); }

   double lots = CalcLots(type, entry, sl);

   if(InpMode == MODE_SIGNALS)
   {
      SendSignal(type, entry, sl, tp, lots, why);
      DrawSignal(type, entry, sl, tp, 20);
      g_lastSignalTime = TimeCurrent();
      g_lastSignal = why;
      g_tradesToday++;
      SaveDayState();
      return;
   }
   if(lots <= 0) return;

   bool ok = (type == ORDER_TYPE_BUY)
             ? g_trade.Buy(lots,  _Symbol, entry, sl, tp, InpComment)
             : g_trade.Sell(lots, _Symbol, entry, sl, tp, InpComment);

   if(ok && (g_trade.ResultRetcode() == TRADE_RETCODE_DONE || g_trade.ResultRetcode() == TRADE_RETCODE_PLACED))
   {
      g_tradesToday++;
      SaveDayState();
      g_lastSignal = why;
      DrawSignal(type, entry, sl, tp, 20);
      PostTrade("open", type, entry, sl, tp, lots, 0, why);
      PrintFormat("%s %s %.3f lots @ %s SL %s TP %s (%s)", (type == ORDER_TYPE_BUY ? "BUY" : "SELL"), _Symbol, lots,
                  DoubleToString(entry, _Digits), DoubleToString(sl, _Digits), DoubleToString(tp, _Digits), why);
   }
   else
      Print("Order failed: ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
//| Break-even and ATR trailing stop.                                |
//+------------------------------------------------------------------+
void ManagePositions()
{
   double atr = Buf(g_hATR, 0, 1);
   if(atr == EMPTY_VALUE || atr <= 0) return;

   double pt      = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minDist = (double)MathMax(SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL),
                                    SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL)) * pt;
   double stepMin = MathMax(InpTrailStepATR * atr, pt);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;

      long   ptype = PositionGetInteger(POSITION_TYPE);
      double open  = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl    = PositionGetDouble(POSITION_SL);
      double tp    = PositionGetDouble(POSITION_TP);
      double bid   = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double ask   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

      // 1R is the distance of the original stop. If SL has already moved past entry, use ATR.
      double r = (sl > 0) ? MathAbs(open - sl) : InpTrendSL_ATR * atr;
      if(r <= 0 || (ptype == POSITION_TYPE_BUY && sl >= open) || (ptype == POSITION_TYPE_SELL && sl > 0 && sl <= open))
         r = InpTrendSL_ATR * atr;

      double newSL = sl;

      if(ptype == POSITION_TYPE_BUY)
      {
         double profit = bid - open;
         if(InpBreakEvenR > 0 && profit >= InpBreakEvenR * r && (sl == 0 || sl < open))
            newSL = open + 2 * pt;
         if(InpTrailStartATR > 0 && profit >= InpTrailStartATR * atr)
            newSL = MathMax(newSL, bid - InpTrailATR * atr);
         newSL = RoundToTick(newSL);
         if(newSL > sl + stepMin * 0.999 || (sl == 0 && newSL > 0))
            if(newSL < bid - minDist)
               if(!g_trade.PositionModify(ticket, newSL, tp))
                  Print("Modify failed: ", g_trade.ResultRetcodeDescription());
      }
      else if(ptype == POSITION_TYPE_SELL)
      {
         double profit = open - ask;
         if(InpBreakEvenR > 0 && profit >= InpBreakEvenR * r && (sl == 0 || sl > open))
            newSL = open - 2 * pt;
         if(InpTrailStartATR > 0 && profit >= InpTrailStartATR * atr)
            newSL = (newSL == 0) ? ask + InpTrailATR * atr : MathMin(newSL, ask + InpTrailATR * atr);
         newSL = RoundToTick(newSL);
         if(newSL > 0 && (sl == 0 || newSL < sl - stepMin * 0.999))
            if(newSL > ask + minDist)
               if(!g_trade.PositionModify(ticket, newSL, tp))
                  Print("Modify failed: ", g_trade.ResultRetcodeDescription());
      }
   }
}

//+------------------------------------------------------------------+
//| Entry logic, evaluated once per closed bar of the entry TF.     |
//+------------------------------------------------------------------+
void CheckEntries()
{
   if(InpMaxOpenTrades > 0 && CountPositions() >= InpMaxOpenTrades) return;
   if(InpMaxTradesPerDay > 0 && g_tradesToday >= InpMaxTradesPerDay) return;
   if(TimeCurrent() < g_cooldownUntil) return;
   if(InpMode == MODE_SIGNALS && TimeCurrent() - g_lastSignalTime < InpSignalGapBars * PeriodSeconds(g_tf)) return;
   if(!HoursOK()) return;

   MqlRates rt[];
   ArraySetAsSeries(rt, true);
   if(CopyRates(_Symbol, g_tf, 0, 3, rt) < 3) return;   // rt[1], rt[2] are closed bars

   double fast1 = Buf(g_hFast, 0, 1), slow1 = Buf(g_hSlow, 0, 1);
   double adx1  = Buf(g_hADX, 0, 1),  pdi1  = Buf(g_hADX, 1, 1), mdi1 = Buf(g_hADX, 2, 1);
   double rsi1  = Buf(g_hRSI, 0, 1),  rsi2  = Buf(g_hRSI, 0, 2);
   double atr1  = Buf(g_hATR, 0, 1);
   double bbU1  = Buf(g_hBB, 1, 1), bbL1 = Buf(g_hBB, 2, 1);
   double bbU2  = Buf(g_hBB, 1, 2), bbL2 = Buf(g_hBB, 2, 2);
   double htf1  = Buf(g_hHTF, 0, 1), htfN = Buf(g_hHTF, 0, 1 + InpHTFSlopeBars);
   double htfC1 = iClose(_Symbol, g_htf, 1);

   if(fast1 == EMPTY_VALUE || slow1 == EMPTY_VALUE || adx1 == EMPTY_VALUE || pdi1 == EMPTY_VALUE ||
      mdi1 == EMPTY_VALUE || rsi1 == EMPTY_VALUE || rsi2 == EMPTY_VALUE || atr1 == EMPTY_VALUE ||
      bbU1 == EMPTY_VALUE || bbL1 == EMPTY_VALUE || bbU2 == EMPTY_VALUE || bbL2 == EMPTY_VALUE ||
      htf1 == EMPTY_VALUE || htfN == EMPTY_VALUE || htfC1 <= 0 || atr1 <= 0)
      return;

   // Spread filter (relative to volatility, works for synthetics and forex alike)
   double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(InpMaxSpreadATR > 0 && spread > InpMaxSpreadATR * atr1) { g_lastSignal = "spread too wide"; return; }

   // Volatility spike filter
   if(InpMaxATRSpike > 0)
   {
      double avg = AverageATR(50);
      if(avg > 0 && atr1 > InpMaxATRSpike * avg) { g_lastSignal = "volatility spike"; return; }
   }

   // Regime
   ENUM_REGIME regime = REGIME_UNCLEAR;
   if(adx1 >= InpADXTrend)      regime = REGIME_TREND;
   else if(adx1 <= InpADXRange) regime = REGIME_RANGE;
   g_lastRegime = (regime == REGIME_TREND) ? "TREND" : (regime == REGIME_RANGE) ? "RANGE" : "UNCLEAR";

   bool htfUp   = htfC1 > htf1 && htf1 > htfN;
   bool htfDown = htfC1 < htf1 && htf1 < htfN;

   double o1 = rt[1].open, c1 = rt[1].close, h1 = rt[1].high, l1 = rt[1].low;
   double c2 = rt[2].close;

   //--- TREND: pullback to fast EMA, continuation candle, momentum confirmation
   if(InpUseTrend && regime == REGIME_TREND)
   {
      bool buy = htfUp && fast1 > slow1 && pdi1 > mdi1 &&
                 l1 <= fast1 + InpPullbackATR * atr1 && c1 > fast1 && c1 > o1 &&
                 rsi1 > InpRSITrendMin && rsi1 < InpRSITrendMax;

      bool sell = htfDown && fast1 < slow1 && mdi1 > pdi1 &&
                  h1 >= fast1 - InpPullbackATR * atr1 && c1 < fast1 && c1 < o1 &&
                  rsi1 < 100.0 - InpRSITrendMin && rsi1 > 100.0 - InpRSITrendMax;

      if(buy)  { OpenTrade(ORDER_TYPE_BUY,  InpTrendSL_ATR, InpTrendTP_ATR, atr1, "trend pullback buy");  return; }
      if(sell) { OpenTrade(ORDER_TYPE_SELL, InpTrendSL_ATR, InpTrendTP_ATR, atr1, "trend pullback sell"); return; }
   }

   //--- RANGE: Bollinger re-entry after an RSI extreme, never against a strong HTF trend
   if(InpUseRange && regime == REGIME_RANGE)
   {
      bool buy  = c2 < bbL2 && c1 > bbL1 && rsi2 < InpRSIOversold && rsi1 > rsi2 && c1 > o1 && !htfDown;
      bool sell = c2 > bbU2 && c1 < bbU1 && rsi2 > 100.0 - InpRSIOversold && rsi1 < rsi2 && c1 < o1 && !htfUp;

      if(buy)  { OpenTrade(ORDER_TYPE_BUY,  InpRangeSL_ATR, InpRangeTP_ATR, atr1, "range reversion buy");  return; }
      if(sell) { OpenTrade(ORDER_TYPE_SELL, InpRangeSL_ATR, InpRangeTP_ATR, atr1, "range reversion sell"); return; }
   }
}

//+------------------------------------------------------------------+
void DrawPanel()
{
   if(!InpShowPanel) return;
   if(MQLInfoInteger(MQL_TESTER) && !MQLInfoInteger(MQL_VISUAL_MODE)) return;

   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   double chg = (g_dayStartBal > 0) ? (eq - g_dayStartBal) / g_dayStartBal * 100.0 : 0.0;
   string status = g_haltedToday ? "HALTED: " + g_haltReason
                 : (TimeCurrent() < g_cooldownUntil) ? "COOLDOWN until " + TimeToString(g_cooldownUntil)
                 : "ACTIVE";
   Comment(StringFormat("Tbot Adaptive EA  |  %s  %s/%s  |  %s\n"
                        "Status: %s\n"
                        "Regime: %s   ADX: %.1f\n"
                        "Today: %+.2f%%   trades %d/%d   open %d/%d\n"
                        "Loss streak: %d   Last: %s",
                        _Symbol, EnumToString(g_tf), EnumToString(g_htf),
                        (InpMode == MODE_AUTO ? "AUTO TRADE" : "SIGNALS ONLY"),
                        status, g_lastRegime, Buf(g_hADX, 0, 1),
                        chg, g_tradesToday, InpMaxTradesPerDay, CountPositions(), InpMaxOpenTrades,
                        g_lossStreak, g_lastSignal));
}

//+------------------------------------------------------------------+
void OnTick()
{
   bool canTrade = DailyGuard();
   ManagePositions();

   if(IsNewBar() && canTrade)
      CheckEntries();

   DrawPanel();
}

//+------------------------------------------------------------------+
//| Track losing streaks from closed deals for the cooldown.        |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!WebOn() || TimeLocal() - g_lastBeat < InpHeartbeatMin * 60) return;
   g_lastBeat = TimeLocal();
   double chg = (g_dayStartBal > 0) ? (AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartBal) / g_dayStartBal * 100.0 : 0.0;
   string state = g_haltedToday ? "HALTED" : (TimeCurrent() < g_cooldownUntil ? "COOLDOWN" : "ACTIVE");
   PostStatus(state, g_lastRegime == "-" ? "" : g_lastRegime, chg, CountPositions(), g_tradesToday,
              g_haltedToday ? g_haltReason : g_lastSignal);
}

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(trans.deal)) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic) return;
   if(HistoryDealGetString(trans.deal, DEAL_SYMBOL) != _Symbol) return;

   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) return;

   double net = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) +
                HistoryDealGetDouble(trans.deal, DEAL_SWAP) +
                HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);

   PostClose(trans.deal, net);
   if(net < 0) g_lossStreak++;
   else        g_lossStreak = 0;

   if(InpMaxConsecLosses > 0 && g_lossStreak >= InpMaxConsecLosses)
   {
      g_cooldownUntil = TimeCurrent() + InpCooldownBars * PeriodSeconds(g_tf);
      PrintFormat("%d losses in a row, pausing new entries until %s", g_lossStreak, TimeToString(g_cooldownUntil));
      g_lossStreak = 0;
   }
}

//+------------------------------------------------------------------+
//| Custom optimisation score: rewards profit factor and sample size |
//| and penalises drawdown, instead of chasing raw win rate.         |
//+------------------------------------------------------------------+
double OnTester()
{
   double trades = TesterStatistics(STAT_TRADES);
   double pf     = TesterStatistics(STAT_PROFIT_FACTOR);
   double dd     = TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   double profit = TesterStatistics(STAT_PROFIT);
   if(trades < 30 || profit <= 0) return 0.0;
   return pf * MathSqrt(trades) / (1.0 + dd / 10.0);
}
//+------------------------------------------------------------------+
