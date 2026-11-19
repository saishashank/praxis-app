export class MarketNotEnabled extends Error {
  constructor(market: string, table?: string | null);
  readonly market: string;
  readonly table: string | null;
}
export function isMarketNotEnabled(err: unknown): err is MarketNotEnabled;
export class UnknownMarket extends Error {
  constructor(market: string);
  readonly market: string;
}
