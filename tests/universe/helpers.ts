// Shared synthetic data for the universe import tests (M2 T11). Synthetic ZZ* codes and invented
// names only (SEC-110): no real company name or code appears in this repository.
import type { Client } from "@libsql/client";
import { freshDb } from "../db/helpers";

export const HEADER = "Company name,ASX code,GICS industry group";
export const PREAMBLE = "Synthetic listed companies as at Mon Oct 12 07:30:00 2026";

export type Co = { code: string; name?: string; industry?: string };

const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** A CSV with the preamble (default), the header and one row per company. */
export function csvOf(list: Co[], o: { preamble?: boolean; eol?: string } = {}): string {
  const eol = o.eol ?? "\n";
  const lines = [];
  if (o.preamble !== false) lines.push(PREAMBLE, "");
  lines.push(HEADER);
  for (const c of list) {
    lines.push(
      [q(c.name ?? `Synthetic ${c.code} Ltd`), c.code, q(c.industry ?? "Materials")].join(","),
    );
  }
  return lines.join(eol) + eol;
}

/** `n` synthetic codes ZZ00, ZZ01, ... (valid 4-character codes). */
export const codes = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `ZZ${String(from + i).padStart(2, "0")}`);

export const cos = (n: number, from = 0): Co[] => codes(n, from).map((code) => ({ code }));

export async function instruments(db: Client) {
  const r = await db.execute(
    "SELECT code, name, industry, listed_on, delisted_on, delist_reason, missing_count FROM instrument WHERE market = 'AU' ORDER BY code",
  );
  return r.rows.map((x) => ({ ...x }) as Record<string, unknown>);
}

export async function seedInstruments(db: Client, list: Co[], listedOn = "2020-01-01") {
  for (const c of list) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, listed_on, industry) VALUES ('AU', ?, ?, ?, ?)",
      args: [c.code, c.name ?? `Synthetic ${c.code} Ltd`, listedOn, c.industry ?? "Materials"],
    });
  }
}

export async function newDb(): Promise<Client> {
  return freshDb("main");
}
