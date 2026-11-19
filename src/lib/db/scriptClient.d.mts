import type { Client } from "@libsql/client";

export declare const REFUSAL_KIND: "market_not_enabled";
export declare const REFUSAL_SEVERITY: "S2";

export declare function marketRefusalReporter(
  raw: Pick<Client, "execute">,
  now?: () => Date,
): (err: { readonly market: string }, info: { readonly table: string | null }) => Promise<void>;

export declare function resetMarketRefusalReports(): void;

export declare function scriptDb(o: {
  readonly url: string | undefined;
  readonly token?: string | undefined;
  readonly intMode?: "bigint";
}): Client;
