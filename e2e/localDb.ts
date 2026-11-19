import { createClient, type Client } from "@libsql/client";

/** How long a test connection waits for another connection's lock before SQLITE_BUSY (ms). */
export const E2E_BUSY_TIMEOUT_MS = 10_000;

/**
 * A libSQL client on one of the E2E run's local `file:` databases that WAITS for a lock instead of
 * failing at once. The production server and the parallel Playwright workers all write the same
 * auth.db; without a busy timeout a read that meets another connection's write lock threw
 * `SQLITE_BUSY: database is locked` (main CI 2026-11-19, m16-blueprint-page sign-in, D-1845).
 */
export async function openLocalDb(url: string): Promise<Client> {
  const db = createClient({ url });
  if (url.startsWith("file:")) {
    await db.execute(`PRAGMA busy_timeout = ${E2E_BUSY_TIMEOUT_MS}`);
  }
  return db;
}
