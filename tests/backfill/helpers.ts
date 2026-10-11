// Shared fixtures for the history backfill tests (M2 T9): a migrated local libSQL file, synthetic
// announcements (fake codes ZZA..ZZC, SEC-110), a synthetic ASIC file and an in-memory fake of the
// private data repo store. No network, no real data, no secrets.
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { fromJsonlGz } from "@/lib/data/backfill/rules.mjs";
import { HistoryConflict } from "@/lib/data/backfill/dataRepo.mjs";
import type { HistoryStore } from "@/lib/data/backfill/dataRepo.mjs";
import { freshDb } from "../db/helpers";

/** 17:30 Sydney (AEDT, UTC+11 from 2026-10-04) on Tuesday 2026-10-13. */
export const NOW = Date.parse("2026-10-13T06:30:00.000Z");
export const SHA = "a".repeat(40);

export const backfillDb = (): Promise<Client> => freshDb("main");

/** A UTC instant of `hh:mm` Sydney time on a date between 2020 and 2026 (AEST +10 / AEDT +11). */
export function sydneyIso(date: string, hhmm = "10:30"): string {
  const [h, m] = hhmm.split(":").map(Number);
  // Offset by the real rule: DST from the first Sunday of October to the first Sunday of April.
  for (const off of [11, 10]) {
    const t =
      Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`) -
      off * 3_600_000;
    const sydney = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(t))
      .replace(",", "");
    if (sydney === `${date} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`) {
      return new Date(t).toISOString();
    }
  }
  throw new Error("no such local time");
}

export const annId = (n: number | string) =>
  createHash("sha256").update(`synthetic-${n}`).digest("hex").slice(0, 32);

export type Item = {
  code: string;
  annId: string;
  publishedAt: string;
  type: string;
  priceSensitive: boolean;
  title: string;
  pdfUrl: string | null;
};

export function item(date: string, n: number, over: Partial<Item> = {}): Item {
  return {
    code: ["ZZA", "ZZB", "ZZC"][n % 3],
    annId: annId(`${date}-${n}`),
    publishedAt: sydneyIso(
      date,
      `${String(9 + (n % 8)).padStart(2, "0")}:${String(10 + (n % 40)).padStart(2, "0")}`,
    ),
    type: "Synthetic notice",
    priceSensitive: n % 2 === 0,
    title: `Synthetic announcement ${n}`,
    pdfUrl: `https://example.invalid/pdf/${n}.pdf`,
    ...over,
  };
}

export const items = (date: string, n: number): Item[] =>
  Array.from({ length: n }, (_, i) => item(date, i));

export async function count(db: Client, table: string, where = "1=1"): Promise<number> {
  return Number((await db.execute(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)).rows[0].c);
}

export async function runs(db: Client, job = "backfill-history") {
  const r = await db.execute({
    sql: "SELECT * FROM run_record WHERE job = ? ORDER BY id",
    args: [job],
  });
  return r.rows.map((x) => ({ ...x }) as Record<string, unknown>);
}

export async function jobRow(db: Client, name: string) {
  const r = await db.execute({ sql: "SELECT * FROM backfill_job WHERE name = ?", args: [name] });
  return { ...r.rows[0] } as Record<string, unknown>;
}

export async function stateOf(db: Client, name: string) {
  const r = await db.execute({
    sql: "SELECT cursor_json FROM ingest_cursor WHERE job = ?",
    args: [`backfill:${name}`],
  });
  return r.rows.length ? JSON.parse(String(r.rows[0].cursor_json)) : null;
}

/** Add `rows` counted writes of the batch 1 job in the quota month of `iso` (decision 13 counter). */
export async function addBatch1Usage(db: Client, rows: number, iso = new Date(NOW).toISOString()) {
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status, rows_written)
          VALUES ('ingest-batch1', 'AU', ?, ?, 'success', ?)`,
    args: [`batch1:AU:${iso}`, iso, rows],
  });
}

/** Wraps a client so the next `batch` call fails BEFORE it reaches the database (a killed run). */
export function killOnBatch(
  db: Client,
  { after = false } = {},
): { db: Client; armed: { on: boolean } } {
  const armed = { on: true };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "batch") {
        return async (...args: Parameters<Client["batch"]>) => {
          if (!armed.on) return target.batch(...args);
          armed.on = false;
          if (after) {
            await target.batch(...args); // committed, then the process dies before it can report
          }
          throw new Error("killed");
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy as Client, armed };
}

/** In-memory stand-in for the private data repo: write-once files, SHA-skip, conflict. */
export function fakeStore(preset: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(preset));
  const calls: string[] = [];
  const store: HistoryStore & { files: typeof files; calls: string[] } = {
    files,
    calls,
    async put(loc, bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      calls.push(`${loc.tag}/${loc.asset}`);
      const key = `${loc.tag}/${loc.asset}`;
      const have = files.get(key);
      if (have) {
        const same = createHash("sha256").update(have).digest("hex") === sha256;
        if (same) return { result: "skipped", sha256 };
        throw new HistoryConflict(loc.asset);
      }
      files.set(key, bytes);
      return { result: "uploaded", sha256 };
    },
  };
  return store;
}

/** A synthetic ASIC daily file (invented codes and numbers). */
export function asicCsv(
  rows: [string, number, number][] = [
    ["ZZA", 1000, 100000],
    ["ZZB", 50, 5000],
  ],
) {
  const head =
    "Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions";
  return [
    head,
    ...rows.map(([c, s, t]) => `Synthetic ${c} Ltd,${c},${s},${t},${((s / t) * 100).toFixed(2)}`),
  ].join("\r\n");
}

/** A row of a history file as the tests read it. */
export type Row = {
  published_at: string;
  as_of: string;
  ann_id: string;
  code: string;
  short_positions: number;
  title: string;
  source: string;
  assumed_time: boolean;
};
export const rowsOf = (bytes: Uint8Array): Row[] => fromJsonlGz(bytes) as unknown as Row[];
