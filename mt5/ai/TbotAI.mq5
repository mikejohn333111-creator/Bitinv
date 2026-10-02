//+------------------------------------------------------------------+
//|                                                      TbotAI.mq5 |
//|  Machine-learning Expert Advisor for the 1-minute chart.         |
//|                                                                  |
//|  A neural network (trained in Python by train.py, embedded here  |
//|  as ONNX) reads the last 240 closed M1 bars and estimates the    |
//|  probability that price moves +B or -B first within the next     |
//|  N bars (B = barrier x ATR). The EA trades only when that        |
//|  probability passes a confidence threshold, with SL = TP = B,    |
//|  closes the trade after N bars if neither is hit, and keeps the  |
//|  same risk controls as TbotAdaptive.                             |
//|                                                                  |
//|  BEFORE COMPILING: put TbotAI.onnx next to this file             |
//|  (MQL5\Experts\). Retrain -> replace the .onnx -> recompile.    |
//|                                                                  |
//|  A model is only as good as its out-of-sample test. Read         |
//|  TbotAI_config.json and run it on DEMO first.                    |
//+------------------------------------------------------------------+
#property copyright "Tbot"
#property version   "1.00"
#property description "ML (ONNX) M1 Expert Advisor with confidence threshold and risk limits."

#include <Trade\Trade.mqh>

#define BOT_NAME "TbotAI"

#resource "TbotAI.onnx" as uchar ExtModel[]

#define N_FEATURES 17
#define HIST_BARS  300

enum ENUM_RUN_MODE
{
   MODE_SIGNALS = 0,   // Signals only (alerts, no trading)
   MODE_AUTO    = 1    // Auto trade (places orders itself)
};

//--- inputs ---------------------------------------------------------
input group "Mode"
input ENUM_RUN_MODE InpMode     = MODE_SIGNALS; // Mode: signals only or auto trade
input bool   InpAlertPopup      = true;   // Signals: pop-up alert + sound in the terminal
input bool   InpPushNotify      = true;   // Signals: push notification to the MT5 mobile app
input bool   InpDrawSignals     = true;   // Draw entry arrow, SL and TP on the chart

input group "Model (must match TbotAI_config.json)"
input double InpThreshold      = 0.50;   // Min model probability to trade (config: suggested_threshold)
input double InpMargin         = 0.10;   // P(direction) must beat P(opposite) by this
input double InpBarrierATR     = 3.0;    // SL = TP = this x ATR(14)  (config: barrier_atr)
input int    InpHorizonBars    = 60;     // Close trade after this many M1 bars (config: horizon_bars)
input bool   InpLogFeatures    = false;  // Print features + probabilities each bar (debug)

input group "Risk management"
input long   InpMagic           = 7501002; // Magic number (unique per chart)
input double InpRiskPercent     = 0.5;     // Risk per trade (% of balance)
input double InpMaxDailyLossPct = 3.0;     // Daily loss limit (% of day-start balance, 0 = off)
input int    InpMaxOpenTrades   = 1;       // Max open positions (this EA, this symbol)
input int    InpMaxTradesPerDay = 20;      // Max new trades per day (0 = unlimited)
input int    InpMaxConsecLosses = 4;       // Losing streak that triggers cooldown (0 = off)
input int    InpCooldownBars    = 60;      // Cooldown length (M1 bars)

input group "Filters"
input double InpMaxSpreadR      = 0.15;    // Skip if spread > this fraction of the SL distance
input bool   InpUseHours        = false;   // Restrict trading hours (server time)
input int    InpStartHour       = 7;       // Start hour
input int    InpEndHour         = 20;      // End hour (exclusive)
input string InpComment         = "TbotAI";

input group "Web dashboard (optional)"
input string InpWebURL          = "";     // Dashboard address, e.g. https://tbot-yourname.vercel.app (empty = off)
input string InpWebSecret       = "";     // Secret (same value as TBOT_SECRET on Vercel)
input int    InpHeartbeatMin    = 5;      // Send bot status every N minutes

//--- globals --------------------------------------------------------
CTrade   g_trade;
long     g_model = INVALID_HANDLE;
datetime g_lastBar = 0, g_day = 0, g_cooldownUntil = 0;
double   g_dayStartBal = 0;
bool     g_halted = false;
int      g_tradesToday = 0, g_lossStreak = 0;
double   g_pUp = 0, g_pDn = 0, g_pNone = 0;
string   g_last = "-";
datetime g_lastSignalTime = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   g_model = OnnxCreateFromBuffer(ExtModel, ONNX_DEFAULT);
   if(g_model == INVALID_HANDLE) { Print("OnnxCreateFromBuffer failed: ", GetLastError()); return INIT_FAILED; }

   ulong in_shape[]  = {1, N_FEATURES};
   ulong lbl_shape[] = {1};
   ulong prb_shape[] = {1, 3};
   if(!OnnxSetInputShape(g_model, 0, in_shape) ||
      !OnnxSetOutputShape(g_model, 0, lbl_shape) ||
      !OnnxSetOutputShape(g_model, 1, prb_shape))
   {
      Print("Setting ONNX shapes failed: ", GetLastError(), " (was the model exported with zipmap=False and 17 features?)");
      return INIT_FAILED;
   }
   if(InpThreshold <= 0.34 || InpThreshold >= 1 || InpRiskPercent <= 0 || InpRiskPercent > 5)
   {
      Print("Check inputs: 0.34 < threshold < 1, 0 < risk% <= 5.");
      return INIT_PARAMETERS_INCORRECT;
   }
   g_trade.SetExpertMagicNumber((ulong)InpMagic);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_trade.SetDeviationInPoints(30);

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

void OnDeinit(const int reason)
{
   EventKillTimer();
   if(g_model != INVALID_HANDLE) OnnxRelease(g_model);
   Comment("");
}

//+------------------------------------------------------------------+
//| Features: exact mirror of features.py (rates[1] = last closed).  |
//+------------------------------------------------------------------+
double TR(const MqlRates &r[], const int i)
{
   return MathMax(r[i].high, r[i + 1].close) - MathMin(r[i].low, r[i + 1].close);
}

double Clip(const double v) { return MathMax(-50.0, MathMin(50.0, v)); }

bool BuildFeatures(matrixf &x, double &atr)
{
   MqlRates r[];
   ArraySetAsSeries(r, true);
   if(CopyRates(_Symbol, PERIOD_M1, 0, HIST_BARS, r) < HIST_BARS) return false;

   double sTR14 = 0, sTR240 = 0;
   for(int i = 1; i <= 240; i++)
   {
      double tr = TR(r, i);
      sTR240 += tr;
      if(i <= 14) sTR14 += tr;
   }
   atr = sTR14 / 14.0;
   double trAvg = sTR240 / 240.0;
   if(atr <= 0 || trAvg <= 0) return false;

   double c1 = r[1].close, o1 = r[1].open, h1 = r[1].high, l1 = r[1].low;
   double f[N_FEATURES];
   int lags[8] = {1, 2, 3, 5, 10, 15, 30, 60};
   for(int k = 0; k < 8; k++) f[k] = (c1 - r[1 + lags[k]].close) / atr;

   double s20 = 0, s60 = 0;
   for(int i = 1; i <= 60; i++) { s60 += r[i].close; if(i <= 20) s20 += r[i].close; }
   f[8]  = (c1 - s20 / 20.0) / atr;
   f[9]  = (c1 - s60 / 60.0) / atr;
   f[10] = (h1 - l1) / atr;
   f[11] = (c1 - o1) / atr;
   f[12] = (h1 - MathMax(o1, c1)) / atr;
   f[13] = (MathMin(o1, c1) - l1) / atr;

   double gain = 0, loss = 0;
   for(int i = 1; i <= 14; i++)
   {
      double d = r[i].close - r[i + 1].close;
      if(d > 0) gain += d; else loss -= d;
   }
   f[14] = ((gain + loss > 0) ? gain / (gain + loss) : 0.5) - 0.5;
   f[15] = atr / trAvg;

   double hh = r[1].high, ll = r[1].low;
   for(int i = 2; i <= 60; i++) { hh = MathMax(hh, r[i].high); ll = MathMin(ll, r[i].low); }
   f[16] = ((hh > ll) ? (c1 - ll) / (hh - ll) : 0.5) - 0.5;

   x.Resize(1, N_FEATURES);
   for(int k = 0; k < N_FEATURES; k++) x[0][k] = (float)Clip(f[k]);
   return true;
}

bool Predict(double &atr)
{
   matrixf x;
   if(!BuildFeatures(x, atr)) return false;
   long   label[1];
   matrixf prob(1, 3);
   if(!OnnxRun(g_model, ONNX_NO_CONVERSION, x, label, prob))
   {
      Print("OnnxRun failed: ", GetLastError());
      return false;
   }
   g_pDn = prob[0][0]; g_pNone = prob[0][1]; g_pUp = prob[0][2];
   if(InpLogFeatures)
   {
      string s = "";
      for(int k = 0; k < N_FEATURES; k++) s += DoubleToString(x[0][k], 4) + " ";
      PrintFormat("features: %s| P(down)=%.3f P(none)=%.3f P(up)=%.3f", s, g_pDn, g_pNone, g_pUp);
   }
   return true;
}

//+------------------------------------------------------------------+
//| Helpers shared with TbotAdaptive                                 |
//+------------------------------------------------------------------+
double RoundToTick(const double p)
{
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   return (ts > 0) ? NormalizeDouble(MathRound(p / ts) * ts, _Digits) : NormalizeDouble(p, _Digits);
}

int CountPositions()
{
   int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagic) n++;
   return n;
}

void CloseAll()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         g_trade.PositionClose(t);
   }
}

// Close trades that have been open longer than the model's horizon.
void TimeExit()
{
   int secs = InpHorizonBars * PeriodSeconds(PERIOD_M1);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(TimeCurrent() - (datetime)PositionGetInteger(POSITION_TIME) >= secs)
         if(!g_trade.PositionClose(t)) Print("Time exit failed: ", g_trade.ResultRetcodeDescription());
   }
}

bool DailyGuard()
{
   MqlDateTime dt; TimeCurrent(dt); dt.hour = 0; dt.min = 0; dt.sec = 0;
   datetime today = StructToTime(dt);
   if(today != g_day)
   {
      g_day = today; g_dayStartBal = AccountInfoDouble(ACCOUNT_BALANCE);
      g_halted = false; g_tradesToday = 0;
   }
   if(g_halted) return false;
   double chg = (g_dayStartBal > 0) ? (AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartBal) / g_dayStartBal * 100 : 0;
   if(InpMaxDailyLossPct > 0 && chg <= -InpMaxDailyLossPct)
   {
      g_halted = true;
      CloseAll();
      PrintFormat("Daily loss limit hit (%.2f%%). No more trades today.", chg);
      return false;
   }
   return true;
}

double CalcLots(const ENUM_ORDER_TYPE type, const double entry, const double sl)
{
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double risk   = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
   double pl = 0;
   if(!OrderCalcProfit(type, _Symbol, 1.0, entry, sl, pl) || pl >= 0)
   {
      double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE), ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tv <= 0 || ts <= 0) return 0;
      pl = -MathAbs(entry - sl) / ts * tv;
   }
   double lossPerLot = MathAbs(pl);
   if(lossPerLot <= 0 || step <= 0) return 0;
   double lots = MathFloor(risk / lossPerLot / step + 1e-9) * step;
   if(lots < minLot)
   {
      if(minLot * lossPerLot > risk * 1.5) { Print("Skip: minimum lot would exceed the risk limit."); return 0; }
      lots = minLot;
   }
   lots = MathMin(lots, maxLot);
   double margin = 0, free = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   while(lots >= minLot && OrderCalcMargin(type, _Symbol, lots, entry, margin) && margin > free * 0.9) lots -= step;
   if(lots < minLot) return 0;
   return NormalizeDouble(lots, (int)MathMax(0, MathCeil(-MathLog10(step) - 1e-9)));
}

bool HoursOK()
{
   if(!InpUseHours) return true;
   MqlDateTime dt; TimeCurrent(dt);
   if(InpStartHour <= InpEndHour) return dt.hour >= InpStartHour && dt.hour < InpEndHour;
   return dt.hour >= InpStartHour || dt.hour < InpEndHour;
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
void DrawSignal(const ENUM_ORDER_TYPE type, const double entry, const double sl, const double tp)
{
   if(!InpDrawSignals) return;
   datetime t0 = iTime(_Symbol, PERIOD_M1, 0);
   datetime t1 = t0 + InpHorizonBars * 60;
   string id   = "TbotAISig_" + IntegerToString((long)t0) + "_";
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

void SendSignal(const ENUM_ORDER_TYPE type, const double entry, const double sl, const double tp, const double lots)
{
   string lotTxt = (lots > 0) ? DoubleToString(lots, 3) : "below broker minimum at this risk";
   string msg = StringFormat("%s %s %s @ %s | SL %s | TP %s | lot %s | conf %.0f%% | close after %d min",
                             InpComment, _Symbol, (type == ORDER_TYPE_BUY ? "BUY" : "SELL"),
                             DoubleToString(entry, _Digits), DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                             lotTxt, 100.0 * (type == ORDER_TYPE_BUY ? g_pUp : g_pDn), InpHorizonBars);
   Print(msg);
   PostTrade("signal", type, entry, sl, tp, lots, type == ORDER_TYPE_BUY ? g_pUp : g_pDn,
             StringFormat("close after %d min if SL/TP not hit", InpHorizonBars));
   if(MQLInfoInteger(MQL_TESTER)) return;
   if(InpAlertPopup) Alert(msg);
   if(InpPushNotify && TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED))
      if(!SendNotification(StringSubstr(msg, 0, 255)))
         Print("Push notification failed: ", GetLastError());
}

void Open(const ENUM_ORDER_TYPE type, const double atr)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minDist = (double)MathMax(SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL),
                                    SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL)) * pt;
   double B = MathMax(InpBarrierATR * atr, minDist + 2 * pt);

   if(InpMaxSpreadR > 0 && (ask - bid) > InpMaxSpreadR * B) { g_last = "spread too wide vs target"; return; }

   double entry = (type == ORDER_TYPE_BUY) ? ask : bid;
   double sl = RoundToTick(type == ORDER_TYPE_BUY ? entry - B : entry + B);
   double tp = RoundToTick(type == ORDER_TYPE_BUY ? entry + B : entry - B);
   double lots = CalcLots(type, entry, sl);

   if(InpMode == MODE_SIGNALS)
   {
      SendSignal(type, entry, sl, tp, lots);
      DrawSignal(type, entry, sl, tp);
      g_lastSignalTime = TimeCurrent();
      g_tradesToday++;
      g_last = StringFormat("signal %s P(up)=%.2f P(down)=%.2f", type == ORDER_TYPE_BUY ? "BUY" : "SELL", g_pUp, g_pDn);
      return;
   }
   if(lots <= 0) return;

   bool ok = (type == ORDER_TYPE_BUY) ? g_trade.Buy(lots, _Symbol, entry, sl, tp, InpComment)
                                      : g_trade.Sell(lots, _Symbol, entry, sl, tp, InpComment);
   if(ok && g_trade.ResultRetcode() == TRADE_RETCODE_DONE)
   {
      g_tradesToday++;
      DrawSignal(type, entry, sl, tp);
      PostTrade("open", type, entry, sl, tp, lots, type == ORDER_TYPE_BUY ? g_pUp : g_pDn,
                StringFormat("closes after %d min if SL/TP not hit", InpHorizonBars));
      g_last = StringFormat("%s P(up)=%.2f P(down)=%.2f", type == ORDER_TYPE_BUY ? "BUY" : "SELL", g_pUp, g_pDn);
      Print(g_last);
   }
   else Print("Order failed: ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
void OnTick()
{
   bool canTrade = DailyGuard();
   TimeExit();

   datetime bar = iTime(_Symbol, PERIOD_M1, 0);
   if(bar != 0 && bar != g_lastBar)
   {
      g_lastBar = bar;
      double atr = 0;
      if(Predict(atr) && canTrade && HoursOK() && TimeCurrent() >= g_cooldownUntil &&
         (InpMaxOpenTrades <= 0 || CountPositions() < InpMaxOpenTrades) &&
         (InpMaxTradesPerDay <= 0 || g_tradesToday < InpMaxTradesPerDay) &&
         (InpMode == MODE_AUTO || TimeCurrent() - g_lastSignalTime >= InpHorizonBars * 60))
      {
         if(g_pUp >= InpThreshold && g_pUp - g_pDn >= InpMargin)      Open(ORDER_TYPE_BUY, atr);
         else if(g_pDn >= InpThreshold && g_pDn - g_pUp >= InpMargin) Open(ORDER_TYPE_SELL, atr);
      }
   }

   if(!MQLInfoInteger(MQL_TESTER) || MQLInfoInteger(MQL_VISUAL_MODE))
      Comment(StringFormat("TbotAI  %s M1  |  %s\nStatus: %s\nP(up) %.2f   P(down) %.2f   P(none) %.2f   threshold %.2f\n"
                           "Trades today %d   open %d   loss streak %d\nLast: %s",
                           _Symbol, (InpMode == MODE_AUTO ? "AUTO TRADE" : "SIGNALS ONLY"), g_halted ? "HALTED (daily loss limit)" : (TimeCurrent() < g_cooldownUntil ? "COOLDOWN" : "ACTIVE"),
                           g_pUp, g_pDn, g_pNone, InpThreshold, g_tradesToday, CountPositions(), g_lossStreak, g_last));
}

void OnTimer()
{
   if(!WebOn() || TimeLocal() - g_lastBeat < InpHeartbeatMin * 60) return;
   g_lastBeat = TimeLocal();
   double chg = (g_dayStartBal > 0) ? (AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartBal) / g_dayStartBal * 100.0 : 0.0;
   string state = g_halted ? "HALTED" : (TimeCurrent() < g_cooldownUntil ? "COOLDOWN" : "ACTIVE");
   PostStatus(state, "", chg, CountPositions(), g_tradesToday,
              StringFormat("P(up) %.2f  P(down) %.2f  threshold %.2f", g_pUp, g_pDn, InpThreshold));
}

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &req, const MqlTradeResult &res)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || !HistoryDealSelect(trans.deal)) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic || HistoryDealGetString(trans.deal, DEAL_SYMBOL) != _Symbol) return;
   long e = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(e != DEAL_ENTRY_OUT && e != DEAL_ENTRY_OUT_BY) return;
   double net = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) + HistoryDealGetDouble(trans.deal, DEAL_SWAP) +
                HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);
   PostClose(trans.deal, net);
   g_lossStreak = (net < 0) ? g_lossStreak + 1 : 0;
   if(InpMaxConsecLosses > 0 && g_lossStreak >= InpMaxConsecLosses)
   {
      g_cooldownUntil = TimeCurrent() + InpCooldownBars * 60;
      g_lossStreak = 0;
   }
}

double OnTester()
{
   double trades = TesterStatistics(STAT_TRADES), pf = TesterStatistics(STAT_PROFIT_FACTOR);
   double dd = TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   if(trades < 50 || TesterStatistics(STAT_PROFIT) <= 0) return 0;
   return pf * MathSqrt(trades) / (1.0 + dd / 10.0);
}
