import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const MIGRATIONS = (name: "main" | "auth") => path.join(ROOT, "db", "migrations", name);

const dirs: string[] = [];

export function tempDbUrl(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-db-"));
  dirs.push(dir);
  return pathToFileURL(path.join(dir, "t.db")).href;
}

const clients: Client[] = [];

export function track(c: Client): Client {
  clients.push(c);
  return c;
}

export function cleanupTempDbs(): void {
  for (const c of clients.splice(0)) c.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows may keep a lock briefly; the OS temp folder is cleaned later.
    }
  }
}

export async function freshDb(name: "main" | "auth"): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl() }));
  await migrateUp(db, await loadMigrations(MIGRATIONS(name)));
  return db;
}

export async function schemaOf(db: Client): Promise<string[]> {
  const r = await db.execute(
    "SELECT type || ':' || name || ':' || COALESCE(sql,'') AS s FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY type, name",
  );
  return r.rows.map((x) => String(x.s));
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Plants a row of a market that is not enabled (M19 A2, D-995): migration 0035's triggers refuse such a row, so the
 * helper enables the market, inserts, and restores the market to what it was (a market with no `market` row gets
 * one, off and disabled). Use it for fixtures that need an off-market row, e.g. the nightly invariant's. A direct
 * `UPDATE market SET mode` on a market that is not enabled is refused by 0034's row-invariant triggers, so the
 * helper only ever touches `enabled`.
 */
export async function plantOffMarketRow(
  db: Pick<Client, "execute">,
  table: string,
  row: Record<string, string | number | bigint | null> & { market: string },
): Promise<void> {
  const cols = Object.keys(row);
  if (!IDENT.test(table) || !cols.every((c) => IDENT.test(c))) throw new Error("bad identifier");
  const market = row.market;
  const had = await db.execute({
    sql: "SELECT enabled FROM market WHERE code = ?",
    args: [market],
  });
  const state: "enabled" | "disabled" | "absent" = had.rows[0]
    ? Number(had.rows[0].enabled) === 1
      ? "enabled"
      : "disabled"
    : "absent";
  if (state === "absent") {
    await db.execute({
      sql: `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled)
            VALUES (?, 'UTC', '10:00', '16:00', '16:10', 'XXX', 'off', 1)`,
      args: [market],
    });
  } else if (state === "disabled") {
    await db.execute({ sql: "UPDATE market SET enabled = 1 WHERE code = ?", args: [market] });
  }
  try {
    await db.execute({
      sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      args: cols.map((c) => row[c]!),
    });
  } finally {
    if (state !== "enabled") {
      await db.execute({
        sql: "UPDATE market SET enabled = 0, mode = 'off' WHERE code = ?",
        args: [market],
      });
    }
  }
}

/**
 * Makes a market writable for a fixture (M19 A2): a code with no `market` row gets one (mode off), a disabled one is
 * enabled. For tests that use an invented market (ZZ) or IN/US as a plain data key; the production shape is AU only.
 */
export async function allowMarket(db: Pick<Client, "execute">, code: string): Promise<void> {
  const had = await db.execute({ sql: "SELECT 1 FROM market WHERE code = ?", args: [code] });
  if (had.rows.length > 0) {
    await db.execute({ sql: "UPDATE market SET enabled = 1 WHERE code = ?", args: [code] });
  } else {
    await db.execute({
      sql: `INSERT INTO market (code, tz, open_time, close_time, cutoff_time, currency, mode, enabled)
            VALUES (?, 'UTC', '10:00', '16:00', '16:10', 'XXX', 'off', 1)`,
      args: [code],
    });
  }
}
