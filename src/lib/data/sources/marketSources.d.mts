import type { Client } from "@libsql/client";
export function ensureMarketSources(
  db: Pick<Client, "execute" | "batch">,
  market: string,
  o?: { now?: () => Date },
): Promise<{ market: string; sources: number; inserted: number; existing: number }>;
