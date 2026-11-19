// The research night (M23 A1; D-1613, D-1645; AT-32, AT-73, PRD-033): one call from the Cortex stage after the movers step.
// A fixed, ordered list of steps, each in its own file under `steps/` and owned by one later task. The seam is fail-soft:
// a step that throws is logged in plain words and the next step still runs; nothing here can fail the night. It is skipped
// on a replay (a recorded night stays byte-identical), and only an enabled market runs. A step reads and writes research
// tables only: no arena, ranking, pick, rule, breaker, sizing, family-status or e-mail module imports this file.
import type { Client } from "@libsql/client";
import { annCalibrationStep } from "./steps/annCalibration";
import { labelEvalStep } from "./steps/labelEval";
import { lookSyncStep } from "./steps/lookSync";
import { metersStep } from "./steps/meters";
import { monitorsStep } from "./steps/monitors";
import { sectorIndexStep } from "./steps/sectorIndex";
import { shockStopsStep } from "./steps/shockStops";

export interface ResearchNightOptions {
  readonly market: string;
  /** The session date of the night being run. */
  readonly d: string;
  /** The wall-clock stamp for rows written by the steps. */
  readonly now: string;
  /** True for a replay: the whole seam is skipped. */
  readonly replay?: boolean;
}

export interface ResearchStep {
  /** The key of the step (the file name under `steps/`); never shown to the Owner. */
  readonly name: string;
  /** A plain phrase for the Owner-read log line, in the form "reading the background watches". */
  readonly plain: string;
  run(db: Client, o: ResearchNightOptions): Promise<void>;
}

/** The fixed order of the steps (D-1613): the registry import first, then the series, meters, watches and records. */
export const RESEARCH_STEPS: readonly ResearchStep[] = [
  lookSyncStep,
  sectorIndexStep,
  metersStep,
  monitorsStep,
  annCalibrationStep,
  labelEvalStep,
  shockStopsStep,
];

export interface ResearchNightResult {
  readonly status: "skipped_replay" | "skipped_market" | "ran";
  readonly ran: readonly string[];
  readonly failed: readonly string[];
}

const NONE: readonly string[] = [];

/** Runs the steps in order for one enabled market. Never throws. */
export async function runResearchNight(
  db: Client,
  o: ResearchNightOptions,
  steps: readonly ResearchStep[] = RESEARCH_STEPS,
): Promise<ResearchNightResult> {
  if (o.replay === true) return { status: "skipped_replay", ran: NONE, failed: NONE };
  try {
    // rows-ok: one primary-key probe of the market row (code); at most one row
    const m = await db.execute({
      sql: "SELECT enabled FROM market WHERE code = ?",
      args: [o.market],
    });
    if (m.rows.length !== 1 || Number(m.rows[0]!.enabled) !== 1) {
      return { status: "skipped_market", ran: NONE, failed: NONE };
    }
  } catch {
    return { status: "skipped_market", ran: NONE, failed: NONE };
  }
  const ran: string[] = [];
  const failed: string[] = [];
  for (const s of steps) {
    try {
      await s.run(db, o);
      ran.push(s.name);
    } catch {
      failed.push(s.name);
      await logFailure(db, o.now, s);
    }
  }
  return { status: "ran", ran, failed };
}

async function logFailure(db: Client, now: string, s: ResearchStep): Promise<void> {
  try {
    // rows-ok: one warning line for a research step that could not finish; at most seven a night
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
      args: [
        now,
        "research",
        `A research step could not finish tonight (${s.plain}) and was skipped.`,
      ],
    });
  } catch {
    // the log itself is shadow-grade: a failed line never fails the night
  }
}
