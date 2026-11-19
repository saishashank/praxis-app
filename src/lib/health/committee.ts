// The Committee trial's line for System Health (M22 C2; VAL-111, UXN-289): one plain sentence on where the trial stands, from
// the stored pre-registration and result rows. Read-only; no model, nothing here can change a card, an order or a rule
// (PRD-033). The line is wired into the health page by task Z; this module only builds it.
import { getConfig } from "@/lib/config/store";
import { parseFrozen, readVersions } from "@/lib/committee/prereg";
import { readTrial, type Exec } from "@/lib/committee/store";

export type CommitteeHealth = {
  /** "attention" only when the rows cannot be read, or the trial is invalid; an off Committee is expected. */
  state: "ok" | "attention";
  status: "off" | "waiting" | "running" | "finished";
  text: string;
};

export type FinalVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "INVALID";

export type CommitteeHealthInput = {
  switchOn: boolean;
  /** Null when no trial has been pre-registered. */
  trial: null | {
    finished: boolean;
    /** The final verdict when finished, else null. */
    verdict: FinalVerdict | null;
    trialSessions: number | null;
    minSettled: number | null;
    /** From the newest interim row, null before the first. */
    nights: number | null;
    settled: number | null;
  };
};

const VERDICT_WORDS: Record<string, string> = {
  PASS: "passed",
  FAIL: "did not pass",
  INCONCLUSIVE: "ended without a clear answer",
  INVALID: "is invalid and was stopped",
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Pure: the line from what is stored. */
export function committeeHealthOf(i: CommitteeHealthInput): CommitteeHealth {
  const t = i.trial;
  if (t === null) {
    return i.switchOn
      ? { state: "ok", status: "waiting", text: "Committee: on, its trial starts tonight." }
      : { state: "ok", status: "off", text: "Committee: off, no trial yet." };
  }
  if (t.finished) {
    const word = VERDICT_WORDS[t.verdict ?? ""] ?? "has ended";
    return {
      state: t.verdict === "INVALID" ? "attention" : "ok",
      status: "finished",
      text: `Committee trial ${word}. The Committee is ${i.switchOn ? "still on, but rates nothing more" : "off"}.`,
    };
  }
  const nights =
    t.nights === null
      ? "no night rated yet"
      : `${count(t.nights, "night", "nights")}${t.trialSessions === null ? "" : ` of ${t.trialSessions}`}`;
  const settled =
    t.settled === null
      ? ""
      : `, ${t.settled}${t.minSettled === null ? "" : ` of ${t.minSettled}`} settled picks`;
  return {
    state: "ok",
    status: i.switchOn ? "running" : "off",
    text: `Committee trial ${i.switchOn ? "running" : "paused (the Committee is off)"}: ${nights}${settled} (interim, not a result).`,
  };
}

/** The line for a market; a failed read says so instead of throwing. */
export async function loadCommitteeHealth(db: Exec, market: string): Promise<CommitteeHealth> {
  try {
    const switchOn = (await getConfig(db, "committee_enabled")) === "on";
    const ref = await readTrial(db, market);
    if (ref === null) return committeeHealthOf({ switchOn, trial: null });
    const v1 = (await readVersions(db, market, ref.trialId))[0];
    const frozen = v1 === undefined ? null : parseFrozen(v1.frozenJson);
    // rows-ok: committee_trial_result primary key (trial_id, market, d, kind) prefix, the newest row, LIMIT 1
    const r = await db.execute({
      sql: `SELECT kind, verdict, stats_json FROM committee_trial_result
             WHERE trial_id = ? AND market = ? ORDER BY (kind = 'final') DESC, d DESC LIMIT 1`,
      args: [ref.trialId, market],
    });
    const row = r.rows[0];
    let nights: number | null = null;
    let settled: number | null = null;
    if (row !== undefined) {
      try {
        const s = JSON.parse(String(row.stats_json)) as Record<string, unknown>;
        nights = typeof s.nights === "number" ? s.nights : null;
        settled = typeof s.settled === "number" ? s.settled : null;
      } catch {
        // a stats text that cannot be read leaves the figures out
      }
    }
    const verdict = row !== undefined && String(row.kind) === "final" ? String(row.verdict) : null;
    return committeeHealthOf({
      switchOn,
      trial: {
        finished: ref.finished,
        verdict: verdict as FinalVerdict | null,
        trialSessions: frozen?.trial_sessions ?? null,
        minSettled: frozen?.min_settled ?? null,
        nights,
        settled,
      },
    });
  } catch {
    return {
      state: "attention",
      status: "waiting",
      text: "Committee: the trial record could not be read.",
    };
  }
}
