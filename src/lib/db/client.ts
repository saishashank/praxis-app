// Database clients from environment (D-020, ROL-101a). Errors never include env values.
// D-204: one client per database and process, reused by every request. A new client per call opened
// a new connection for each page and threw away the loaders' memo (design 2.9) with it. The libsql
// client keeps no per-request state (each transaction has its own stream), so sharing it is safe;
// callers never close it. A closed client (a test, a dropped connection) is replaced.
import { createClient, type Client } from "@libsql/client";
import { wrapClient } from "@/lib/market/guard.mjs";
import type { MarketNotEnabled } from "@/lib/market/errors.mjs";

const isLocal = (u: string) => u.startsWith("file:") || u === ":memory:";
const shared = new Map<string, Client>();

function make(urlVar: string, tokenVar: string, intMode?: "bigint"): Client {
  const url = process.env[urlVar];
  const authToken = process.env[tokenVar];
  if (!url || (!authToken && !isLocal(url))) throw new Error("database not configured");
  const key = `${url}\n${authToken ?? ""}\n${intMode ?? ""}`;
  const hit = shared.get(key);
  if (hit && !hit.closed) return hit;
  const client = createClient({
    url,
    authToken: authToken || undefined,
    ...(intMode ? { intMode } : {}),
  });
  shared.set(key, client);
  return client;
}

/**
 * M19 A2 (D-995): the incident writer for a refused write. S2 `market_not_enabled`, at most once per market per
 * process-day here (the incident itself opens once while unresolved), best effort: it never throws, and it
 * writes through the raw client (the incident table has no market column, the guard is not in its way).
 */
const reported = new Set<string>();
export function marketRefusalReporter(raw: Client, now: () => Date = () => new Date()) {
  return async (err: MarketNotEnabled, info: { table: string | null }): Promise<void> => {
    try {
      const at = now();
      const key = `${err.market}|${at.toISOString().slice(0, 10)}`;
      if (reported.has(key)) return;
      reported.add(key);
      const { notifyIncident } = await import("@/lib/incidents/notify");
      await notifyIncident({ db: raw, now: () => at }, "market_not_enabled", "S2", {
        summary: `A write for a market that is not enabled was refused: ${err.market}`,
        detail: { market: err.market, table: info.table },
      });
    } catch {
      /* best effort */
    }
  };
}

/** Test hook: forget which refusals were reported (the once-per-market-per-day memory). */
export function resetMarketRefusalReports(): void {
  reported.clear();
}

export function mainDb(): Client {
  const raw = make("TURSO_MAIN_URL", "TURSO_MAIN_TOKEN");
  return wrapClient(raw, marketRefusalReporter(raw));
}

// Only the Vercel app holds the auth-DB token (ROL-101a); never call this from workers/Actions.
export function authDb(): Client {
  return make("TURSO_AUTH_URL", "TURSO_AUTH_TOKEN");
}

/**
 * V1-I6 / D-784: a lossless auth-DB client for the signed backup export only. The default number
 * mode throws on an INTEGER above 2^53; a backup must dump every value exactly (the main-DB dump
 * has used intMode "bigint" since D-175). Everything else keeps the normal client.
 */
export function authDbBigint(): Client {
  return make("TURSO_AUTH_URL", "TURSO_AUTH_TOKEN", "bigint");
}

/**
 * V1-S6 / D-713: the foreign-key policy is ON. SQLite itself defaults to OFF per connection, but
 * the libSQL client and Turso open every connection with `foreign_keys = 1`, and the auth schema
 * (db/migrations/auth/0003..0006) declares REFERENCES app_user(id) expecting it. The code relies on
 * it being enforced and never turns it off; a restore therefore inserts parents before children
 * (scripts/backup/core.mjs foreignKeyOrder). tests/db/foreignKeys.test.ts asserts the state per
 * connection and per transaction so a driver change cannot silently make the keys decorative.
 */
export const FOREIGN_KEYS_POLICY = "on" as const;

export async function foreignKeysEnabled(db: Pick<Client, "execute">): Promise<boolean> {
  const r = await db.execute("PRAGMA foreign_keys");
  return Number(r.rows[0]?.foreign_keys) === 1;
}
