// Shared fixtures for the Batch 1 pipeline tests: a migrated local libSQL file, a synthetic
// universe (fake codes ZZA..ZZC, SEC-110) and synthetic bars. No network, no real data.
import type { Client } from "@libsql/client";
import { freshDb } from "../db/helpers";

export const CODES = ["ZZA", "ZZB", "ZZC"];
export const FETCHED_AT = "2026-10-13T06:35:00.000Z";

/** A UTC instant at which the Sydney date (AEDT, UTC+11 from 2026-10-04) is `date` at 17:30. */
export const at1730 = (date: string): number => Date.parse(`${date}T06:30:00.000Z`);

export type BarIn = {
  code: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adj_close: number | null;
  source: string;
  published_at: null;
  fetched_at: string;
};

export function bar(code: string, date: string, over: Partial<BarIn> = {}): BarIn {
  const base = 10 + (code.charCodeAt(2) - 65);
  return {
    code,
    date,
    open: base,
    high: base + 1,
    low: base - 1,
    close: base + 0.5,
    volume: 1000,
    adj_close: base + 0.5,
    source: "yahoo",
    published_at: null,
    fetched_at: FETCHED_AT,
    ...over,
  };
}

export const barsFor = (dates: string[], codes = CODES, over: Partial<BarIn> = {}) =>
  dates.flatMap((d) => codes.map((c) => bar(c, d, over)));

export const text = (rows: unknown[]) => JSON.stringify(rows);

/** A migrated main DB with the synthetic universe and the Yahoo source accepted by the Owner. */
export async function pipelineDb(
  opts: { accepted?: boolean; codes?: string[] } = {},
): Promise<Client> {
  const db = await freshDb("main");
  if (opts.accepted !== false) {
    await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_eod'");
  }
  for (const code of opts.codes ?? CODES) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, listed_on) VALUES ('AU', ?, ?, '2020-01-01')",
      args: [code, `Synthetic ${code}`],
    });
  }
  return db;
}

export async function count(db: Client, table: string, where = "1=1"): Promise<number> {
  return Number((await db.execute(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)).rows[0].c);
}

export async function runs(db: Client) {
  const r = await db.execute("SELECT * FROM run_record ORDER BY id");
  return r.rows.map((x) => ({ ...x }) as Record<string, unknown>);
}

/** Row counts of every user table, to prove which tables a run touched. */
export async function tableCounts(db: Client): Promise<Record<string, number>> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of t.rows) out[String(r.name)] = await count(db, String(r.name));
  return out;
}
