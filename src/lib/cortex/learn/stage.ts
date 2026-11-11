// The learning Cortex's nightly stage (design C.1, C.7 "stage.ts"; D-923…): run right after the daily
// learning loop in the picks entry (src/lib/picks/cli.ts), reusing its World, so no bar is read twice.
// Reads (Turso free plan, C.10): the stored Cortex features of sessions D-1 and D-21 in one batch
// (about 2 x universe size, ~5,000 rows), the regime of those two evenings (2 rows) and the scorecard
// events of the prior 60 sessions (~60 rows) — under 6,000 rows a night (LRN-AT-10). Writes: about 100
// scorecard rows, one 'scorecard' event, and the night's words into daily_learning.body_json.cortex.
// Insert-or-ignore everywhere: a re-run of a night writes nothing new and returns the same words.
// Nothing here changes a Cortex weight, map, passport or family status (observation tier, B.2).
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import { addDays, isTradingDay, previousTradingDay, sessionsBetween } from "@/lib/data/calendar";
import type { MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import { DEFAULT_MOVERS_PARAMS } from "../moversParams";
import { inResultsWindow } from "../gates/resultsSeason";
import type { BatchExec } from "../store/common";
import { HIST_BINS, moverCoverage, scorecardNight, type Histogram } from "./scorecard";
import { eventsSince, featureNights, insertAngleDays, logEvent } from "./store";
import { eventWords, NO_WEIGHT_CHANGED, scorecardWords, type CortexLearnSection } from "./words";
import type { LearnConfig } from "./config";
import { loadLearnConfig } from "./configStore";
import { CORTEX_LEARN_HOOKS, HOOK_SEQ_BASE, type CortexLearnHooks } from "./hooks";
import { learnerNight } from "./nightLearner";

/** Sessions back to the 20-session feature evening (D-21) and the prior-60 reference window. */
export const BACK20_SESSIONS = 21; // threshold-ok: design C.6 feature night of the 20-session leg
export const PRIOR_SESSIONS = 60; // threshold-ok: learn_window_sessions default (C.9), PSI reference
const CALENDAR_SPAN = 2; // threshold-ok: calendar days per session searched back (weekends, holidays)
/** The 'scorecard' event's seq of a night (other kinds take later seqs). */
export const SCORECARD_SEQ = 0;

export type CortexLearnOpts = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** The daily learning's World of night d (bars of the liquid shares up to d). */
  readonly world: World;
  /** The night's explained movers (daily learning). */
  readonly movers: readonly MoverExplanation[];
  /** created_at of the event; never part of a statistic. */
  readonly now: string;
  /** The decision cut-off HH:MM of the night (map as-of, D-924); default the agent parameter. */
  readonly cutoffHhmm?: string;
  /** The C.9 levels (default: the configuration store, loadLearnConfig). */
  readonly config?: LearnConfig;
  /** The probe / base plug-ins (default CORTEX_LEARN_HOOKS). */
  readonly hooks?: CortexLearnHooks;
};

/** The line the section carries when the learner part failed tonight (the scorecard still stands). */
export const LEARNER_FAILED_WORDS =
  "The learning Cortex could not compare its picks tonight; the scorecard above is complete and the comparison runs again tomorrow.";

function sessionsBack(d: string, n: number, calendar: readonly CalendarRow[]): string {
  let t = d;
  for (let i = 0; i < n; i += 1) t = previousTradingDay(t, calendar);
  return t;
}

async function regimeBefore(db: BatchExec, market: string, d: string): Promise<string> {
  // the regime the Cortex itself read for the night d (cortex/stage.ts: the latest state before d)
  const r = await db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [market, d],
  });
  return r.rows.length === 0 ? "unknown" : String(r.rows[0]!.state);
}

/** Sum of the stored D-1 histograms of the prior sessions per angle; null when none is stored. */
export function priorReference(evidence: readonly unknown[]): Map<string, Histogram> | null {
  const out = new Map<string, number[]>();
  for (const e of evidence) {
    const hist = (e as { hist?: unknown } | null)?.hist;
    if (hist === null || typeof hist !== "object") continue;
    for (const [id, h] of Object.entries(hist as Record<string, unknown>)) {
      if (!Array.isArray(h) || h.length !== HIST_BINS + 1) continue;
      const acc = out.get(id) ?? new Array<number>(HIST_BINS + 1).fill(0);
      h.forEach((v, i) => {
        acc[i] += typeof v === "number" ? v : 0;
      });
      out.set(id, acc);
    }
  }
  return out.size === 0 ? null : out;
}

/** The night's scorecard: reads, pure core, insert-or-ignore, the review section. Null off-session. */
export async function cortexLearnNight(
  db: BatchExec,
  o: CortexLearnOpts,
): Promise<CortexLearnSection | null> {
  if (!isTradingDay(o.d, o.calendar)) return null;
  const prev = previousTradingDay(o.d, o.calendar);
  const back20 = sessionsBack(o.d, BACK20_SESSIONS, o.calendar);
  const nights = await featureNights(db, o.market, [prev, back20]);
  const regimes = new Map<string, string>([
    [prev, await regimeBefore(db, o.market, prev)],
    [back20, await regimeBefore(db, o.market, back20)],
  ]);
  const window = sessionsBetween(
    addDays(prev, -PRIOR_SESSIONS * CALENDAR_SPAN),
    prev,
    o.calendar,
  ).slice(-PRIOR_SESSIONS);
  const prior = await eventsSince(db, o.market, window[0] ?? prev, prev);
  const reference = priorReference(
    prior.filter((e) => e.kind === "scorecard").map((e) => e.evidence),
  );
  const bars = new Map(
    [...o.world.shares].map(([code, s]) => [code, s.bars.map((b) => ({ d: b.d, c: b.c }))]),
  );
  const movers = o.movers.map((m) => ({ code: m.code, side: m.side, cause: m.cause }));
  const featuresPrev = nights.get(prev) ?? null;
  const card = scorecardNight({
    market: o.market,
    d: o.d,
    featuresPrev,
    featuresBack20: nights.get(back20) ?? null,
    end20: prev,
    bars,
    liquidCodes: o.world.liquidCodes,
    movers,
    regimes,
    resultsSeason: (fd) => inResultsWindow(fd, DEFAULT_MOVERS_PARAMS),
    prior60: reference,
  });
  const coverage = moverCoverage(featuresPrev, movers);
  const section = scorecardWords({
    d: o.d,
    rows: card.rows,
    coverage,
    now: new Date(`${o.d}T00:00:00.000Z`),
  });
  await insertAngleDays(db, card.rows);
  await logEvent(db, {
    market: o.market,
    d: o.d,
    seq: SCORECARD_SEQ,
    kind: "scorecard",
    evidence: {
      featureD: { 1: prev, 20: back20 }, // threshold-ok: horizons (C.6)
      rows: card.rows.length,
      hist: card.histograms,
      reference: reference === null ? "back20" : "prior60",
      numbers: section.numbers,
    },
    words: eventWords(section),
    createdAt: o.now,
  });
  // the learner's night (duel, leader, checkpoint): never fatal to the scorecard's words
  let learner: Awaited<ReturnType<typeof learnerNight>> = null;
  let learnerFailed = false;
  try {
    learner = await learnerNight(db, {
      market: o.market,
      d: o.d,
      calendar: o.calendar,
      prev,
      back20,
      regimeBack20: regimes.get(back20) ?? "unknown",
      bars,
      priorEvents: prior,
      abstainTonight: card.rows.length === 0,
      now: o.now,
      ...(o.cutoffHhmm === undefined ? {} : { cutoffHhmm: o.cutoffHhmm }),
      ...(o.config === undefined ? {} : { config: o.config }),
    });
  } catch {
    learnerFailed = true;
  }
  // the probe / base builder's nightly step (hooks.ts), after the learner; never fatal either
  const hookLines: string[] = [];
  const hooks = o.hooks ?? CORTEX_LEARN_HOOKS;
  if (hooks.probeNight !== undefined) {
    try {
      const r = await hooks.probeNight(db as Client, {
        market: o.market,
        d: o.d,
        calendar: o.calendar,
        world: o.world,
        learner: learner?.learner ?? null,
        config: learner?.config ?? o.config ?? (await loadLearnConfig(db)),
        seqBase: HOOK_SEQ_BASE,
        now: o.now,
      });
      if (r && r.lines) hookLines.push(...r.lines);
    } catch {
      // the probe step failed tonight; the scorecard and the learner stand
    }
  }
  const out: CortexLearnSection =
    learner === null && hookLines.length === 0
      ? learnerFailed
        ? { ...section, lines: [...section.lines, LEARNER_FAILED_WORDS] }
        : section
      : {
          lines: [
            ...section.lines.filter(
              (l) => !(learner?.numbers.mapRowWritten === true && l === NO_WEIGHT_CHANGED),
            ),
            ...(learner?.lines ?? []),
            ...hookLines,
          ],
          numbers: {
            ...section.numbers,
            ...(learner === null ? {} : { learner: learner.numbers }),
          },
        };
  await db.execute({
    sql: `UPDATE daily_learning SET body_json = json_set(body_json, '$.cortex', json(?))
          WHERE market = ? AND d = ?`,
    args: [JSON.stringify(out), o.market, o.d],
  });
  return out;
}
