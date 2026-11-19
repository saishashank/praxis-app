// Opinion meters (M22 C4; AGT-148, CTX-060, CTX-041; D-1427, D-1517, D-1518). For each opinion kind that has a forward
// meter (the steelman and the Committee) and each market: how many settled cases there are against `opinion_min_n`, and,
// once the count is met, the lift (mean net result of the cases the opinion leaned FOR minus the mean of the cases it
// leaned AGAINST, parts per million) with its one-sided 90 % lower bound, and the judge-model versions seen with each one's
// own lift. Reflections and proposed angles get no forward meter and are listed with the reason (D-1427).
// Read-only: one bounded statement per kind and nothing here writes; no decision, size, breaker, rule, pick or e-mail
// module imports this folder, and a static test keeps it so (PRD-033, AT-73: tests/security/opinionBoundary.test.ts).
import { parseJson, str, type Exec } from "@/lib/cortex/store/common";
import { parseFrozen, readVersions } from "@/lib/committee/prereg";
import { readOutcomes } from "@/lib/committee/outcomes";
import { readTrial } from "@/lib/committee/store";

export type MeterKind = "steelman" | "committee";
export const METER_KINDS: readonly MeterKind[] = ["steelman", "committee"];

/** What the Owner reads for each kind. */
export const KIND_WORDS: Record<MeterKind, string> = {
  steelman: "Bull and bear notes",
  committee: "Committee opinions",
};

export type Lean = "for" | "against" | "none";

/** One settled case: which way the opinion leaned, what happened (ppm of the cost basis) and the model behind it. */
export type Case = {
  lean: Lean;
  netPpm: number;
  /** The judge-model version; null when the stored row names none. */
  model: string | null;
};

export type Lift = {
  /** Mean net of the cases leaned for minus the mean of the cases leaned against, ppm, rounded. */
  ppm: number;
  /** One-sided 90 % lower bound of the lift, ppm, rounded down. */
  lower90Ppm: number;
  forN: number;
  againstN: number;
};

export type VersionRow = { model: string; n: number; liftPpm: number | null };

export type Conditions = {
  /** The settled count has reached `opinion_min_n`. */
  enough: boolean;
  /** The lift's 90 % lower bound is above zero. */
  liftPositive: boolean;
  /** The lift is positive in each of at least two judge-model versions, and negative in none that can be read. */
  stable: boolean;
};

export type Meter = {
  market: string;
  kind: MeterKind;
  settled: number;
  needed: number;
  /** Null until the count is met (the lift is not read before), and null when a side has fewer than two cases. */
  lift: Lift | null;
  versions: VersionRow[];
  conditions: Conditions;
  /** All three conditions hold (CTX-060). */
  earned: boolean;
  /** The read hit its row cap: the count is a floor. */
  capped: boolean;
};

/** Kinds with no forward meter, with the plain reason (D-1427). */
export const NO_METER: readonly { label: string; reason: string }[] = [
  {
    label: "Looking-back notes",
    reason: "They are written after the result is known, so there is no forward test to measure.",
  },
  {
    label: "Proposed new ideas",
    reason: "They are screened as ideas in their own right, and that screening counts them.",
  },
];

/** z of the one-sided 90 % normal bound. */
export const Z90 = 1.2815515655446004; // threshold-ok: standard normal 0.90 quantile
/** A version counts toward stability with at least this many cases, and at least `VERSION_SIDE_MIN` on each side. */
export const VERSION_MIN = 30; // threshold-ok: D-1518 smallest judge-version segment (VAL-111 uses 50 for the trial)
export const VERSION_SIDE_MIN = 5; // threshold-ok: D-1518 smallest side of a segment
/** Row cap of one read (bounded statement, no paging). */
export const READ_LIMIT = 3000; // threshold-ok: D-1518 cap of one meter read

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function variance(xs: readonly number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
}

/** Pure: lift of the cases leaned for over those leaned against; null with fewer than two on a side. */
export function liftOf(cases: readonly Case[]): Lift | null {
  const f = cases.filter((c) => c.lean === "for").map((c) => c.netPpm);
  const a = cases.filter((c) => c.lean === "against").map((c) => c.netPpm);
  if (f.length < 2 || a.length < 2) return null;
  const diff = mean(f) - mean(a);
  const se = Math.sqrt(variance(f) / f.length + variance(a) / a.length);
  return {
    ppm: Math.round(diff),
    lower90Ppm: Math.floor(diff - Z90 * se),
    forN: f.length,
    againstN: a.length,
  };
}

/** Pure: the meter of one kind from its settled cases. */
export function meterOf(
  market: string,
  kind: MeterKind,
  cases: readonly Case[],
  minN: number,
  capped = false,
): Meter {
  const settled = cases.length;
  const enough = settled >= minN;
  const lift = enough ? liftOf(cases) : null;
  const byModel = new Map<string, Case[]>();
  for (const c of cases) {
    if (c.model === null) continue;
    byModel.set(c.model, [...(byModel.get(c.model) ?? []), c]);
  }
  const versions: VersionRow[] = [...byModel.keys()].sort().map((model) => {
    const own = byModel.get(model)!;
    return { model, n: own.length, liftPpm: liftOf(own)?.ppm ?? null };
  });
  const readable = [...byModel.values()].filter(
    (own) =>
      own.length >= VERSION_MIN &&
      own.filter((c) => c.lean === "for").length >= VERSION_SIDE_MIN &&
      own.filter((c) => c.lean === "against").length >= VERSION_SIDE_MIN,
  );
  const lifts = readable.map((own) => liftOf(own)!.ppm);
  const conditions: Conditions = {
    enough,
    liftPositive: lift !== null && lift.lower90Ppm > 0,
    stable: lifts.length >= 2 && lifts.every((p) => p > 0),
  };
  return {
    market,
    kind,
    settled,
    needed: minN,
    lift,
    versions,
    conditions,
    earned: conditions.enough && conditions.liftPositive && conditions.stable,
    capped,
  };
}

// ---- readers ---------------------------------------------------------------------------------------------------

/** The steelman's lean: more bull points than bear points leans for; more bear than bull leans against. */
export function steelmanLean(value: unknown): Lean {
  const v = (value ?? {}) as { bull?: unknown; bear?: unknown };
  const bull = typeof v.bull === "number" ? v.bull : 0;
  const bear = typeof v.bear === "number" ? v.bear : 0;
  return bull > bear ? "for" : bear > bull ? "against" : "none";
}

type Read = { cases: Case[]; capped: boolean };

async function steelmanCases(db: Exec, market: string): Promise<Read> {
  // rows-ok: opinion_track primary key (market, opinion_id) scanned for one market and kind, settled rows only, LIMIT 3000; the
  // model is one correlated lookup on steelman_pack (market, d, ...) and its point rows, no paging
  const r = await db.execute({
    sql: `SELECT o.value_json AS value_json, o.outcome_json AS outcome_json,
                 (SELECT MIN(p.author_model) FROM steelman_pack k
                    JOIN steelman_point p ON p.pack_id = k.pack_id AND p.state = 'shown'
                   WHERE k.market = o.market AND k.d = o.d AND k.code = o.code) AS model
            FROM opinion_track o
           WHERE o.market = ? AND o.kind = 'steelman' AND o.settled_d IS NOT NULL
           ORDER BY o.d, o.opinion_id
           LIMIT ?`,
    args: [market, READ_LIMIT],
  });
  const cases: Case[] = [];
  for (const x of r.rows) {
    let net: unknown;
    try {
      net = (parseJson(x.outcome_json) as { netPpm?: unknown }).netPpm;
    } catch {
      continue;
    }
    // a missed pick or a legacy order has no net result: it is settled but not countable
    if (typeof net !== "number" || !Number.isFinite(net)) continue;
    let lean: Lean = "none";
    try {
      lean = steelmanLean(parseJson(x.value_json));
    } catch {
      // a value that cannot be read leans neither way
    }
    cases.push({ lean, netPpm: net, model: x.model === null ? null : str(x.model) });
  }
  return { cases, capped: r.rows.length >= READ_LIMIT };
}

/** The Committee's settled cases come from its trial's outcome reader (D-1422): nothing settles its `opinion_track` rows. */
async function committeeCases(db: Exec, market: string): Promise<Read> {
  const ref = await readTrial(db, market);
  if (ref === null) return { cases: [], capped: false };
  const v1 = (await readVersions(db, market, ref.trialId))[0];
  const frozen = v1 === undefined ? null : parseFrozen(v1.frozenJson);
  if (frozen === null) return { cases: [], capped: false };
  const out = await readOutcomes(db, {
    market,
    trialId: ref.trialId,
    horizonSessions: frozen.horizon_sessions,
  });
  return {
    cases: out.settled.map((s) => ({
      lean: s.rating === "approve" ? "for" : s.rating === "reject" ? "against" : "none",
      netPpm: s.netPpm,
      model: s.judgeModel,
    })),
    capped: false,
  };
}

/** Both meters of a market. A kind whose read fails gets an empty meter (the next night reads again). */
export async function loadMeters(db: Exec, market: string, minN: number): Promise<Meter[]> {
  const out: Meter[] = [];
  for (const kind of METER_KINDS) {
    let got: Read = { cases: [], capped: false };
    try {
      got =
        kind === "steelman" ? await steelmanCases(db, market) : await committeeCases(db, market);
    } catch {
      // empty meter
    }
    out.push(meterOf(market, kind, got.cases, minN, got.capped));
  }
  return out;
}
