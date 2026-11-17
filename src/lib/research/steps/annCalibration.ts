// M23 night step "annCalibration" (docs/M23_design.md, D-1613; task T2, D-1635, D-1690...D-1694): the CXA-004 trigger. Each night
// and enabled market it (1) freezes the plan once per angle lineage and for the labels through the registry gate, before any
// count is taken; (2) counts the distinct sessions that have at least one timed archive item, from the session dates alone;
// (3) writes one `research_meter` row (lineage `ann_angles`, target 252): below the floor the status is `collecting` with a
// projected date and nothing else happens, so no outcome is read and the one look stays unspent (D-1605). On the first night
// the count reaches the floor it takes one look per angle (and one for the labels, if enough announcements carry a label)
// through `takeLook`, with the pure engine of `lineages/annAngles.ts` as the compute. A look already on file is never asked
// for again. It reads the archive, the calendar and its own tables, writes only research_prereg, research_meter,
// holdout_look, research_result, holdout_look_refusal and app_log, and never throws past `runResearchNight`, which logs a
// failure and goes on. A pass writes the look and the result only; any status change goes through the Owner-run import.
import type { Client } from "@libsql/client";
import { ANNOUNCEMENT_ANGLES } from "@/lib/cortex/angles/announcementSet";
import type { ResearchNightOptions, ResearchStep } from "../night";
import {
  ANN_BLOCK_SESSIONS,
  ANN_LABEL_KEYS,
  ANN_LABELS_LINEAGE,
  ANN_METER_LINEAGE,
  ANN_PLAN_PATH,
  ANN_SESSION_FLOOR,
  annAngleLineage,
  annFamilyLook,
  developmentCount,
  keyStats,
  labelsCovered,
  labelsVerdict,
  projectDate,
  type FamilyResult,
  type KeyResult,
  type PanelReader,
} from "../lineages/annAngles";
import { preregister, takeLook, type LookComputed } from "../registry";
import { diskIo, type LedgerIo } from "./lookSync";

const MAX_HOPS = 4000; // threshold-ok: a bound on the session list read (about sixteen years of sessions)
const RATE_SESSIONS = 60; // threshold-ok: D-1623 the trailing 60-session rate
const CLOSED_AHEAD = 400; // threshold-ok: a bound on the holiday rows read for the projection
const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters

/** Reads the panel of every key for the sessions of a look (built only after the floor is met); not wired until a source exists. */
export type PanelLoader = (
  db: Client,
  market: string,
  sessions: readonly string[],
  keys: readonly string[],
) => Promise<PanelReader>;

/** Labelled and total announcements of the holdout sessions (counts only). */
export type LabelCoverage = (
  db: Client,
  market: string,
  holdoutFrom: string,
) => Promise<{ labelled: number; items: number }>;

export type AnnDeps = {
  readonly io?: LedgerIo;
  /** The source of angle values and outcomes at a look. Absent: the meter reads `met` and no look is taken (D-1692). */
  readonly panel?: PanelLoader | null;
  readonly labelCoverage?: LabelCoverage;
};

export type AnnOutcome = {
  readonly n: number;
  readonly status: "collecting" | "met" | "looked" | "blocked";
  readonly projectedD: string | null;
  readonly looked: number;
};

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

/** The distinct session dates with a timed archive item after `after` and up to `to`, oldest first (one keyed hop each). */
export async function sessionsAfter(
  db: Client,
  market: string,
  after: string,
  to: string,
): Promise<string[]> {
  const out: string[] = [];
  let cursor = after;
  for (let i = 0; i < MAX_HOPS; i += 1) {
    // rows-ok: one index seek on (market, session_d), LIMIT 1; one hop per new session
    const r = await db.execute({
      sql:
        "SELECT session_d FROM announcement_archive WHERE market = ? AND session_d > ? AND session_d <= ? " +
        "AND timing IN ('pre_open','intraday','post_close') ORDER BY session_d LIMIT 1",
      args: [market, cursor, to],
    });
    const next = r.rows[0]?.session_d;
    if (next === undefined || next === null) break;
    cursor = str(next);
    out.push(cursor);
  }
  return out;
}

export async function labelCoverageFromDb(
  db: Client,
  market: string,
  holdoutFrom: string,
): Promise<{ labelled: number; items: number }> {
  // rows-ok: one count over the holdout announcements; read once, on the night the floor is first met
  const items = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM announcement_archive WHERE market = ? AND session_d >= ?",
    args: [market, holdoutFrom],
  });
  // rows-ok: one count of the distinct labelled holdout announcements; read once, on the night the floor is first met
  const labelled = await db.execute({
    sql:
      "SELECT COUNT(*) AS n FROM announcement_archive a WHERE a.market = ? AND a.session_d >= ? " +
      "AND EXISTS (SELECT 1 FROM text_label l WHERE l.market = a.market AND l.announcement_id = a.ann_id)",
    args: [market, holdoutFrom],
  });
  return { labelled: num(labelled.rows[0]?.n ?? 0), items: num(items.rows[0]?.n ?? 0) };
}

/** The projected date at the trailing 60-session rate of the meter itself; null while there is no rate. */
async function projection(
  db: Client,
  market: string,
  d: string,
  n: number,
  target: number,
): Promise<string | null> {
  // rows-ok: the market's last 60 sessions up to the night, LIMIT 60
  const cal = await db.execute({
    sql:
      "SELECT d FROM trading_calendar WHERE market = ? AND kind IN ('session','early_close') AND d <= ? " +
      "ORDER BY d DESC LIMIT ?",
    args: [market, d, RATE_SESSIONS],
  });
  const days = cal.rows.map((r) => str(r.d));
  if (days.length < 2) return null;
  const cutoff = days[days.length - 1]!;
  // rows-ok: primary key range (market, lineage, d) descending, LIMIT 1: the meter row at or before the cutoff
  let base = await db.execute({
    sql:
      "SELECT d, n FROM research_meter WHERE market = ? AND lineage = ? AND d <= ? AND d < ? " +
      "ORDER BY d DESC LIMIT 1",
    args: [market, ANN_METER_LINEAGE, cutoff, d],
  });
  if (base.rows.length === 0) {
    // rows-ok: primary key range (market, lineage, d) ascending, LIMIT 1: the first meter row
    base = await db.execute({
      sql: "SELECT d, n FROM research_meter WHERE market = ? AND lineage = ? AND d < ? ORDER BY d LIMIT 1",
      args: [market, ANN_METER_LINEAGE, d],
    });
  }
  const b = base.rows[0];
  if (b === undefined) return null;
  const elapsed = days.filter((x) => x > str(b.d)).length;
  if (elapsed < 1) return null;
  const rate = (n - num(b.n)) / elapsed;
  // rows-ok: holiday rows after the night, LIMIT 400 (a year ahead)
  const hol = await db.execute({
    sql: "SELECT d FROM trading_calendar WHERE market = ? AND kind = 'holiday' AND d > ? ORDER BY d LIMIT ?",
    args: [market, d, CLOSED_AHEAD],
  });
  return projectDate(d, target - n, rate, new Set(hol.rows.map((r) => str(r.d))));
}

async function ownerLine(db: Client, now: string, message: string): Promise<void> {
  // rows-ok: one plain line when the one calibration is taken
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'info', ?, ?, NULL)",
    args: [now, "research", message.slice(0, LOG_MAX)],
  });
}

function computeOf(
  f: FamilyResult,
  r: KeyResult | undefined,
  stats: (
    r: KeyResult,
    f: Extract<FamilyResult, { status: "looked" }>,
  ) => Record<string, number | string | null>,
): LookComputed {
  if (f.status === "below_sample") return { status: "below_sample", reason: f.reason };
  if (r === undefined) return { status: "below_sample", reason: "the key was not read" };
  return {
    verdict: r.verdict,
    nSetups: r.holdDays,
    nBlocks: Math.floor(r.holdDays / ANN_BLOCK_SESSIONS),
    stats: stats(r, f),
  };
}

/**
 * The look of the three labels as one family (D-1693): PASS when any label is rejected, NULL when some reached a statistic, else
 * INCONCLUSIVE; aggregates only. Shared with the automatic label evaluation (M3), which takes this look later when coverage was short.
 */
export function labelsComputed(lf: FamilyResult): LookComputed {
  if (lf.status === "below_sample") return { status: "below_sample", reason: lf.reason };
  const stats: Record<string, number | string | null> = {
    sessions: lf.sessions,
    holdSessions: lf.holdSessions,
    familySize: lf.familySize,
  };
  for (const x of lf.results) {
    stats[`${x.key}_verdict`] = x.verdict;
    stats[`${x.key}_holdMeanIc`] = x.holdMean === null ? null : Math.round(x.holdMean * 1e6) / 1e6; // threshold-ok: 6 places
  }
  return {
    verdict: labelsVerdict(lf.results),
    nSetups: lf.results.reduce((s, x) => s + x.holdDays, 0),
    nBlocks: Math.floor(Math.max(0, ...lf.results.map((x) => x.holdDays)) / ANN_BLOCK_SESSIONS),
    stats,
  };
}

/** One night for one market. Exported for the tests; the step below calls it. */
export async function runAnnCalibration(
  db: Client,
  o: ResearchNightOptions,
  deps: AnnDeps = {},
): Promise<AnnOutcome> {
  const io = deps.io ?? diskIo;
  const lineages = [...ANNOUNCEMENT_ANGLES.map(annAngleLineage), ANN_LABELS_LINEAGE];

  // 1. Freeze the plan for every lineage, before any count is taken. An unreadable plan freezes nothing and takes no look.
  const planText = io.read(ANN_PLAN_PATH)?.replace(/\r\n/g, "\n") ?? null;
  const shas = new Map<string, string>();
  let planOk = planText !== null;
  if (planText !== null) {
    for (const lineage of lineages) {
      const r = await preregister(db, {
        lineage,
        market: o.market,
        item: "CXA-004",
        frozen: planText,
        now: o.now,
      });
      if (r.status === "refused") planOk = false;
      shas.set(lineage, r.sha);
    }
  }

  // 2. Count the sessions from their dates: the last meter row before tonight, then the sessions after it (D-1641).
  // rows-ok: primary key range (market, lineage, d) descending, LIMIT 1
  const prev = await db.execute({
    sql: "SELECT d, n FROM research_meter WHERE market = ? AND lineage = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [o.market, ANN_METER_LINEAGE, o.d],
  });
  const fresh = await sessionsAfter(
    db,
    o.market,
    prev.rows[0] === undefined ? "" : str(prev.rows[0].d),
    o.d,
  );
  const n = (prev.rows[0] === undefined ? 0 : num(prev.rows[0].n)) + fresh.length;

  // 3. At or above the floor, take the looks that are not on file; below it, nothing is read.
  let status: AnnOutcome["status"] = planOk ? "collecting" : "blocked";
  let looked = 0;
  if (planOk && n >= ANN_SESSION_FLOOR) {
    status = "met";
    // rows-ok: the 23 lineages of this item by primary key (json_each list), at most 23 rows
    const have = await db.execute({
      sql: "SELECT lineage FROM holdout_look WHERE market = ? AND lineage IN (SELECT value FROM json_each(?))",
      args: [o.market, JSON.stringify(lineages)],
    });
    const done = new Set(have.rows.map((r) => str(r.lineage)));
    looked = ANNOUNCEMENT_ANGLES.filter((a) => done.has(annAngleLineage(a))).length;
    const pending = lineages.filter((l) => !done.has(l));
    const anglePending = ANNOUNCEMENT_ANGLES.some((a) => !done.has(annAngleLineage(a)));
    if (anglePending && deps.panel) {
      const all = [...(await sessionsAfter(db, o.market, "", o.d))];
      const keys = [...ANNOUNCEMENT_ANGLES, ...ANN_LABEL_KEYS];
      const panel = await deps.panel(db, o.market, all, keys);
      const fam = annFamilyLook(all, ANNOUNCEMENT_ANGLES, panel);
      let taken = 0;
      for (const a of ANNOUNCEMENT_ANGLES) {
        const lineage = annAngleLineage(a);
        if (done.has(lineage)) continue;
        const r = await takeLook(db, {
          lineage,
          market: o.market,
          sha: shas.get(lineage)!,
          caller: "annCalibration",
          now: o.now,
          compute: () =>
            computeOf(
              fam,
              fam.status === "looked" ? fam.results.find((x) => x.key === a) : undefined,
              keyStats,
            ),
        });
        if (r.status === "looked") {
          looked += 1;
          taken += 1;
        }
      }
      if (pending.includes(ANN_LABELS_LINEAGE)) {
        const from = all[developmentCount(all.length)]!;
        const cov = await (deps.labelCoverage ?? labelCoverageFromDb)(db, o.market, from);
        if (labelsCovered(cov.labelled, cov.items)) {
          const lf = annFamilyLook(all, ANN_LABEL_KEYS, panel);
          const r = await takeLook(db, {
            lineage: ANN_LABELS_LINEAGE,
            market: o.market,
            sha: shas.get(ANN_LABELS_LINEAGE)!,
            caller: "annCalibration",
            now: o.now,
            compute: () => labelsComputed(lf),
          });
          if (r.status === "looked") taken += 1;
        }
      }
      if (taken > 0) {
        await ownerLine(
          db,
          o.now,
          "The check of announcement categories against outcomes reached its sample and was run once.",
        );
      }
    }
    if (looked === ANNOUNCEMENT_ANGLES.length) status = "looked";
  }

  // 4. The meter row of the night (append-only, one per lineage and day).
  const projectedD =
    status === "collecting" ? await projection(db, o.market, o.d, n, ANN_SESSION_FLOOR) : null;
  // rows-ok: one insert per market and night; a repeat is ignored
  await db.execute({
    sql:
      "INSERT INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [o.market, ANN_METER_LINEAGE, o.d, n, ANN_SESSION_FLOOR, projectedD, status, o.now],
  });
  return { n, status, projectedD, looked };
}

export const annCalibrationStep: ResearchStep = {
  name: "annCalibration",
  plain: "checking announcement categories against outcomes",
  async run(db, o) {
    await runAnnCalibration(db, o);
  },
};
