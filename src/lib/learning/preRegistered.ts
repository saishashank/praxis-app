// Pre-registered challengers (M14, KB-081, O-46; D-233, D-234, D-235; docs/M14_design.md 2.2).
// The Owner pre-registered a fixed list of challengers (F1 x3, F3 x3, F4 x3, F6 x1). Each is a
// challenger with origin `owner` whose parameters are the family incumbent's plus the listed
// overrides; `createChallenger` charges every one as a `challenger` trial at creation (ARN-085), so
// pre-registering costs budget like any other candidate. The weekly `preregistered` stage calls
// `releasePreRegistered`, which creates the next ones in list order as `max_challengers` slots free
// up. The structural switches (enum B keys, `f1_return_window_sessions`, `director_sale`) default to
// v1 behaviour, so nothing changes until a challenger sets them.
//
// The director trade-type split (on-market vs option exercise) is BLOCKED-DATA: the stored notices
// have no trade type, so it is listed in `PRE_REGISTERED_BLOCKED` and neither built nor charged.
//
// Pure list plus one idempotent writer; no clock, no random source.
import type { Client } from "@libsql/client";
import type { LearningParams, StatsParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { createChallenger, incumbentOf, type RefusalReason } from "./challengerLifecycle";

/** What the challenger's status and first event say about its origin. */
export const PRE_REGISTERED_NOTE = "KB-081 / O-46";

type Params = Record<string, unknown>;

export type PreRegistered = {
  readonly id: string;
  readonly family: Family;
  readonly label: string;
  /** The challenger's full parameter set from the incumbent's. */
  readonly apply: (incumbent: Params) => Params;
  /** True when a stored version's parameters already carry this challenger's change. */
  readonly matches: (params: Params) => boolean;
};

const set = (key: string, value: unknown): Pick<PreRegistered, "apply" | "matches"> => ({
  apply: (inc) => ({ ...inc, [key]: value }),
  matches: (p) => JSON.stringify(p[key]) === JSON.stringify(value),
});

const weights = (p: Params): Params =>
  typeof p.insider_score_weights === "object" && p.insider_score_weights !== null
    ? (p.insider_score_weights as Params)
    : {};

/** The fixed list, in release order. */
export const PRE_REGISTERED: readonly PreRegistered[] = [
  {
    id: "KB081-F1-window252",
    family: "F1",
    label: "F1: 252-session return window for the relative-strength rank",
    ...set("f1_return_window_sessions", 252),
  },
  {
    id: "KB081-F1-skip-month-u2",
    family: "F1",
    label: "F1: skip-month momentum, U2 only",
    ...set("f1_momentum_variant", "skip_month_u2"),
  },
  {
    id: "KB081-F1-composite3",
    family: "F1",
    label: "F1: three-factor composite rank",
    ...set("f1_rank_variant", "composite3"),
  },
  {
    id: "KB081-F3-drift40",
    family: "F3",
    label: "F3: 40-session drift window",
    ...set("f3_time_exit", 40),
  },
  {
    id: "KB081-F3-drift60",
    family: "F3",
    label: "F3: 60-session drift window",
    ...set("f3_time_exit", 60),
  },
  {
    id: "KB081-F3-day0-ar",
    family: "F3",
    label: "F3: price-based surprise (AGT-137)",
    ...set("f3_surprise_mode", "day0_ar"),
  },
  {
    id: "KB081-F4-reversal5-u2",
    family: "F4",
    label: "F4: 5-session reversal on U2",
    ...set("f4_entry_variant", "reversal5_u2"),
  },
  {
    id: "KB081-F4-vol-scaled",
    family: "F4",
    label: "F4: volatility-scaled rank",
    ...set("f4_rank_variant", "vol_scaled"),
  },
  {
    // The unscaled control arm of the vol-scaled rank: the incumbent's behaviour, registered as its
    // own challenger by naming the default explicitly (so its parameter set differs from the incumbent's).
    id: "KB081-F4-control",
    family: "F4",
    label: "F4: unscaled control arm",
    ...set("f4_rank_variant", "v1"),
  },
  {
    id: "KB081-F6-director-sale-025",
    family: "F6",
    label: "F6: director sale weight 0.25 (AGT-136)",
    apply: (inc) => ({
      ...inc,
      insider_score_weights: { ...weights(inc), director_sale: 0.25 },
    }),
    matches: (p) => weights(p).director_sale === 0.25,
  },
];

/** Listed in the pre-registration but not buildable on the stored data (D-233): never created, never charged. */
export const PRE_REGISTERED_BLOCKED: readonly {
  readonly id: string;
  readonly family: Family;
  readonly label: string;
  readonly status: "BLOCKED-DATA";
  readonly reason: string;
}[] = [
  {
    id: "KB081-F6-director-trade-type-split",
    family: "F6",
    label: "F6: director trades split by trade type (on-market vs option exercise)",
    status: "BLOCKED-DATA",
    reason: "the stored insider notices carry no trade type",
  },
];

export type ReleaseSkip = {
  readonly id: string;
  readonly reason: RefusalReason | "no_incumbent_params";
};

export type ReleaseResult = {
  /** Challenger ids created now, in list order. */
  readonly created: readonly string[];
  /** Ids already registered earlier (their change is in a stored version of the family). */
  readonly alreadyRegistered: readonly string[];
  /** Ids refused now, with the reason. */
  readonly skipped: readonly ReleaseSkip[];
  /** Set when the run ended early: no free challenger slot or the lineage budget is used up. */
  readonly stoppedBy: "max_challengers" | "budget_exhausted" | null;
};

export type ReleaseInput = {
  readonly market: string;
  /** Melbourne date of the weekly run. */
  readonly d: string;
  readonly learning: Pick<LearningParams, "maxChallengers" | "challengerGeneratorPerWeek">;
  readonly stats: Pick<StatsParams, "trialBudgetPerLineage">;
  readonly budgetTotal?: number;
  /** Only these families (default all). */
  readonly families?: readonly Family[];
};

/**
 * Creates the pre-registered challengers that are not registered yet, in list order, until a
 * challenger slot or the lineage budget runs out. Idempotent: a change already carried by a stored
 * version of the family is not created again. A family without a live version or a split is skipped.
 */
export async function releasePreRegistered(
  db: Client,
  input: ReleaseInput,
): Promise<ReleaseResult> {
  const created: string[] = [];
  const already: string[] = [];
  const skipped: ReleaseSkip[] = [];
  for (const item of PRE_REGISTERED) {
    if (input.families !== undefined && !input.families.includes(item.family)) continue;
    const versions = await db.execute({
      sql: "SELECT n, params_json FROM rule_version WHERE market = ? AND family = ? ORDER BY n",
      args: [input.market, item.family],
    });
    // v1 is the seed; a later version carries the change when its parameters do
    if (
      versions.rows.some(
        (r) => Number(r.n) > 1 && item.matches(JSON.parse(String(r.params_json)) as Params),
      )
    ) {
      already.push(item.id);
      continue;
    }
    const incumbent = await incumbentOf(db, input.market, item.family);
    const row = versions.rows.find(
      (r) => incumbent !== null && `${item.family}.v${r.n}` === incumbent,
    );
    if (row === undefined) {
      skipped.push({ id: item.id, reason: "no_incumbent_params" });
      continue;
    }
    const r = await createChallenger(db, {
      market: input.market,
      family: item.family,
      origin: "owner",
      params: item.apply(JSON.parse(String(row.params_json)) as Params),
      lessonIds: [],
      d: input.d,
      actor: "A6",
      note: `${PRE_REGISTERED_NOTE}: ${item.id}`,
      learning: input.learning,
      stats: input.stats,
      ...(input.budgetTotal === undefined ? {} : { budgetTotal: input.budgetTotal }),
    });
    if (r.status === "created") {
      created.push(r.id);
      continue;
    }
    if (r.status === "exists") {
      already.push(item.id);
      continue;
    }
    if (r.reason === "max_challengers" || r.reason === "budget_exhausted") {
      return {
        created,
        alreadyRegistered: already,
        skipped: [...skipped, { id: item.id, reason: r.reason }],
        stoppedBy: r.reason,
      };
    }
    skipped.push({ id: item.id, reason: r.reason });
  }
  return { created, alreadyRegistered: already, skipped, stoppedBy: null };
}
