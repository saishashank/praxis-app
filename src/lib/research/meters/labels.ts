// The automatic label evaluation (M23 M3; CXA-008, D-1636, D-1722; hand-off from T2, D-1693). Each night and enabled market:
// (1) the plan of the three label lineages is frozen through the registry gate before anything is counted; (2) one
// `research_meter` row per label: the Owner's distinct golden items against `label_golden_min`, counted from the golden table
// alone; (3) on the night the count first reaches the floor, and on the first session of each later month while the sample
// is still short, one attempt at the label's one look through `takeLook`: the outcomes are read inside the computation, after
// the registry has checked that no look is on file, and an attempt that finds too few labelled announcements writes nothing, so
// the look stays for a later attempt (D-1605); (4) the `ann_labels` look of the announcement-calibration plan, which waited for
// label coverage, is taken here on the first session of a month once the archive is at its floor and a panel source is wired.
// It reads the golden, label, archive and bar tables, writes only research_prereg, research_meter, holdout_look, research_result,
// holdout_look_refusal and app_log, and a PASS changes no status (the sentiment cluster is entered through the passport import).
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { agreement, type AgreementResult } from "@/lib/labels/agreement";
import { goldenCount } from "@/lib/labels/golden";
import { goldenMin } from "@/lib/labels/store";
import {
  ANN_LABELS_LINEAGE,
  ANN_LABEL_KEYS,
  ANN_METER_LINEAGE,
  ANN_SESSION_FLOOR,
  annFamilyLook,
  developmentCount,
  labelsCovered,
} from "../lineages/annAngles";
import {
  LABEL_HORIZON,
  LABEL_KINDS,
  LABEL_VALUE,
  LABELS_PLAN_PATH,
  evaluateLabel,
  labelLineage,
  labelVerdict,
  type LabelKind,
  type LabelObs,
} from "../lineages/labels";
import { lineageName } from "../names";
import type { ResearchNightOptions } from "../night";
import { preregister, takeLook, type LookComputed } from "../registry";
import {
  labelCoverageFromDb,
  labelsComputed,
  sessionsAfter,
  type LabelCoverage,
  type PanelLoader,
} from "../steps/annCalibration";
import { diskIo, type LedgerIo } from "../steps/lookSync";
import {
  barsFrom,
  indexFrom,
  lookedLineages,
  num,
  previousMeter,
  sessionBack,
  str,
  writeMeter,
  type MeterStatus,
} from "./common";

const PPM = 1_000_000; // threshold-ok: parts per million
const MAX_LABELS = 20000; // threshold-ok: a bound on the machine labels read at the one look of a label
const INDEX_LEAD_DAYS = 10; // threshold-ok: calendar days before the first announcement that the index read starts
const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters

export type LabelReader = (
  db: Client,
  market: string,
  kind: LabelKind,
  d: string,
) => Promise<LabelObs[]>;

export type LabelsDeps = {
  readonly io?: LedgerIo;
  readonly reader?: LabelReader;
  readonly agreementOf?: (db: Client, market: string) => Promise<AgreementResult>;
  /** The source of label values and outcomes for the late `ann_labels` look; absent: that look is not taken (D-1692). */
  readonly panel?: PanelLoader | null;
  readonly labelCoverage?: LabelCoverage;
};

export type LabelOutcome = {
  readonly label: LabelKind;
  readonly n: number;
  readonly status: MeterStatus;
  readonly looked: boolean;
};

/** True when `d` is the first session of its month on the market's calendar. */
export async function firstSessionOfMonth(db: Client, market: string, d: string): Promise<boolean> {
  const prev = await sessionBack(db, market, d, 2);
  return prev === null ? true : prev.slice(0, 7) !== d.slice(0, 7);
}

/** The matured, labelled announcements of one kind with their outcomes (the default reader; read only inside the one look). */
export const dbLabelReader: LabelReader = async (db, market, kind, d) => {
  const cut = await sessionBack(db, market, d, LABEL_HORIZON + 1);
  if (cut === null) return [];
  // rows-ok: the newest machine label of each announcement for one kind, grouped by announcement, LIMIT 20000
  const labels = await db.execute({
    sql:
      "SELECT announcement_id, value, MAX(produced_at) AS p FROM text_label WHERE market = ? AND label_kind = ? " +
      "GROUP BY announcement_id ORDER BY announcement_id LIMIT ?",
    args: [market, kind, MAX_LABELS],
  });
  type Ev = { session: string; code: string; label: number };
  const events: Ev[] = [];
  for (const x of labels.rows) {
    const value = LABEL_VALUE[kind][str(x.value)];
    if (value === undefined) continue;
    const id = str(x.announcement_id);
    const cutAt = id.indexOf("|");
    if (cutAt < 1) continue;
    // rows-ok: one announcement by its unique (source, ann_id) key; at most one row
    const a = await db.execute({
      sql: "SELECT code, session_d FROM announcement_archive WHERE source = ? AND ann_id = ? AND market = ?",
      args: [id.slice(0, cutAt), id.slice(cutAt + 1), market],
    });
    const row = a.rows[0];
    if (row === undefined || str(row.session_d) > cut) continue;
    events.push({ session: str(row.session_d), code: str(row.code), label: value });
  }
  if (events.length === 0) return [];
  const first = events.reduce((m, e) => (e.session < m ? e.session : m), events[0]!.session);
  const idx = await indexFrom(db, market, addDays(first, -INDEX_LEAD_DAYS), d);
  const out: LabelObs[] = [];
  for (const e of events) {
    // rows-ok: one code's two latest closes up to the announcement session by primary key, LIMIT 2
    const back = await db.execute({
      sql: "SELECT d, c FROM price_bar WHERE market = ? AND code = ? AND d <= ? ORDER BY d DESC LIMIT 2",
      args: [market, e.code, e.session],
    });
    const at = back.rows[0];
    const before = back.rows[1];
    if (at === undefined || before === undefined || str(at.d) !== e.session) continue;
    const after = await barsFrom(db, market, e.code, addDays(e.session, 1), LABEL_HORIZON);
    if (after.length < LABEL_HORIZON) continue;
    const i0 = idx.get(str(before.d));
    const i1 = idx.get(e.session);
    const i2 = idx.get(after[after.length - 1]!.d);
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    const c0 = num(before.c);
    const c1 = num(at.c);
    if (!(c0 > 0) || !(c1 > 0) || !(i0.c > 0) || !(i1.c > 0)) continue;
    const ar = c1 / c0 - 1 - (i1.c / i0.c - 1);
    const outcome = after[after.length - 1]!.c / c1 - 1 - (i2.c / i1.c - 1);
    if (Number.isFinite(ar) && Number.isFinite(outcome))
      out.push({
        session: e.session,
        label: e.label,
        outcome: Math.round(outcome * PPM),
        ar: Math.round(ar * PPM),
      });
  }
  return out;
};

async function ownerLine(db: Client, now: string, message: string): Promise<void> {
  // rows-ok: one plain line when a label's one look is taken
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'info', ?, ?, NULL)",
    args: [now, "research", message.slice(0, LOG_MAX)],
  });
}

/** One night for one market: the three label meters and their looks. Exported for the tests; the step calls it. */
export async function runLabels(
  db: Client,
  o: ResearchNightOptions,
  deps: LabelsDeps = {},
): Promise<LabelOutcome[]> {
  const io = deps.io ?? diskIo;
  const reader = deps.reader ?? dbLabelReader;
  const agree = deps.agreementOf ?? ((d: Client, m: string) => agreement(d, m));

  // 1. Freeze the plan for every label, before any count is taken.
  const planText = io.read(LABELS_PLAN_PATH)?.replace(/\r\n/g, "\n") ?? null;
  const shas = new Map<string, string>();
  let planOk = planText !== null;
  if (planText !== null) {
    for (const kind of LABEL_KINDS) {
      const r = await preregister(db, {
        lineage: labelLineage(kind),
        market: o.market,
        item: "CXA-008",
        frozen: planText,
        now: o.now,
      });
      if (r.status === "refused") planOk = false;
      shas.set(labelLineage(kind), r.sha);
    }
  }
  const done = planOk
    ? await lookedLineages(db, o.market, LABEL_KINDS.map(labelLineage))
    : new Set<string>();

  // 2. The count: the Owner's distinct golden items, from the golden table alone.
  const target = await goldenMin(db);
  const n = await goldenCount(db, o.market);
  const monthly = await firstSessionOfMonth(db, o.market, o.d);

  const out: LabelOutcome[] = [];
  for (const kind of LABEL_KINDS) {
    const lineage = labelLineage(kind);
    const prev = await previousMeter(db, o.market, lineage, o.d);
    const base = { market: o.market, lineage, d: o.d, target, now: o.now };
    if (!planOk) {
      await writeMeter(db, { ...base, n, status: "blocked", projectedD: null });
      out.push({ label: kind, n, status: "blocked", looked: false });
      continue;
    }
    if (done.has(lineage)) {
      await writeMeter(db, { ...base, n, status: "looked", projectedD: null });
      out.push({ label: kind, n, status: "looked", looked: false });
      continue;
    }
    let status: MeterStatus = n >= target ? "met" : "collecting";
    let looked = false;
    // 3. At or above the floor: the first night, then the first session of each month, one attempt each.
    const firstNight = prev === null || prev.status !== "met";
    if (status === "met" && (firstNight || monthly)) {
      const r = await takeLook(db, {
        lineage,
        market: o.market,
        sha: shas.get(lineage)!,
        caller: "labelEval",
        now: o.now,
        compute: async (): Promise<LookComputed> => {
          const res = evaluateLabel(kind, await reader(db, o.market, kind, o.d));
          if (res.status === "below_sample") return { status: "below_sample", reason: res.reason };
          const ag = (await agree(db, o.market)).byLabel.find((x) => x.kind === kind);
          const clears = ag?.clears === true;
          return {
            verdict: labelVerdict(res.verdict, clears),
            nSetups: res.n,
            nBlocks: res.blocks,
            stats: {
              label: kind,
              n: res.n,
              strata: res.strata,
              sessions: res.sessions,
              horizonSessions: LABEL_HORIZON,
              meanIc: res.meanIc,
              lowerIc: res.lowerIc,
              statistic: res.verdict,
              goldenItems: n,
              agreementN: ag?.n ?? null,
              agreeShare: ag === undefined ? null : Math.round(ag.rate * 1e6) / 1e6, // threshold-ok: 6 places
              agreementLower: ag === undefined ? null : Math.round(ag.lower * 1e6) / 1e6, // threshold-ok: 6 places
              agreementClears: clears ? 1 : 0, // threshold-ok: a 0/1 flag stored with the look
            },
          };
        },
      });
      if (r.status === "looked") {
        looked = true;
        status = "looked";
        await ownerLine(
          db,
          o.now,
          `The test "${lineageName(lineage)}" reached its sample and was run once.`,
        );
      }
    }
    await writeMeter(db, { ...base, n, status });
    out.push({ label: kind, n, status, looked });
  }
  return out;
}

export type LateOutcome = "skipped" | "below_sample" | "looked";

/**
 * The one look of `ann_labels` that waited for label coverage (T2, D-1693). Taken only when: a panel source is wired, the plan
 * is frozen and no look is on file, the announcement meter is at its floor, it is the first session of a month, and at least
 * 70 % of the holdout announcements carry a label. Otherwise nothing is read beyond the meter and the plan.
 */
export async function runAnnLabelsLate(
  db: Client,
  o: ResearchNightOptions,
  deps: LabelsDeps = {},
): Promise<LateOutcome> {
  if (deps.panel === undefined || deps.panel === null) return "skipped";
  // rows-ok: research_prereg primary key (lineage, market), one row
  const plan = await db.execute({
    sql: "SELECT sha FROM research_prereg WHERE lineage = ? AND market = ?",
    args: [ANN_LABELS_LINEAGE, o.market],
  });
  if (plan.rows.length !== 1) return "skipped";
  if ((await lookedLineages(db, o.market, [ANN_LABELS_LINEAGE])).size > 0) return "skipped";
  // rows-ok: primary key range (market, lineage, d) descending, LIMIT 1: the announcement meter at or before tonight
  const meter = await db.execute({
    sql: "SELECT n FROM research_meter WHERE market = ? AND lineage = ? AND d <= ? ORDER BY d DESC LIMIT 1",
    args: [o.market, ANN_METER_LINEAGE, o.d],
  });
  if (meter.rows.length === 0 || num(meter.rows[0]!.n) < ANN_SESSION_FLOOR) return "skipped";
  if (!(await firstSessionOfMonth(db, o.market, o.d))) return "skipped";
  const sha = str(plan.rows[0]!.sha);
  let result: LateOutcome = "below_sample";
  const r = await takeLook(db, {
    lineage: ANN_LABELS_LINEAGE,
    market: o.market,
    sha,
    caller: "labelEval",
    now: o.now,
    compute: async (): Promise<LookComputed> => {
      const all = await sessionsAfter(db, o.market, "", o.d);
      if (all.length < ANN_SESSION_FLOOR)
        return { status: "below_sample", reason: "the archive is below its floor" };
      const from = all[developmentCount(all.length)]!;
      const cov = await (deps.labelCoverage ?? labelCoverageFromDb)(db, o.market, from);
      if (!labelsCovered(cov.labelled, cov.items))
        return { status: "below_sample", reason: "the labels cover too few holdout announcements" };
      const panel = await deps.panel!(db, o.market, all, ANN_LABEL_KEYS);
      return labelsComputed(annFamilyLook(all, ANN_LABEL_KEYS, panel));
    },
  });
  if (r.status === "looked") {
    result = "looked";
    await ownerLine(
      db,
      o.now,
      "The check of announcement labels against outcomes reached its sample and was run once.",
    );
  }
  return result;
}
