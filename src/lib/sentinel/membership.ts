// Membership sets for the Sentinel (AGT-014, AGT-015; docs/M5_design.md 2.2, D-100 draft). One
// read-only batch per ingest call; the sets are then used for every item of the call.
//
//  - tracked   = U1-U3 of the latest universe_snapshot, plus held codes
//  - held      = an open trade (exit_type NULL) of a live cohort of an E execution (E01-E12; the
//                controls C1/C2/C3 and shadow cohorts never count) in a market whose mode is
//                `full` (the "active" mode of the market table)
//  - watch     = a signal row (taken or not) in the last `watch_list_window` sessions, plus
//                unexpired, unremoved Owner-added rows
//  - candidate = watch plus a pending entry order (decision 43)
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { Membership } from "./materiality";

export type MembershipSets = {
  tracked: ReadonlySet<string>;
  held: ReadonlySet<string>;
  watch: ReadonlySet<string>;
  candidate: ReadonlySet<string>;
};

export const EMPTY_SETS: MembershipSets = {
  tracked: new Set(),
  held: new Set(),
  watch: new Set(),
  candidate: new Set(),
};

export function membershipOf(code: string, s: MembershipSets): Membership {
  const held = s.held.has(code);
  const watch = s.watch.has(code);
  return {
    held,
    watch,
    candidate: watch || s.candidate.has(code),
    tracked: held || s.tracked.has(code),
  };
}

const codes = (rows: readonly Record<string, unknown>[]): Set<string> =>
  new Set(rows.map((r) => String(r.code)));

/** `today` is the Sydney date YYYY-MM-DD. */
export async function loadMembership(
  db: Client,
  market: string,
  today: string,
): Promise<MembershipSets> {
  const raw = await getConfig(db, "watch_list_window", market);
  const window = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 20;
  const [uni, held, signals, owner, pending] = await db.batch(
    [
      {
        sql:
          "SELECT code FROM universe_snapshot WHERE market = ? AND tier IN ('U1','U2','U3') " +
          "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ?)",
        args: [market, market],
      },
      {
        sql:
          "SELECT DISTINCT t.code AS code FROM trade t " +
          "JOIN cohort c ON c.id = t.cohort_id AND c.live = 1 " +
          "JOIN execution e ON e.id = c.execution_id AND e.kind = 'E' AND e.market = ? " +
          "JOIN market m ON m.code = e.market AND m.mode = 'full' " +
          "WHERE t.exit_type IS NULL",
        args: [market],
      },
      {
        sql:
          "SELECT DISTINCT code FROM signal WHERE market = ? AND d >= " +
          "COALESCE((SELECT MIN(d) FROM (SELECT d FROM trading_calendar WHERE market = ? " +
          "AND kind IN ('session','early_close') AND d <= ? ORDER BY d DESC LIMIT ?)), ?)",
        args: [market, market, today, window, today],
      },
      {
        sql:
          "SELECT DISTINCT code FROM watch_list_owner WHERE market = ? " +
          "AND removed_at IS NULL AND expires_d >= ?",
        args: [market, today],
      },
      {
        sql:
          "SELECT DISTINCT o.code AS code FROM arena_order o " +
          "JOIN cohort c ON c.id = o.cohort_id " +
          "JOIN execution e ON e.id = c.execution_id AND e.market = ? " +
          "WHERE o.status = 'pending' AND o.kind = 'entry'",
        args: [market],
      },
    ],
    "read",
  );
  const heldSet = codes(held.rows);
  const watch = new Set([...codes(signals.rows), ...codes(owner.rows)]);
  return {
    held: heldSet,
    watch,
    candidate: new Set([...watch, ...codes(pending.rows)]),
    tracked: new Set([...codes(uni.rows), ...heldSet]),
  };
}
