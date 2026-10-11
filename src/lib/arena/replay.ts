// Replay driver (M3 T10; ARN-102, AT-12, AT-13, TST-102). Closes every session of a date range in
// order, as the nightly batch would, against a NON-production database or file. It is the same
// code path as the live batch (`closeBooksDay`) with `replay: true`, which is the only way a
// `data_only` market may write arena tables (D-066, BLD-024).
//
// `afterClose` is the hook where a test strategy (the stand-in for batch 2b, family signals are
// M4) writes the orders for the next session after the books of `d` are closed. The same inputs
// and the same hook give byte-identical rows (ARN-102).
import type { Client } from "@libsql/client";
import { sessionsBetween } from "@/lib/data/calendar";
import type { ParamOverrides } from "./cohort";
import { closeBooksDay, loadCalendar, type CloseBooksResult } from "./closeBooks";

export type ReplayOptions = {
  readonly market: string;
  readonly from: string;
  readonly to: string;
  /** Stamps run_record / app_log only (never an engine row). */
  readonly now: () => string;
  readonly afterClose?: (d: string, result: CloseBooksResult) => Promise<void>;
  /** Stop at the first failed close (default true). */
  readonly stopOnFailure?: boolean;
  readonly masterSeed?: bigint;
  readonly restartParams?: (executionId: string) => ParamOverrides;
};

export async function replaySessions(db: Client, o: ReplayOptions): Promise<CloseBooksResult[]> {
  const calendar = await loadCalendar(db, o.market);
  const results: CloseBooksResult[] = [];
  for (const d of sessionsBetween(o.from, o.to, calendar)) {
    const result = await closeBooksDay(db, {
      market: o.market,
      d,
      replay: true,
      calendar,
      now: o.now,
      masterSeed: o.masterSeed,
      restartParams: o.restartParams,
    });
    results.push(result);
    if (result.status === "failed" && o.stopOnFailure !== false) break;
    if (o.afterClose !== undefined) await o.afterClose(d, result);
  }
  return results;
}
