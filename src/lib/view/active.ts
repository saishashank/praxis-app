// Active-set collection for masking (UX-009 "Active set = every code appearing in any record visible
// to that user for that Melbourne date"; docs/M7_design.md 2.4). The set for a date is the codes of
// that date's signals, the paper orders created or filled on it and the alerts detected on that
// Melbourne date, plus whatever codes the
// caller's own records add. Collected first, masked afterwards, so a letter does not depend on which
// page the user opened.
import type { Client } from "@libsql/client";
import { normCode } from "./mask";

const melbourne = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Melbourne calendar date (YYYY-MM-DD) of a stored UTC instant, or null if it is not an instant. */
export function melbourneDate(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(melbourne.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function add(map: Map<string, Set<string>>, d: string, code: unknown): void {
  if (typeof code !== "string" || code.trim() === "") return;
  let s = map.get(d);
  if (!s) map.set(d, (s = new Set()));
  s.add(normCode(code));
}

const DAY_MS = 86_400_000; // threshold-ok: unit conversion

/** Codes of the signals of each date in [fromD, toD], keyed by date. */
export async function signalCodesByDate(
  mainDb: Pick<Client, "execute">,
  market: string,
  fromD: string,
  toD: string,
): Promise<Map<string, Set<string>>> {
  const r = await mainDb.execute({
    sql: "SELECT DISTINCT d, code FROM signal WHERE market = ? AND d >= ? AND d <= ?",
    args: [market, fromD, toD],
  });
  const out = new Map<string, Set<string>>();
  for (const x of r.rows) add(out, String(x.d), x.code);
  return out;
}

/** Codes of the alerts detected on each Melbourne date in [fromD, toD], keyed by date. */
export async function alertCodesByDate(
  mainDb: Pick<Client, "execute">,
  market: string,
  fromD: string,
  toD: string,
): Promise<Map<string, Set<string>>> {
  // One UTC day of slack each side covers the Melbourne offset; the exact date is checked in code.
  const lo = new Date(Date.parse(`${fromD}T00:00:00Z`) - DAY_MS).toISOString();
  const hi = new Date(Date.parse(`${toD}T00:00:00Z`) + 2 * DAY_MS).toISOString(); // threshold-ok: slack
  const r = await mainDb.execute({
    sql: "SELECT code, detected_at FROM alert WHERE market = ? AND code IS NOT NULL AND detected_at >= ? AND detected_at < ?",
    args: [market, lo, hi],
  });
  const out = new Map<string, Set<string>>();
  for (const x of r.rows) {
    const d = melbourneDate(String(x.detected_at));
    if (d !== null && d >= fromD && d <= toD) add(out, d, x.code);
  }
  return out;
}

/** Codes of the paper orders created or filled on each date in [fromD, toD], keyed by date. */
export async function orderCodesByDate(
  mainDb: Pick<Client, "execute">,
  fromD: string,
  toD: string,
): Promise<Map<string, Set<string>>> {
  const r = await mainDb.execute({
    sql: `SELECT decided_d AS d, code FROM arena_order WHERE decided_d >= ? AND decided_d <= ?
          UNION
          SELECT fill_d AS d, code FROM arena_order WHERE fill_d >= ? AND fill_d <= ?`,
    args: [fromD, toD, fromD, toD],
  });
  const out = new Map<string, Set<string>>();
  for (const x of r.rows) if (x.d !== null) add(out, String(x.d), x.code);
  return out;
}

/** Union of the per-date maps. */
export function mergeActive(
  ...maps: ReadonlyArray<Map<string, Set<string>>>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of maps) for (const [d, codes] of m) for (const c of codes) add(out, d, c);
  return out;
}

/** The stored active sets of the dates in [fromD, toD]: that date's signals, orders and alerts. */
export async function activeCodesByDate(
  mainDb: Pick<Client, "execute">,
  market: string,
  fromD: string,
  toD: string,
): Promise<Map<string, Set<string>>> {
  return mergeActive(
    await signalCodesByDate(mainDb, market, fromD, toD),
    await orderCodesByDate(mainDb, fromD, toD),
    await alertCodesByDate(mainDb, market, fromD, toD),
  );
}

/** The stored active set of one Melbourne date. */
export async function activeCodesForDate(
  mainDb: Pick<Client, "execute">,
  market: string,
  d: string,
): Promise<Set<string>> {
  return (await activeCodesByDate(mainDb, market, d, d)).get(d) ?? new Set();
}
