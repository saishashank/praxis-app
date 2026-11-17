// CXA-010 monitor 6 (M23 task M2; D-1620, D-1701): the lens-disagreement record. One row says which option was chosen (a
// candidate whose evidence disagrees by more than `cortex_disagreement_max` is not taken: gate G10) and why, in words,
// with the quarter's count of candidates and nights stopped by it. The revisit alarm "Revisit the disagreement rule" fires
// once: on the first night a live-tested statement exists (its own row, period `cal-lens-revisit`). The quarterly record
// row follows on the next night. Reads only; changes no rule.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { DEFAULT_DISAGREEMENT_MAX } from "../score/disagreement";
import {
  addDays,
  previousQuarter,
  quarterRange,
  type MonitorDef,
  type MonitorResult,
} from "./store";

/** The one-off row that carries the revisit alarm. */
export const REVISIT_PERIOD = "cal-lens-revisit";
/** The Owner line (plain words). */
export const REVISIT_TEXT =
  "Revisit the disagreement rule: the first live-tested statement now exists";
/** The recorded option and its reason, in words (D-1620). */
export const LENS_OPTION = "abstain when the evidence disagrees by more than the set share";
export const LENS_REASON =
  "a candidate whose independent evidence points both ways is not taken, because a mixed picture is not a tested edge";

export type LensFacts = {
  /** The disagreement share above which a candidate is not taken. */
  readonly max: number;
  /** Candidates stopped by the rule in the quarter (distinct day and code). */
  readonly vetoed: number;
  /** Nights a book stood aside because of the rule in the quarter. */
  readonly abstainNights: number;
};

/** Monitor 6 from plain facts; `revisit` is true on the one-off row. */
export function lensMonitor(f: LensFacts, revisit: boolean): MonitorResult {
  return {
    value: {
      option: LENS_OPTION,
      reason: LENS_REASON,
      disagreement_max: f.max,
      g10_vetoed: f.vetoed,
      g10_abstain_nights: f.abstainNights,
      revisit,
    },
    alarm: revisit,
    ownerItems: revisit ? [REVISIT_TEXT] : [],
  };
}

/** The share read from the configuration store; the typed default when the key cannot be read. */
export async function disagreementMax(db: Pick<Client, "execute">): Promise<number> {
  try {
    const v = await getConfig(db, "cortex_disagreement_max" as ConfigKey);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {
    // unreadable: the typed default below
  }
  return DEFAULT_DISAGREEMENT_MAX;
}

/** Has a live-tested statement been written by the end of night `d`? */
async function liveTestedExists(db: Client, market: string, d: string): Promise<boolean> {
  // rows-ok: one existence probe of cortex_statement (a statement a quarter at most); at most one row
  const r = await db.execute({
    sql: "SELECT 1 AS x FROM cortex_statement WHERE market = ? AND kind = 'live_tested' AND created_at < ? LIMIT 1",
    args: [market, `${addDays(d, 1)}T00:00:00`],
  });
  return r.rows.length > 0;
}

async function revisitWritten(db: Client, market: string): Promise<boolean> {
  // rows-ok: one primary-key probe of residual_monitor; at most one row
  const r = await db.execute({
    sql: "SELECT 1 AS x FROM residual_monitor WHERE market = ? AND monitor = 6 AND period = ?",
    args: [market, REVISIT_PERIOD],
  });
  return r.rows.length > 0;
}

async function loadFacts(db: Client, market: string, quarter: string): Promise<LensFacts> {
  const max = await disagreementMax(db);
  const { from, to } = quarterRange(quarter);
  // rows-ok: one count of the quarter's G10 vetoes (idx_cortex_decision_family); one row
  const v = await db.execute({
    sql: `SELECT COUNT(DISTINCT d || '|' || code) AS n FROM cortex_decision
          WHERE market = ? AND d >= ? AND d <= ? AND first_fail_gate = 'G10_disagreement'`,
    args: [market, from, to],
  });
  // rows-ok: one count of the quarter's nights a book abstained on G10 (primary key prefix); one row
  const a = await db.execute({
    sql: `SELECT COUNT(DISTINCT d) AS n FROM cortex_abstain
          WHERE market = ? AND d >= ? AND d <= ? AND gate_id = 'G10_disagreement'`,
    args: [market, from, to],
  });
  return { max, vetoed: Number(v.rows[0]!.n), abstainNights: Number(a.rows[0]!.n) };
}

export const lensDef: MonitorDef = {
  monitor: 6,
  async period(db, market, d) {
    if ((await liveTestedExists(db, market, d)) && !(await revisitWritten(db, market))) {
      return REVISIT_PERIOD;
    }
    return previousQuarter(d);
  },
  async compute(db, market, period) {
    if (period === REVISIT_PERIOD) {
      // the one-off row carries the record and the alarm; the quarter's counts are in the quarterly row
      return lensMonitor({ max: await disagreementMax(db), vetoed: 0, abstainNights: 0 }, true);
    }
    return lensMonitor(await loadFacts(db, market, period), false);
  },
};
