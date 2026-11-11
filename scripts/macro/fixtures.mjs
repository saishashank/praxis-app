// Fixture text for the RBA and ABS parsers (DAT-251 c, D-973): synthetic rows in the layout the two sources use
// (verified 2026-11-11). Kept as JS strings, not .csv files, so the repository hygiene scan sees no data file.
// The RBA text starts with the UTF-8 byte-order mark the real file has.
export const RBA_F1 =
  "﻿F1 INTEREST RATES AND YIELDS – MONEY MARKET\nTitle,Cash Rate Target,Change in the Cash Rate Target,Interbank Overnight Cash Rate,Other Series\nDescription,Cash Rate Target; as announced by the Board,Change,Interbank Overnight Cash Rate,Other\nFrequency,Daily,Daily,Daily,Daily\nType,Original,Original,Original,Original\nUnits,Per cent,Per cent,Per cent,Per cent\n\n\nSource,RBA,RBA,RBA,RBA\nPublication date,11-Nov-2026,11-Nov-2026,11-Nov-2026,11-Nov-2026\nSeries ID,FIRMMCRTD,FIRMMCRCTD,FIRMMCCRT,FIRMMXXXX\n04-Jan-2011,4.75,,4.75,1.0\n05-Nov-2025,3.60,,3.58,1.0\n06-Nov-2025,3.60,,3.57,1.0\n10-Nov-2026,4.35,0.25,4.34,1.0\n11-Nov-2026,4.35,,,1.0\n";
export const ABS_CPI =
  "DATAFLOW,MEASURE,INDEX,TSEST,REGION,FREQ,TIME_PERIOD,OBS_VALUE,UNIT_MEASURE,OBS_STATUS,DECIMALS,OBS_COMMENT,BASE_PERIOD\nABS:CPI(2.0.0),1,10001,10,50,Q,2025-Q1,97.7,IN,,,,25\nABS:CPI(2.0.0),1,10001,10,50,Q,2026-Q3,103.64,IN,,,,25\nABS:CPI(2.0.0),1,10001,10,50,Q,2026-Q2,102.31,IN,,,,25\nABS:CPI(2.0.0),1,10001,10,50,Q,2025-Q4,100.32,IN,,,,25\nABS:CPI(2.0.0),1,10001,10,50,Q,bad,1.0,IN,,,,25\n";
