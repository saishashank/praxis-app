// DAT-251 a / DAT-252 (D-972, D-974): what the ASX fetch step learned, stored by the store step.
//   code_history          a code that answered `not_found` on 3 consecutive history runs becomes
//                         `delisted` and leaves the history fetch list; it comes back only after it was
//                         missing from the ASX file and then returns.
//   source_fetch_status   consecutive failures of the listed-companies file (the fallback counter).
// Rows-ok: a run touches at most the codes that answered not_found (tens) plus the open rows of
// code_history (< 500) and one source_fetch_status row; the history list itself is never read here.
import type { Client } from "@libsql/client";

export const LIST_SOURCE = "asx_listed_companies";
export const DELIST_AFTER_RUNS = 3; // threshold-ok: DAT-251 a, three consecutive not_found runs
export const FALLBACK_REGISTER_ROW = "wikidata_asx";
const MARKET = "AU";

export type FetchStatus = {
  companiesCause: string | null;
  notFound: string[];
  attempted: string[];
  historyRan: boolean;
  fallback: string;
};

const CAUSES = new Set(["ok", "not_found", "rate_limited", "server_error", "network", "parse"]);
const CODE = /^[A-Z0-9]{1,6}$/;

/** Reads fetch-status.json defensively: anything off becomes "nothing learned". */
export function parseFetchStatus(text: string | null): FetchStatus | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const codes = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && CODE.test(x)) : [];
    return {
      companiesCause:
        typeof j.companiesCause === "string" && CAUSES.has(j.companiesCause)
          ? j.companiesCause
          : null,
      notFound: codes(j.notFound),
      attempted: codes(j.attempted),
      historyRan: j.historyRan === true,
      fallback: typeof j.fallback === "string" ? j.fallback : "off",
    };
  } catch {
    return null;
  }
}

export type FetchState = {
  delisted: string[];
  consecutiveFailures: number;
  wikidataEnabled: boolean;
};

/** What the (secret-free) fetch step needs to know, read-only. */
export async function readFetchState(db: Client): Promise<FetchState> {
  const d = await db.execute({
    sql: `SELECT code FROM code_history WHERE market = ? AND event = 'delisted' AND closed_d IS NULL
          ORDER BY code`,
    args: [MARKET],
  });
  const s = await db.execute({
    sql: "SELECT consecutive_failures AS n FROM source_fetch_status WHERE source = ?",
    args: [LIST_SOURCE],
  });
  const r = await db.execute({
    sql: "SELECT status FROM source_register WHERE source = ?",
    args: [FALLBACK_REGISTER_ROW],
  });
  return {
    delisted: d.rows.map((x) => String(x.code)),
    consecutiveFailures: s.rows.length > 0 ? Number(s.rows[0]!.n) : 0,
    wikidataEnabled: r.rows.length > 0 && String(r.rows[0]!.status) === "enabled",
  };
}

export type ApplyResult = { delisted: string[]; reappeared: string[]; consecutiveFailures: number };

/**
 * Stores one run. `fileCodes` = the codes of the ASX (or fallback) file this run stored, or null when
 * no file arrived (then nothing about presence is concluded). `today` = the Sydney date.
 */
export async function applyFetchStatus(
  db: Client,
  status: FetchStatus,
  fileCodes: ReadonlySet<string> | null,
  today: string,
  now: string,
): Promise<ApplyResult> {
  const out: ApplyResult = { delisted: [], reappeared: [], consecutiveFailures: 0 };

  // 1. the listed-companies counter (the Wikidata fallback reads it)
  if (status.companiesCause !== null) {
    if (status.companiesCause === "ok") {
      await db.execute({
        sql: `INSERT INTO source_fetch_status (source, consecutive_failures, last_ok_at, last_cause)
              VALUES (?, 0, ?, 'ok')
              ON CONFLICT (source) DO UPDATE SET consecutive_failures = 0, last_ok_at = excluded.last_ok_at,
                last_cause = 'ok'`,
        args: [LIST_SOURCE, now],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO source_fetch_status (source, consecutive_failures, last_failed_at, last_cause)
              VALUES (?, 1, ?, ?)
              ON CONFLICT (source) DO UPDATE SET consecutive_failures = consecutive_failures + 1,
                last_failed_at = excluded.last_failed_at, last_cause = excluded.last_cause`,
        args: [LIST_SOURCE, now, status.companiesCause],
      });
    }
    const c = await db.execute({
      sql: "SELECT consecutive_failures AS n FROM source_fetch_status WHERE source = ?",
      args: [LIST_SOURCE],
    });
    out.consecutiveFailures = Number(c.rows[0]!.n);
  }

  // 2. the history run: not_found counters, resets, delisting
  if (status.historyRan) {
    const open = await db.execute({
      sql: `SELECT code, first_d, last_d, runs FROM code_history
            WHERE market = ? AND event = 'not_found' AND closed_d IS NULL`,
      args: [MARKET],
    });
    const openBy = new Map(open.rows.map((r) => [String(r.code), r]));
    const missing = new Set(status.notFound);
    for (const code of status.notFound) {
      const row = openBy.get(code);
      let runs = 1;
      if (row === undefined) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO code_history (market, code, event, first_d, last_d, runs)
                VALUES (?, ?, 'not_found', ?, ?, 1)`,
          args: [MARKET, code, today, today],
        });
      } else {
        runs = Number(row.runs) + 1;
        await db.execute({
          sql: `UPDATE code_history SET runs = ?, last_d = ?
                WHERE market = ? AND code = ? AND event = 'not_found' AND first_d = ?`,
          args: [runs, today, MARKET, code, String(row.first_d)],
        });
      }
      if (runs >= DELIST_AFTER_RUNS) {
        const dup = await db.execute({
          sql: `SELECT 1 FROM code_history WHERE market = ? AND code = ? AND event = 'delisted'
                AND closed_d IS NULL`,
          args: [MARKET, code],
        });
        if (dup.rows.length === 0) {
          await db.execute({
            sql: `INSERT OR IGNORE INTO code_history (market, code, event, first_d, last_d, runs, absent)
                  VALUES (?, ?, 'delisted', ?, ?, ?, ?)`,
            args: [
              MARKET,
              code,
              today,
              today,
              runs,
              fileCodes !== null && !fileCodes.has(code) ? 1 : 0,
            ],
          });
          out.delisted.push(code);
        }
      }
    }
    // an attempted code that answered is no longer "consecutive": its open counter closes
    for (const code of status.attempted) {
      if (!missing.has(code) && openBy.has(code)) {
        await db.execute({
          sql: `UPDATE code_history SET closed_d = ?
                WHERE market = ? AND code = ? AND event = 'not_found' AND closed_d IS NULL`,
          args: [today, MARKET, code],
        });
      }
    }
  }

  // 3. delisted rows against the file: missing marks `absent`, present after absent closes the row
  if (fileCodes !== null) {
    const dl = await db.execute({
      sql: `SELECT code, absent FROM code_history
            WHERE market = ? AND event = 'delisted' AND closed_d IS NULL`,
      args: [MARKET],
    });
    for (const r of dl.rows) {
      const code = String(r.code);
      const absent = Number(r.absent) === 1;
      if (!fileCodes.has(code)) {
        if (!absent) {
          await db.execute({
            sql: `UPDATE code_history SET absent = 1, last_d = ?
                  WHERE market = ? AND code = ? AND event = 'delisted' AND closed_d IS NULL`,
            args: [today, MARKET, code],
          });
        }
      } else if (absent) {
        await db.execute({
          sql: `UPDATE code_history SET closed_d = ?
                WHERE market = ? AND code = ? AND event = 'delisted' AND closed_d IS NULL`,
          args: [today, MARKET, code],
        });
        out.reappeared.push(code);
      }
    }
  }
  return out;
}
