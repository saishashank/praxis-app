// Shared fixtures of the alt regime tests (M22 E5): a fresh migrated database, a regime row, source register rows, outside
// points and a dump of every table except the shadow table. Synthetic data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { freshDb } from "../../db/helpers";

export const NOW = "2030-02-01T10:00:00.000Z";
export const D = "2030-02-01";

export async function world(): Promise<Client> {
  return freshDb("main");
}

export async function putRegime(db: Client, d: string, state: string, version = 1): Promise<void> {
  await db.execute({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', ?, ?, 1000000, ?, ?, 0)`,
    args: [d, version, state, state],
  });
}

export async function accept(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO source_register (source, risk, status) VALUES (?, 'medium', 'enabled')",
    args: [id],
  });
}

export async function putPoint(
  db: Client,
  source: "polymarket" | "kalshi",
  event: string,
  d: string,
  ppm: number,
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO alt_input_point (source, event_key, d, prob_ppm, fetched_at) VALUES (?, ?, ?, ?, ?)",
    args: [source, event, d, ppm, NOW],
  });
}

/** A hash per table of everything except the shadow table (the one table the reading may write). */
export async function dumpOthers(
  db: Client,
  skip: readonly string[] = ["regime_alt_reading"],
): Promise<string> {
  const names = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows
    .map((r) => String(r.name))
    .filter((n) => !skip.includes(n));
  const h = createHash("sha256");
  for (const t of names) {
    const rs = await db.execute(`SELECT * FROM ${t}`);
    h.update(`${t}:${JSON.stringify(rs.rows.map((r) => Object.values(r).map(String)))}\n`);
  }
  return h.digest("hex");
}

/** Sets a configuration value the way the store reads it (a new config_version row). */
export async function setKey(db: Client, key: string, value: unknown): Promise<void> {
  await db.execute({
    sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, ?)",
    args: [key, JSON.stringify(value), NOW],
  });
}
