//+------------------------------------------------------------------+
//|                                                   ExportBars.mq5 |
//|  Script: exports M1 history of the chart symbol to a CSV file in |
//|  <Data Folder>\MQL5\Files\ for training the TbotAI model.        |
//|  Drag it onto any chart of the symbol you want to train on.      |
//+------------------------------------------------------------------+
#property script_show_inputs
#property version "1.00"

input int             InpBars = 500000;      // Number of bars to export (most recent)
input ENUM_TIMEFRAMES InpTF   = PERIOD_M1;   // Timeframe (the EA is trained on M1)

void OnStart()
{
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int got = CopyRates(_Symbol, InpTF, 0, InpBars, r);
   if(got <= 0)
   {
      Print("CopyRates failed (", GetLastError(), "). Scroll the chart back or raise 'Max bars in chart' in Tools > Options > Charts.");
      return;
   }
   string name = _Symbol + "_" + StringSubstr(EnumToString(InpTF), 7) + ".csv";
   StringReplace(name, " ", "_");
   int f = FileOpen(name, FILE_WRITE | FILE_ANSI | FILE_TXT);
   if(f == INVALID_HANDLE) { Print("Cannot open ", name, ": ", GetLastError()); return; }

   FileWriteString(f, "time,open,high,low,close\n");
   for(int i = 0; i < got - 1; i++)          // skip the still-forming last bar
   {
      string t = TimeToString(r[i].time, TIME_DATE | TIME_SECONDS);
      StringReplace(t, ".", "-");
      FileWriteString(f, StringFormat("%s,%s,%s,%s,%s\n", t,
                      DoubleToString(r[i].open, _Digits), DoubleToString(r[i].high, _Digits),
                      DoubleToString(r[i].low, _Digits),  DoubleToString(r[i].close, _Digits)));
   }
   FileClose(f);
   PrintFormat("Exported %d bars to MQL5\\Files\\%s", got - 1, name);
}
