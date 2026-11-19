export declare const REFUSAL_KIND: "market_not_enabled";
export declare const REFUSAL_SEVERITY: "S2";
export declare function refusalIncidentStatement(
  at: Date,
  market: string,
  table: string | null,
): { sql: string; args: (string | number | null)[] };
export declare function refusalKey(at: Date, market: string): string;
