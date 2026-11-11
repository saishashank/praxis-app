// Row-by-market invariant (OPS-104 e, D-960; PRD-040: IN and US stay off, no data of a market that is
// switched off or unknown may exist). Run by the nightly maintenance route.
//
// The tables to look at are every table whose schema has a `market` column, read from the live database
// (sqlite_master and pragma_table_info), so a migration that adds one is covered without a list to
// maintain; tests/maintenance/rowsByMarket.test.ts asserts the derived list equals a scan of the
// migration files. The enabled set is the `market` table rows with `enabled = 1` (M19 D-994: a market that is
// not enabled holds no data, whatever its mode; migration 0035's write guard refuses such rows, so a hit here
// means the guard was bypassed or a trigger is missing). The nightly step also compares that set with the
// production setting (`PRAXIS_MARKETS_ENABLED`, key `markets_enabled`) and raises S2 `markets_enabled_mismatch`.
// No market code is written here.
//
// Turso FREE plan (PRD-045): a table whose key starts with `market` is checked with index probes that
// skip the enabled markets (rows-ok: k + 1 index seeks per table, k = enabled markets), never a scan;
// the few tables without such an index are counted with one GROUP BY scan (rows-ok: run_record about
// 20 000 rows over its 180 days, every other one under 2 000). An enabled market's own rows are not
// counted on an indexed table (price_bar alone holds more than a million): market_row_count holds a
// row for every market found by a full count and for every UNEXPECTED market found by a probe.
import type { Client } from "@libsql/client";
import { notifyIncident } from "@/lib/incidents/notify";
import { marketsEnabledDefault } from "@/lib/market/profileCore.mjs";
import { builtMarkets } from "@/lib/market/seed/index.mjs";

export const MARKET_ROWS_INCIDENT = "market_rows_unexpected";
export const MARKETS_MISMATCH_INCIDENT = "markets_enabled_mismatch";
const OWN_TABLE = "market_row_count";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DETAIL_ROWS = 20; // threshold-ok: rows named in the incident detail

/**
 * Tables whose `market` column also holds a scope that belongs to no market (D-1024): `document.market` is "common" for
 * the source register and the expert mirror. That value is not a market, so it is never counted or alarmed. The
 * guard (migration 0035, scripts/db/gen-market-guard.mjs COMMON_SCOPE) lets the same value through.
 */
export const COMMON_SCOPE: Readonly<Record<string, string>> = { document: "common" };

export type MarketTable = { table: string; indexed: boolean };
export type MarketRowCount = { tbl: string; market: string; n: number };
export type MarketRowsResult = {
  tables: number;
  /** Statements issued and rows they read (an upper bound for the run record). */
  queries: number;
  rowsRead: number;
  counts: MarketRowCount[];
  unexpected: MarketRowCount[];
};

type Q = Pick<Client, "execute">;

/** Every table with a `market` column, and whether an index (or the key) starts with it. */
export async function marketTables(db: Q): Promise<MarketTable[]> {
  const r = await db.execute(
    `SELECT m.name AS tbl,
            EXISTS (SELECT 1 FROM pragma_index_list(m.name) il
                    WHERE (SELECT name FROM pragma_index_info(il.name) WHERE seqno = 0) = 'market') AS indexed
     FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'market'
     WHERE m.type = 'table' AND m.name <> '${OWN_TABLE}' AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name`,
  );
  return r.rows
    .map((x) => ({ table: String(x.tbl), indexed: Number(x.indexed) === 1 }))
    .filter((t) => IDENT.test(t.table));
}

/** Markets that are on: a `market` row with `enabled = 1` (D-994). */
export async function enabledMarkets(db: Q): Promise<string[]> {
  // rows-ok: the market table holds one row per built market (3)
  const r = await db.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code");
  return r.rows.map((x) => String(x.code));
}

/** The next market after `lo` (exclusive) below `hi` (exclusive) in a table keyed by market, or null. */
async function nextMarket(db: Q, table: string, lo: string | null, hi: string | null) {
  const where: string[] = [];
  const args: string[] = [];
  if (lo !== null) {
    where.push("market > ?");
    args.push(lo);
  }
  if (hi !== null) {
    where.push("market < ?");
    args.push(hi);
  }
  const r = await db.execute({
    sql: `SELECT market FROM ${table} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY market LIMIT 1`,
    args,
  });
  return r.rows.length ? String(r.rows[0].market) : null;
}

export async function countRowsByMarket(db: Q): Promise<MarketRowsResult> {
  const enabled = await enabledMarkets(db);
  const tables = await marketTables(db);
  const known = new Set(enabled);
  const out: MarketRowsResult = {
    tables: tables.length,
    queries: 2,
    rowsRead: enabled.length + tables.length,
    counts: [],
    unexpected: [],
  };
  const sorted = [...enabled].sort();
  // the open intervals between the enabled markets: (-inf, a), (a, b), ..., (z, +inf)
  const gaps: Array<[string | null, string | null]> = [];
  let prev: string | null = null;
  for (const e of sorted) {
    gaps.push([prev, e]);
    prev = e;
  }
  gaps.push([prev, null]);

  for (const t of tables) {
    const noMarket = COMMON_SCOPE[t.table]; // a scope that belongs to no market (D-1024)
    if (t.indexed) {
      for (const [lo0, hi] of gaps) {
        let lo = lo0;
        for (;;) {
          const m = await nextMarket(db, t.table, lo, hi);
          out.queries += 1;
          out.rowsRead += 1;
          if (m === null) break;
          if (m === noMarket) {
            lo = m;
            continue;
          }
          const c = await db.execute({
            sql: `SELECT COUNT(*) AS n FROM ${t.table} WHERE market = ?`,
            args: [m],
          });
          const n = Number(c.rows[0].n);
          out.queries += 1;
          out.rowsRead += n;
          const row = { tbl: t.table, market: m, n };
          out.counts.push(row);
          out.unexpected.push(row);
          lo = m;
        }
      }
    } else {
      const r = await db.execute(
        `SELECT market, COUNT(*) AS n FROM ${t.table} WHERE market IS NOT NULL GROUP BY market`,
      );
      out.queries += 1;
      for (const x of r.rows) {
        if (String(x.market) === noMarket) continue;
        const row = { tbl: t.table, market: String(x.market), n: Number(x.n) };
        out.rowsRead += row.n;
        out.counts.push(row);
        if (!known.has(row.market)) out.unexpected.push(row);
      }
    }
  }
  return out;
}

/**
 * The nightly step: count, store the rows for `d` (a re-run of the night replaces them) and raise one
 * S2 incident when any market that is off or unknown has rows. Returns the result for the caller.
 */
export async function checkMarketRows(
  db: Client,
  d: string,
  now: Date,
  opts: { raise?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<MarketRowsResult> {
  const res = await countRowsByMarket(db);
  const stmts = [
    { sql: `DELETE FROM ${OWN_TABLE} WHERE d = ?`, args: [d] },
    ...res.counts.map((c) => ({
      sql: `INSERT INTO ${OWN_TABLE} (d, tbl, market, n) VALUES (?, ?, ?, ?)`,
      args: [d, c.tbl, c.market, c.n],
    })),
  ];
  await db.batch(stmts, "write");
  if (opts.raise !== false && res.unexpected.length > 0) {
    const markets = [...new Set(res.unexpected.map((u) => u.market))].sort();
    await notifyIncident({ db, now: () => now }, MARKET_ROWS_INCIDENT, "S2", {
      summary: `Rows exist for a market that is switched off or unknown: ${markets.join(", ")}`,
      detail: { d, rows: res.unexpected.slice(0, DETAIL_ROWS) },
      component: "Data",
      impact:
        "Data of a market that must not have any was stored; the market modes are not holding.",
      fix: "Find which job wrote it (the table names are in the incident), stop it, then remove the rows.",
      fixPath: "/health",
    });
  }
  if (opts.raise !== false) await checkEnabledSet(db, now, opts.env ?? process.env);
  return res;
}

/** S2 `markets_enabled_mismatch` when the `market.enabled` set differs from the production setting (D-994). */
export async function checkEnabledSet(
  db: Client,
  now: Date,
  env: Record<string, string | undefined>,
): Promise<{ expected: string[]; actual: string[]; mismatch: boolean }> {
  const expected = marketsEnabledDefault(env, builtMarkets());
  const actual = await enabledMarkets(db);
  const mismatch = expected.join(",") !== actual.join(",");
  if (mismatch) {
    await notifyIncident({ db, now: () => now }, MARKETS_MISMATCH_INCIDENT, "S2", {
      summary: `The markets enabled in the database (${actual.join(", ") || "none"}) differ from the production setting (${expected.join(", ")})`,
      detail: { expected, actual },
    });
  }
  return { expected, actual, mismatch };
}
