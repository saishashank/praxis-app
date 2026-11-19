// Typed market errors (M19 A1/A2; MKT-110). `MarketNotEnabled` is the one error for "this market is not
// enabled": the loader's requireEnabledMarket throws it, the write guard (guard.mjs, stream A2) re-exports it
// and maps the trigger's `MarketNotEnabled` text to it. Plain ESM so the Worker and the scripts import it too.

export class MarketNotEnabled extends Error {
  /**
   * @param {string} market the market code that is not enabled
   * @param {string | null} [table] the table a refused write targeted, when known
   */
  constructor(market, table = null) {
    super(table === null ? `MarketNotEnabled ${market}` : `MarketNotEnabled ${market} ${table}`);
    this.name = "MarketNotEnabled";
    this.market = market;
    this.table = table;
  }
}

/** True for a MarketNotEnabled error (also across module copies). */
export function isMarketNotEnabled(err) {
  return (
    err instanceof MarketNotEnabled || (err instanceof Error && err.name === "MarketNotEnabled")
  );
}

/** A market code that is not in the seed registry or has no profile row. */
export class UnknownMarket extends Error {
  /** @param {string} market */
  constructor(market) {
    super(`unknown market ${market}`);
    this.name = "UnknownMarket";
    this.market = market;
  }
}
