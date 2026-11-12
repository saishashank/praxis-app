export type MarketSourceRow = {
  readonly id: string;
  readonly market: string;
  readonly label: string;
  readonly provides: string;
  readonly terms: string;
  readonly hosts: readonly string[];
  readonly code: readonly string[];
  readonly terms_url: string | null;
  readonly permitted_use: string;
  readonly rate_limits: string | null;
  readonly last_checked: string | null;
  readonly risk: "low" | "medium" | "high";
  readonly status: "pending" | "enabled" | "disabled";
  /** false for a primary price or calendar source: disabling it is not a decision the switch accepts (D-1191). */
  readonly optional: boolean;
  readonly owner_ref: string | null;
  readonly summarisation_permitted: 0 | 1;
  readonly intervalMs: number;
  readonly contact?: boolean;
  readonly probe: { readonly url: string } | null;
};
export type MarketSite = {
  readonly url: string;
  readonly markets: readonly string[];
  readonly sources: readonly string[];
};
export const MARKET_SOURCES: Readonly<Record<string, readonly MarketSourceRow[]>>;
export function marketSourcesOf(market: string): readonly MarketSourceRow[];
export function sourceById(id: string): MarketSourceRow | undefined;
export const MARKET_SITES: Readonly<Record<string, MarketSite>>;
export function siteOfHost(host: string): (MarketSite & { host: string }) | null;
