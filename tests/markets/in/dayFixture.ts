// Hand-made India day files in the exchange's own field names (M20 IN1): the same shape as the recorded fixtures of
// `praxis-app-fixtures/recorded/in/<date>/`, with invented numbers, so the tests need no private repository. Prices are
// on the IN tick grid. Nothing here is a copy of the history extract (D-927).
export const UDIFF_HEAD =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

export type Bar = {
  code: string;
  series?: string;
  open: string;
  high: string;
  low: string;
  close: string;
  prev?: string;
  volume: string;
  sgmt?: string;
  tp?: string;
  name?: string;
};

export function bhavRow(d: string, b: Bar): string {
  return [
    d,
    d,
    b.sgmt ?? "CM",
    "NSE",
    b.tp ?? "STK",
    "1",
    "INE000A01000",
    b.code,
    b.series ?? "EQ",
    "",
    "",
    "",
    "",
    b.name ?? `${b.code} LIMITED`,
    b.open,
    b.high,
    b.low,
    b.close,
    b.close,
    b.prev ?? b.open,
    "",
    b.close,
    "",
    "",
    b.volume,
    "100000000.00",
    "500",
    "F1",
    "1",
    "",
    "",
    "",
    "",
    "",
  ].join(",");
}

export const bhavFile = (d: string, bars: Bar[]): string =>
  [UDIFF_HEAD, ...bars.map((b) => bhavRow(d, b))].join("\n") + "\n";

/** Six invented codes: three large caps without a band, a 5 % band code, a 2 % band code, an ASM code. */
export const CODES = ["ALFA", "BETA", "GAMA", "DLTA", "EPSL", "ZETA"] as const;
export const PRICES: Record<(typeof CODES)[number], string> = {
  ALFA: "1500.00",
  BETA: "640.50",
  GAMA: "275.25",
  DLTA: "48.30",
  EPSL: "21.85",
  ZETA: "9.40",
};

export function barsOf(i: number): Bar[] {
  return CODES.map((code) => {
    const p = PRICES[code];
    const base = Number(p) + i * 0.05;
    const f = (x: number) => x.toFixed(2);
    return {
      code,
      series: code === "ZETA" ? "BE" : "EQ",
      open: f(base),
      high: f(base + 1),
      low: f(base - 1),
      close: f(base + 0.25),
      prev: f(base - 0.05),
      volume: String(200_000 + i * 1000),
    };
  });
}

export const bandsFile = (): string =>
  [
    "Symbol,Series,Security Name,Band,Remarks",
    "ALFA,EQ,ALFA LIMITED,No Band,-",
    "BETA,EQ,BETA LIMITED,No Band,-",
    "GAMA,EQ,GAMA LIMITED,20,-",
    "DLTA,EQ,DELTA LIMITED,5,-",
    "EPSL,EQ,EPSILON LIMITED,2,-",
    "ZETA,BE,ZETA LIMITED,5,-",
  ].join("\n") + "\n";

export const asmFile = (): string =>
  JSON.stringify({
    longterm: {
      data: [{ symbol: "ZETA", survCode: "LTASM - I (13)", asmSurvIndicator: "Stage I" }],
    },
    shortterm: { data: [] },
  });
export const gsmFile = (): string =>
  JSON.stringify([{ symbol: "EPSL", survCode: "GSM - VI (6)", gsmStage: "VI" }]);

export const classificationFile = (): string =>
  [
    "Company Name,Industry,Symbol,Series,ISIN Code",
    '"Alfa Industries, Ltd.",Financial Services,ALFA,EQ,INE000A01000',
    "Beta Ltd.,Information Technology,BETA,EQ,INE000B01000",
    "Gama Ltd.,-,GAMA,EQ,INE000C01000",
  ].join("\n") + "\n";

export const indexFile = (d: string): string =>
  [
    "index_code,d,open,high,low,close",
    `NSEI,${d},24000.10,24100.00,23950.55,24050.25`,
    `INDIAVIX,${d},13.10,13.80,12.90,13.25`,
    `OTHER,${d},1,1,1,1`,
  ].join("\n") + "\n";
