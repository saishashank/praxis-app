export type Candidate = {
  code: string;
  name: string;
  listing: "nasdaq" | "other";
  exchangeCode: string;
};
export function parseSymbolDirectories(
  nasdaqText: string,
  otherText: string,
): {
  candidates: Candidate[];
  dropped: { test: number; etf: number; structured: number; badSymbol: number; exchange: number };
};
export function capUniverse(
  candidates: readonly { code: string }[],
  medianTraded: ReadonlyMap<string, bigint>,
  max: number,
): { codes: string[]; unranked: number };
