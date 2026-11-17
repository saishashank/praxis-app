// Committee trial page loader (M22 C2; UXN-289, UXN-290, VAL-111; D-1420, D-1421, D-1423). The only reader that shows a
// Committee rating: the trial page under Strategies. A rating is hidden everywhere else while the trial runs (UXN-290): no
// card, pick, e-mail or review loader reads these tables (tests/acceptance/v3/at76Trial.test.ts proves it).
// What it shows: where the trial stands (status, the switch), progress against the frozen minimums, the pre-registration
// record, the latest interim figure labelled "interim, not a result", the final verdict once there is one, and the newest
// nights as tables with the debate text, the models, the skipped signals and a link to the decision card (the evidence
// pack is built from it). Every code, company name, free text and exact date goes through the masker (DAT-124, ROL-107):
// the Owner sees them; anyone else sees letters, week-only dates and no trial id. Read-only, bounded statements, no OFFSET.
import { getConfig } from "@/lib/config/store";
import { readVersions, type Frozen } from "@/lib/committee/prereg";
import { readTrial } from "@/lib/committee/store";
import { INTERIM_NOTE } from "@/lib/committee/trial";
import { loadRequested } from "@/lib/health/opinions";
import { loadMeters, NO_METER } from "@/lib/opinions/meter";
import { viewOf, type MeterView } from "@/lib/opinions/view";
import { formatDay } from "@/lib/view/format";
import { weekOnly } from "@/lib/view/mask";
import { cardHref } from "./cards";
import {
  loaded,
  num,
  openViewer,
  soft,
  str,
  type Db,
  type LoaderDeps,
  type Loaded,
  type MaskScope,
} from "./common";

export const NIGHTS_SHOWN = 20; // threshold-ok: nights per page of the trial tables
const ROWS_LIMIT = 200; // threshold-ok: NIGHTS_SHOWN x the shortlist maximum (5), with room
const CALLS_LIMIT = 800; // threshold-ok: ROWS_LIMIT x four statements
const IDS_PER_READ = 100; // threshold-ok: ids per statement
const PERCENT_POINT = 10_000; // threshold-ok: ppm per percentage point
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const RATING_WORD: Record<string, string> = {
  approve: "Approve",
  neutral: "Neutral",
  reject: "Reject",
  skipped_budget: "Skipped: out of budget",
  skipped_time: "Skipped: out of time",
  skipped_models: "Skipped: no model available",
  failed: "Could not be rated",
};
export const STAGE_WORD: Record<string, string> = {
  bull: "The case for",
  bear: "The case against",
  risk: "The risks",
  judge: "The judge's reasons",
};
export const VERDICT_WORD: Record<string, string> = {
  PASS: "Passed",
  FAIL: "Did not pass",
  INCONCLUSIVE: "Ended without a clear answer",
  INVALID: "Invalid: stopped",
};
export const REASON_WORD: Record<string, string> = {
  sessions_short: "The trial has not run its full length yet.",
  sample_short: "Not enough settled picks yet.",
  sample_never_met: "Twice the planned length passed without enough settled picks.",
  passed:
    "Approved picks beat rejected ones by more than one round trip of costs, and the gap is unlikely to be chance.",
  not_significant: "The gap between approved and rejected picks could easily be chance.",
  below_cost: "The gap is smaller than one round trip of costs.",
  reversal: "One group of picks, judged by one model, went the wrong way.",
  no_contrast: "There were no approved or no rejected picks to compare.",
  edited: "The pre-registration was changed after the trial started.",
  unreadable: "The pre-registration could not be read.",
};

export type NightRowView = {
  stock: string;
  rating: string;
  ratingWord: string;
  skipped: boolean;
  reasons: string[];
  statements: { stage: string; title: string; points: string[] }[];
  models: { bull: string | null; bear: string | null; risk: string | null; judge: string | null };
  sameFamily: boolean;
  /** The decision card the evidence pack was built from (opaque reference for a masked viewer), or null. */
  packHref: string | null;
};

export type NightView = {
  /** The stored day (the cursor of "earlier nights"); null for a masked viewer, who has no cursor. */
  d: string | null;
  dayText: string;
  rows: NightRowView[];
  allSkipped: boolean;
};

export type FigureView = { label: string; value: string };

/** The opinion meters (C4, AGT-148): counts and a gap, read-only; counts only, so nothing here is masked. */
export type OpinionMetersView = {
  meters: MeterView[];
  noMeter: { label: string; reason: string }[];
};

export type CommitteeTrialView = {
  /** "none": no trial yet; "running"; "finished". */
  status: "none" | "running" | "finished";
  statusText: string;
  switchOn: boolean;
  prereg: null | {
    /** Null for a masked viewer (the id carries the start date). */
    trialId: string | null;
    version: number;
    versions: number;
    sha: string;
    createdText: string;
    figures: FigureView[];
    statistic: string | null;
  };
  progress: null | {
    nights: number;
    trialSessions: number | null;
    settled: number;
    minSettled: number | null;
    unsettled: number;
    late: number;
  };
  /** The latest interim figure (running) or the one the final verdict was computed from. */
  figure: null | {
    interim: boolean;
    note: string | null;
    dayText: string;
    gap: string | null;
    p: string | null;
    counts: string;
    permutations: number;
    exact: boolean;
    costBar: string | null;
    reason: string;
    segments: { model: string; n: number; gap: string | null }[];
  };
  final: null | { verdict: string; verdictWord: string; dayText: string };
  /** The opinion meters (C4). */
  opinions: OpinionMetersView;
  nights: NightView[];
  /** Nights with nothing but skipped signals, over the whole trial. */
  skippedNights: number;
  /** The cursor of the next older page of nights, or null. */
  earlier: string | null;
};

const pct = (ppm: number): string => `${(ppm / PERCENT_POINT).toFixed(2)} percentage points`;
const nOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pointsOf(parsed: unknown): string[] {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { reasons?: unknown }).reasons)
      ? (parsed as { reasons: unknown[] }).reasons
      : [];
  return list
    .map((p) => (typeof p === "object" && p !== null ? (p as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

function jsonOr<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** What the page shows of a stored pre-registration: every figure that is a number, nothing that is not (a text of an older shape still shows). */
const looseFrozen = (text: string): Partial<Frozen> => {
  const v = jsonOr<Record<string, unknown>>(text, {});
  const out: Record<string, unknown> = {};
  for (const k of [
    "trial_sessions",
    "min_settled",
    "horizon_sessions",
    "permutations",
    "cost_threshold_ppm",
  ]) {
    const n = nOf(v[k]);
    if (n !== null) out[k] = n;
  }
  if (typeof v.statistic === "string") out.statistic = v.statistic;
  return out as Partial<Frozen>;
};

const frozenFigures = (f: Partial<Frozen>): FigureView[] => {
  const rows: [string, number | undefined, (n: number) => string][] = [
    ["Sessions in the trial", f.trial_sessions, String],
    ["Smallest settled sample", f.min_settled, String],
    ["Sessions a pick may take to settle", f.horizon_sessions, String],
    ["Reshuffles for the chance test", f.permutations, String],
    ["Cost bar (one round trip)", f.cost_threshold_ppm, pct],
  ];
  return rows.flatMap(([label, n, fmt]) => (n === undefined ? [] : [{ label, value: fmt(n) }]));
};

async function nightsOf(
  deps: LoaderDeps,
  v: Awaited<ReturnType<typeof openViewer>>,
  trialId: string,
  before: string | null,
): Promise<{ nights: NightView[]; earlier: string | null }> {
  const market = v.market;
  const days = await deps.mainDb.execute({
    sql: `SELECT d FROM committee_rating WHERE trial_id = ? AND market = ? AND d < ?
           GROUP BY d ORDER BY d DESC LIMIT ?`,
    args: [trialId, market, before ?? "9999-12-31", NIGHTS_SHOWN + 1], // rows-ok: committee_rating index (trial_id, d), keyset on d, LIMIT 21
  });
  const all = days.rows.map((r) => str(r.d));
  const shown = all.slice(0, NIGHTS_SHOWN);
  if (shown.length === 0) return { nights: [], earlier: null };
  const hi = shown[0]!;
  const lo = shown[shown.length - 1]!;
  const rows = await deps.mainDb.execute({
    sql: `SELECT d, signal_id, pack_id, rating, reasons_json, bull_model, bear_model, risk_model, judge_model, same_family
            FROM committee_rating WHERE trial_id = ? AND market = ? AND d >= ? AND d <= ?
           ORDER BY d DESC, signal_id LIMIT ?`,
    args: [trialId, market, lo, hi, ROWS_LIMIT], // rows-ok: committee_rating index (trial_id, d) range of at most 20 nights, LIMIT 200
  });
  const calls = await deps.mainDb.execute({
    sql: `SELECT d, signal_id, stage, parsed_json FROM committee_call
           WHERE market = ? AND d >= ? AND d <= ? ORDER BY d DESC, signal_id, stage LIMIT ?`,
    args: [market, lo, hi, CALLS_LIMIT], // rows-ok: committee_call index (market, d, signal_id, stage) range of at most 20 nights, LIMIT 800
  });
  const ids = [...new Set(rows.rows.map((r) => str(r.signal_id)))];
  const code = new Map<string, string>();
  const card = new Map<string, string>();
  for (const part of chunks(ids, IDS_PER_READ)) {
    const marks = part.map(() => "?").join(", ");
    const s = await deps.mainDb.execute({
      sql: `SELECT id, code FROM signal WHERE id IN (${marks}) LIMIT ${IDS_PER_READ}`, // rows-ok: primary key lookup of at most 100 ids
      args: part,
    });
    for (const r of s.rows) code.set(str(r.id), str(r.code));
    const c = await deps.mainDb.execute({
      sql: `SELECT signal_id, MIN(id) AS id FROM decision_card WHERE signal_id IN (${marks}) GROUP BY signal_id LIMIT ${IDS_PER_READ}`, // rows-ok: decision_card index (signal_id), at most 100 ids
      args: part,
    });
    for (const r of c.rows) card.set(str(r.signal_id), str(r.id));
  }
  const codesByDay = new Map<string, string[]>();
  for (const r of rows.rows) {
    const k = code.get(str(r.signal_id));
    if (k !== undefined) codesByDay.set(str(r.d), [...(codesByDay.get(str(r.d)) ?? []), k]);
  }
  const scopeOf: (d: string) => MaskScope = await v.masker.scopes(lo, hi, codesByDay);
  const callsOf = new Map<string, { stage: string; points: string[] }[]>();
  for (const c of calls.rows) {
    const k = `${str(c.d)}\u0000${str(c.signal_id)}`;
    callsOf.set(k, [
      ...(callsOf.get(k) ?? []),
      { stage: str(c.stage), points: pointsOf(jsonOr(c.parsed_json, null)) },
    ]);
  }
  const ORDER = ["bull", "bear", "risk", "judge"];
  const nights: NightView[] = shown.map((d) => {
    const scope = scopeOf(d);
    const own = rows.rows.filter((r) => str(r.d) === d);
    const view: NightRowView[] = own.map((r, i) => {
      const rating = str(r.rating);
      const skipped = rating.startsWith("skipped") || rating === "failed";
      const found = code.get(str(r.signal_id));
      const statements = (callsOf.get(`${d}\u0000${str(r.signal_id)}`) ?? [])
        .sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage))
        .map((c) => ({
          stage: c.stage,
          title: STAGE_WORD[c.stage] ?? c.stage,
          points: c.points.map((p) => scope.text(p)),
        }));
      const cardId = card.get(str(r.signal_id));
      const reasons = jsonOr<{ text?: unknown }[] | string[]>(r.reasons_json, [])
        .map((x) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : ""))
        .filter((t) => t !== "")
        .map((t) => scope.text(t));
      return {
        stock: found === undefined ? `Signal ${i + 1}` : scope.label(found),
        rating,
        ratingWord: RATING_WORD[rating] ?? "Not rated",
        skipped,
        reasons,
        statements,
        models: {
          bull: r.bull_model === null ? null : str(r.bull_model),
          bear: r.bear_model === null ? null : str(r.bear_model),
          risk: r.risk_model === null ? null : str(r.risk_model),
          judge: r.judge_model === null ? null : str(r.judge_model),
        },
        sameFamily: num(r.same_family) === 1,
        packHref: cardId === undefined ? null : cardHref(cardId, v.masker.masked),
      };
    });
    return {
      d: v.masker.masked ? null : d,
      dayText: v.masker.masked ? (scope.day(d) ?? "") : formatDay(d, v.now),
      rows: view,
      allSkipped: view.length > 0 && view.every((x) => x.skipped),
    };
  });
  return { nights, earlier: all.length > NIGHTS_SHOWN && !v.masker.masked ? lo : null };
}

async function skippedNightCount(db: Db, market: string, trialId: string): Promise<number> {
  // rows-ok: committee_rating index (trial_id, d), at most 252 sessions x 5 signals, one aggregate
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT d FROM committee_rating WHERE trial_id = ? AND market = ?
             GROUP BY d HAVING SUM(rating IN ('approve', 'neutral', 'reject')) = 0)`,
    args: [trialId, market],
  });
  return num(r.rows[0]?.n ?? 0);
}

/** The opinion meters of a market (C4). A failed read shows none, never an error. */
async function opinionMeters(db: Db, market: string): Promise<OpinionMetersView> {
  return soft(
    async () => {
      const minN = num(await getConfig(db, "opinion_min_n"));
      const requested = await loadRequested(db, market);
      const meters = await loadMeters(db, market, minN);
      return {
        meters: meters.map((m) => viewOf(m, requested.has(m.kind))),
        noMeter: NO_METER.map((n) => ({ ...n })),
      };
    },
    { meters: [], noMeter: NO_METER.map((n) => ({ ...n })) },
  );
}

/** The Committee trial page model. `before` is the cursor of an older page of nights (the Owner's; ignored when masked). */
export async function loadCommitteeTrial(
  deps: LoaderDeps,
  params: { before?: string | null } = {},
): Promise<Loaded<CommitteeTrialView>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const day = (d: string): string => (masked ? (weekOnly(d) ?? "") : formatDay(d, v.now));
  const switchOn = (await soft(() => getConfig(deps.mainDb, "committee_enabled"), "off")) === "on";
  const opinions = await opinionMeters(deps.mainDb, v.market);
  const empty: CommitteeTrialView = {
    status: "none",
    statusText: switchOn
      ? "The Committee is on and its trial starts tonight."
      : "No trial yet. The Committee is off.",
    switchOn,
    prereg: null,
    progress: null,
    figure: null,
    final: null,
    opinions,
    nights: [],
    skippedNights: 0,
    earlier: null,
  };
  const ref = await readTrial(deps.mainDb, v.market);
  if (ref === null) return loaded(null, v.now, masked, empty, empty.statusText);

  const versions = await readVersions(deps.mainDb, v.market, ref.trialId);
  const first = versions[0];
  const frozen = first === undefined ? null : looseFrozen(first.frozenJson);
  // rows-ok: committee_trial_result primary key (trial_id, market, d, kind) prefix, the newest interim and the final, LIMIT 2
  const res = await deps.mainDb.execute({
    sql: `SELECT d, kind, verdict, stats_json FROM committee_trial_result
           WHERE trial_id = ? AND market = ? ORDER BY (kind = 'final') DESC, d DESC LIMIT 2`,
    args: [ref.trialId, v.market],
  });
  const top = res.rows[0];
  const stats = top === undefined ? null : jsonOr<Record<string, unknown>>(top.stats_json, {});
  const isFinal = top !== undefined && str(top.kind) === "final";
  const before =
    params.before !== undefined && params.before !== null && DATE_RE.test(params.before) && !masked
      ? params.before
      : null;
  const { nights, earlier } = await nightsOf(deps, v, ref.trialId, before);
  const skippedNights = await skippedNightCount(deps.mainDb, v.market, ref.trialId);

  const verdict = isFinal ? str(top!.verdict) : null;
  const sessions = frozen?.trial_sessions ?? null;
  const nightsDone = nOf(stats?.nights) ?? 0;
  const statusText = ref.finished
    ? `The trial has ended: ${(VERDICT_WORD[verdict ?? ""] ?? "ended").toLowerCase()}.`
    : switchOn
      ? "The trial is running. Ratings stay on this page until it ends."
      : "The trial is paused because the Committee is off.";

  const view: CommitteeTrialView = {
    status: ref.finished ? "finished" : "running",
    statusText,
    switchOn,
    prereg:
      first === undefined
        ? null
        : {
            trialId: masked ? null : ref.trialId,
            version: first.version,
            versions: versions.length,
            sha: first.sha,
            createdText: day(first.createdAt.slice(0, 10)),
            figures: frozenFigures(frozen ?? {}),
            statistic: frozen?.statistic ?? null,
          },
    progress: {
      nights: nightsDone,
      trialSessions: sessions,
      settled: nOf(stats?.settled) ?? 0,
      minSettled: frozen?.min_settled ?? null,
      unsettled: nOf(stats?.unsettled) ?? 0,
      late: nOf(stats?.late_exit) ?? 0,
    },
    figure:
      top === undefined || stats === null
        ? null
        : {
            interim: !isFinal,
            note: isFinal ? null : INTERIM_NOTE,
            dayText: day(str(top.d)),
            gap: nOf(stats.d_ppm) === null ? null : pct(nOf(stats.d_ppm)!),
            p: nOf(stats.p) === null ? null : nOf(stats.p)!.toFixed(3),
            counts: `${nOf(stats.approve) ?? 0} approved, ${nOf(stats.neutral) ?? 0} neutral, ${nOf(stats.reject) ?? 0} rejected`,
            permutations: nOf(stats.permutations) ?? 0,
            exact: stats.exact === true,
            costBar:
              nOf(stats.cost_threshold_ppm) === null ? null : pct(nOf(stats.cost_threshold_ppm)!),
            reason: REASON_WORD[str(stats.reason)] ?? "",
            segments: (Array.isArray(stats.segments)
              ? (stats.segments as Record<string, unknown>[])
              : []
            ).map((s) => ({
              model: str(s.model),
              n: nOf(s.n) ?? 0,
              gap: nOf(s.d_ppm) === null ? null : pct(nOf(s.d_ppm)!),
            })),
          },
    final: isFinal
      ? {
          verdict: verdict!,
          verdictWord: VERDICT_WORD[verdict!] ?? "Ended",
          dayText: day(str(top!.d)),
        }
      : null,
    opinions,
    nights,
    skippedNights,
    earlier,
  };
  const asOf = top === undefined ? null : str(top.d);
  return loaded(asOf, v.now, masked, view, view.statusText);
}
