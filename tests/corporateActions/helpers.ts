// Shared fixtures for the corporate action tests: a migrated local libSQL file with synthetic
// ZZ* codes and bars (SEC-110). No network, no real data.
import type { Client } from "@libsql/client";
import { freshDb } from "../db/helpers";

export const D0 = "2026-10-12"; // Monday
export const D1 = "2026-10-13";
export const D2 = "2026-10-14";
export const D3 = "2026-10-15";
export const D4 = "2026-10-16";
export const D5 = "2026-10-19"; // Monday
export const D6 = "2026-10-20";

/** 18:30 Sydney (AEDT, UTC+11) on the date. */
export const nowOf = (d: string) => `${d}T07:30:00.000Z`;
export const io = () => ({ read: 0, written: 0 });

export const CODES20 = "ABCDEFGHIJKLMNOPQRST".split("").map((c) => `ZZ${c}`);

export async function caDb(
  codes: string[] = ["ZZA", "ZZB"],
  dates: string[] = [],
): Promise<Client> {
  const db = await freshDb("main");
  for (const code of codes) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, listed_on) VALUES ('AU', ?, ?, '2020-01-01')",
      args: [code, `Synthetic ${code}`],
    });
    for (const d of dates) {
      await db.execute({
        sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted)
              VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
        args: [d, code],
      });
    }
  }
  return db;
}

/** A flat bar (o = h = l = c); the volume differs by day so no bar repeats the previous one. */
export async function putBar(db: Client, code: string, d: string, c: number, volume?: number) {
  await db.execute({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'yahoo_eod', ?, ?)`,
    args: [code, d, c, c, c, c, volume ?? 1000 + Number(d.slice(8)), nowOf(d), nowOf(d)],
  });
}

export const announced = (
  code: string,
  type: string,
  ex_date: string,
  payload: unknown,
  ref = "ann-1",
) => ({ code, type, ex_date, payload, source: "announcement", ref });
export const vendor = (code: string, type: string, ex_date: string, payload: unknown) => ({
  code,
  type,
  ex_date,
  payload,
  source: "vendor",
});

type Row = Record<string, unknown>;
export const rows = async (db: Client, sql: string, args: unknown[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args: args as never })).rows.map((r) => ({ ...r }));
export const count = async (db: Client, table: string, where = "1=1") =>
  Number((await rows(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where}`))[0].n);
export const statuses = async (db: Client, actionId: number) =>
  (
    await rows(db, "SELECT status FROM corporate_action_event WHERE action_id = ? ORDER BY id", [
      actionId,
    ])
  ).map((r) => r.status);
export const factors = async (db: Client) =>
  (
    await rows(
      db,
      "SELECT corporate_action_id id, factor FROM adjustment_factor ORDER BY computed_at, corporate_action_id",
    )
  ).map((r) => [Number(r.id), Number(r.factor)]);
export const openFlags = (db: Client, check?: string) =>
  rows(
    db,
    `SELECT code, d, check_id, blocks_entries FROM data_quality_flag
     WHERE cleared_at IS NULL ${check ? "AND check_id = ?" : ""} ORDER BY d, code, check_id`,
    check ? [check] : [],
  );
