// Challenger lifecycle (M6 T9; KB-040..043, ARN-005, ARN-065, ARN-085; D-110 #17, #20, #47; D-111).
// Pure rules plus idempotent writers over migration 0010. Every writer respects the database
// triggers exactly (the one-way `challenger.state` edges, the append-only `challenger_event`, the
// `ready` flag and the shakedown counter reset of D-111); the tests run every edge through the real
// migration. Every threshold comes from AgentParams (`learning`, `stats`), none is typed here.
//
//   proposed -> replay -> shakedown -> review -> approved -> promoted      (rejected / retired from
//   any non-terminal state). Promotion itself is T10 (cohortWriter); this module only allows the edge.
import type { Client, Transaction } from "@libsql/client";
import { controlStates } from "@/lib/agents/controls";
import {
  FAMILY_PARAM_KEYS,
  FAMILY_SPECS,
  ruleSpecJson,
  validateRuleSpec,
} from "@/lib/agents/families/ruleSchema";
import { RULE_SCHEMA_VERSION } from "@/lib/agents/families/ruleSchema";
import type { LearningParams, StatsParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { lineageId, trialBudget, trialLedgerRow, type TrialLedgerRow } from "@/lib/stats/splits";
import { paramsJson, paramsSha } from "./ruleVersions";
import {
  CHALLENGER_EDGES,
  CHALLENGER_STATES,
  type ChallengerRow,
  type ChallengerState,
} from "./schema";

export class ChallengerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengerError";
  }
}

type Exec = Pick<Client | Transaction, "execute">;

const text = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

// ---- state machine (pure) -------------------------------------------------------------------------

/** Not yet decided: these count against `max_challengers` (proposed ... approved). */
export const ACTIVE_STATES: readonly ChallengerState[] = [
  "proposed",
  "replay",
  "shakedown",
  "review",
  "approved",
];
export const TERMINAL_STATES: readonly ChallengerState[] = ["promoted", "rejected", "retired"];

export const isChallengerState = (s: string): s is ChallengerState =>
  (CHALLENGER_STATES as readonly string[]).includes(s);

/** The KB-040 edge table, the same one the trigger and the event CHECK use (schema.ts). */
export function isAllowedEdge(from: ChallengerState, to: ChallengerState): boolean {
  return CHALLENGER_EDGES[from].includes(to);
}

export const challengerIdOf = (market: string, family: string, n: number): string =>
  `C-${market}-${family}-${n}`;

// ---- Melbourne ISO week (d is already a Melbourne date) ---------------------------------------------

const DAY_MS = 86_400_000; // threshold-ok: milliseconds per day
const DAYS_PER_WEEK_LAST = 6; // threshold-ok: Monday + 6 = Sunday

/** Monday and Sunday (YYYY-MM-DD) of the ISO week holding `d`. */
export function isoWeekBounds(d: string): { readonly start: string; readonly end: string } {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new ChallengerError(`not a date: ${d}`);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + DAYS_PER_WEEK_LAST) % (DAYS_PER_WEEK_LAST + 1);
  const start = t - sinceMonday * DAY_MS;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length);
  return { start: iso(start), end: iso(start + DAYS_PER_WEEK_LAST * DAY_MS) };
}

// ---- limits -----------------------------------------------------------------------------------------

export type Slots = { readonly used: number; readonly max: number; readonly free: boolean };

/** Challengers of a market in proposed ... approved against `max_challengers` (KB-042, ARN-005). */
export async function challengerSlots(
  db: Exec,
  market: string,
  learning: Pick<LearningParams, "maxChallengers">,
): Promise<Slots> {
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM challenger c JOIN rule_version r ON r.id = c.rule_version_id
          WHERE r.market = ? AND c.state IN ('proposed','replay','shakedown','review','approved')`,
    args: [market],
  });
  const used = num(rs.rows[0]!.n);
  return { used, max: learning.maxChallengers, free: used < learning.maxChallengers };
}

/** True when an `arena_control` row freezes the family (family or market scope `killed`, KB-043). */
export async function familyFrozen(db: Exec, market: string, family: Family): Promise<boolean> {
  const rs = await db.execute("SELECT scope, scope_key, state FROM arena_control ORDER BY id");
  const states = controlStates(
    rs.rows.map((r) => ({
      scope: text(r.scope),
      scopeKey: text(r.scope_key),
      state: text(r.state),
    })),
  );
  return states.get(`family|${family}`) === "killed" || states.get(`market|${market}`) === "killed";
}

export type PromotionCapacity = {
  readonly allowed: boolean;
  readonly reason: "cap" | "frozen" | null;
  readonly applied: number;
  readonly max: number;
};

/**
 * Whether one more promotion may be applied in the Melbourne ISO week of `d` (ARN-065: at most
 * `max_promotions_per_week` APPLIED promotions per market; force-apply and rollback do not count,
 * decision 19) and the family is not frozen (KB-043). The T10 restart step asks this per boundary.
 */
export async function promotionCapacity(
  db: Exec,
  market: string,
  family: Family,
  d: string,
  learning: Pick<LearningParams, "maxPromotionsPerWeek">,
): Promise<PromotionCapacity> {
  const { start, end } = isoWeekBounds(d);
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM promotion
          WHERE market = ? AND kind = 'promotion' AND status = 'applied'
            AND applied_d >= ? AND applied_d <= ?`,
    args: [market, start, end],
  });
  const applied = num(rs.rows[0]!.n);
  const max = learning.maxPromotionsPerWeek;
  if (await familyFrozen(db, market, family))
    return { allowed: false, reason: "frozen", applied, max };
  if (applied >= max) return { allowed: false, reason: "cap", applied, max };
  return { allowed: true, reason: null, applied, max };
}

// ---- creation (generator or Owner version) -------------------------------------------------------------

export type RefusalReason =
  | "max_challengers"
  | "family_frozen"
  | "budget_exhausted"
  | "weekly_generator_cap"
  | "invalid_params"
  | "no_change"
  | "no_incumbent"
  | "no_split"
  | "duplicate_version";

export type CreateResult =
  | { readonly status: "created"; readonly id: string; readonly ruleVersionId: string }
  | { readonly status: "exists"; readonly id: string; readonly ruleVersionId: string }
  | { readonly status: "refused"; readonly reason: RefusalReason; readonly detail: string };

export type NewChallenger = {
  readonly market: string;
  readonly family: Family;
  readonly origin: "generator" | "owner";
  /** The FULL canonical B-key set of the new version (ruleVersions.canonicalParams shape). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly lessonIds: readonly string[];
  /** Melbourne date of creation. */
  readonly d: string;
  /** `A6` or the hashed user id of the Owner. */
  readonly actor: string;
  readonly learning: Pick<LearningParams, "maxChallengers" | "challengerGeneratorPerWeek">;
  readonly stats: Pick<StatsParams, "trialBudgetPerLineage">;
  /** The rolled budget after a roll (D-078 #26); default the first-split budget m. */
  readonly budgetTotal?: number;
  /** Default: the family's incumbent (live, highest n). */
  readonly incumbentVersionId?: string;
};

/** The incumbent of a family: the version whose latest status is `live`, highest n. */
export async function incumbentOf(
  db: Exec,
  market: string,
  family: Family,
): Promise<string | null> {
  const rs = await db.execute({
    sql: `SELECT r.id AS id FROM rule_version r
          WHERE r.market = ? AND r.family = ?
            AND (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
                 ORDER BY s.seq DESC LIMIT 1) = 'live'
          ORDER BY r.n DESC LIMIT 1`,
    args: [market, family],
  });
  return rs.rows.length === 0 ? null : text(rs.rows[0]!.id);
}

/** Challengers the generator proposed for the family in the ISO week of `d`. */
export async function generatedThisWeek(
  db: Exec,
  market: string,
  family: Family,
  d: string,
): Promise<number> {
  const { start, end } = isoWeekBounds(d);
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM challenger c JOIN rule_version r ON r.id = c.rule_version_id
          WHERE r.market = ? AND r.family = ? AND c.origin = 'generator'
            AND r.registered_d >= ? AND r.registered_d <= ?`,
    args: [market, family, start, end],
  });
  return num(rs.rows[0]!.n);
}

async function loadTrials(
  db: Exec,
  lineage: string,
  splitVersion: number,
): Promise<readonly TrialLedgerRow[]> {
  const rs = await db.execute({
    sql: `SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d
          FROM trial_ledger WHERE lineage_id = ? AND split_version = ?`,
    args: [lineage, splitVersion],
  });
  return rs.rows.map((r) => ({
    id: text(r.id),
    market: text(r.market),
    lineage_id: text(r.lineage_id),
    split_version: num(r.split_version),
    kind: text(r.kind) as TrialLedgerRow["kind"],
    rule_version: r.rule_version === null ? null : text(r.rule_version),
    variant: r.variant === null ? null : text(r.variant),
    run_id: r.run_id === null ? null : text(r.run_id),
    d: text(r.d),
  }));
}

/** Highest split version of the lineage, or null when it has none. */
export async function latestSplitVersion(db: Exec, lineage: string): Promise<number | null> {
  const rs = await db.execute({
    sql: "SELECT MAX(version) AS v FROM lineage_split WHERE lineage_id = ?",
    args: [lineage],
  });
  const v = rs.rows[0]?.v;
  return v === null || v === undefined ? null : num(v);
}

export type LineageBudget = {
  readonly splitVersion: number;
  readonly budget: ReturnType<typeof trialBudget>;
};

/** The lineage's trial budget on its latest split (ARN-085: every trial kind counts), or null without a split. */
export async function lineageTrialBudget(
  db: Exec,
  market: string,
  family: Family,
  total: number,
): Promise<LineageBudget | null> {
  const lineage = lineageId(market, family);
  const splitVersion = await latestSplitVersion(db, lineage);
  if (splitVersion === null) return null;
  return {
    splitVersion,
    budget: trialBudget(await loadTrials(db, lineage, splitVersion), lineage, splitVersion, total),
  };
}

/**
 * Creates a challenger: the new `rule_version` (origin challenger / owner, parent = incumbent), its
 * `registered` status, the `challenger` trial_ledger row (ARN-085, written at creation), the
 * `challenger` row (proposed) and the first event (NULL -> proposed), in ONE transaction. A second
 * call with the same parameters returns the existing challenger and charges nothing. Refusals are
 * values: 8 concurrent (KB-042), a frozen family (generator only, KB-043), an exhausted lineage
 * budget (ARN-085), the per-week generator cap, parameters outside their bounds or unchanged.
 */
export async function createChallenger(db: Client, input: NewChallenger): Promise<CreateResult> {
  const { market, family } = input;
  const refuse = (reason: RefusalReason, detail: string): CreateResult => ({
    status: "refused",
    reason,
    detail,
  });
  // the FULL canonical key set, nothing more and nothing less (the loader checks values, not the key set)
  const want = [...FAMILY_PARAM_KEYS[family]].sort().join(",");
  const got = Object.keys(input.params).sort().join(",");
  const problems =
    want === got
      ? validateRuleSpec(FAMILY_SPECS[family], input.params)
      : [`params must be exactly the ${family} Lane-B keys`];
  if (problems.length > 0) return refuse("invalid_params", problems.join("; "));
  const sha = paramsSha(input.params);

  const tx = await db.transaction("write");
  try {
    const incumbent = input.incumbentVersionId ?? (await incumbentOf(tx, market, family));
    if (incumbent === null) {
      await tx.rollback();
      return refuse("no_incumbent", `no live version of ${family}`);
    }
    const inc = await tx.execute({
      sql: "SELECT params_json FROM rule_version WHERE id = ? AND market = ? AND family = ?",
      args: [incumbent, market, family],
    });
    if (inc.rows.length === 0) {
      await tx.rollback();
      return refuse("no_incumbent", `${incumbent} is not a ${family} version of ${market}`);
    }

    if (paramsSha(JSON.parse(text(inc.rows[0]!.params_json)) as Record<string, unknown>) === sha) {
      await tx.rollback();
      return refuse("no_change", "the parameters equal the incumbent's");
    }
    // idempotent: the same parameter set already registered as a challenger of this family
    const dup = await tx.execute({
      sql: `SELECT r.id AS rid, c.id AS cid FROM rule_version r
            LEFT JOIN challenger c ON c.rule_version_id = r.id
            WHERE r.market = ? AND r.family = ? AND r.params_sha = ?`,
      args: [market, family, sha],
    });
    if (dup.rows.length > 0) {
      const row = dup.rows[0]!;
      await tx.rollback();
      if (row.cid === null) {
        return refuse("duplicate_version", `${text(row.rid)} already has these parameters`);
      }
      return { status: "exists", id: text(row.cid), ruleVersionId: text(row.rid) };
    }

    if (input.origin === "generator") {
      if (await familyFrozen(tx, market, family)) {
        await tx.rollback();
        return refuse("family_frozen", `${family} has a killed arena_control row`);
      }
      if (
        (await generatedThisWeek(tx, market, family, input.d)) >=
        input.learning.challengerGeneratorPerWeek
      ) {
        await tx.rollback();
        return refuse(
          "weekly_generator_cap",
          `the generator already proposed for ${family} this week`,
        );
      }
    }
    const slots = await challengerSlots(tx, market, input.learning);
    if (!slots.free) {
      await tx.rollback();
      return refuse("max_challengers", `${slots.used} of ${slots.max} slots used`);
    }
    const lineage = lineageId(market, family);
    const splitVersion = await latestSplitVersion(tx, lineage);
    if (splitVersion === null) {
      await tx.rollback();
      return refuse("no_split", `${lineage} has no lineage_split`);
    }
    const budget = trialBudget(
      await loadTrials(tx, lineage, splitVersion),
      lineage,
      splitVersion,
      input.budgetTotal ?? input.stats.trialBudgetPerLineage,
    );
    if (budget.exhausted) {
      await tx.rollback();
      return refuse("budget_exhausted", `${budget.used} of ${budget.total} trials used`);
    }

    const nRs = await tx.execute({
      sql: "SELECT COALESCE(MAX(n), 0) AS n FROM rule_version WHERE market = ? AND family = ?",
      args: [market, family],
    });
    const n = num(nRs.rows[0]!.n) + 1;
    const ruleVersionId = `${family}.v${n}`;
    const id = challengerIdOf(market, family, n);
    const trial = trialLedgerRow({
      market,
      lineage_id: lineage,
      split_version: splitVersion,
      kind: "challenger",
      rule_version: ruleVersionId,
      variant: null,
      run_id: null,
      d: input.d,
    });

    await tx.execute({
      sql: `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha,
              spec_json, schema_version, registered_d, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ruleVersionId,
        market,
        family,
        n,
        incumbent,
        input.origin === "owner" ? "owner" : "challenger",
        paramsJson(input.params),
        sha,
        ruleSpecJson(family),
        RULE_SCHEMA_VERSION,
        input.d,
        input.actor,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
            VALUES (?, 1, 'registered', ?, ?)`,
      args: [ruleVersionId, input.d, `${input.origin} challenger ${id}`],
    });
    await tx.execute({
      sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version,
              variant, run_id, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        trial.id,
        trial.market,
        trial.lineage_id,
        trial.split_version,
        trial.kind,
        trial.rule_version,
        trial.variant,
        trial.run_id,
        trial.d,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO challenger (id, lineage_id, rule_version_id, incumbent_version_id, origin,
              lesson_ids_json, state, state_d, trial_id)
            VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      args: [
        id,
        lineage,
        ruleVersionId,
        incumbent,
        input.origin,
        JSON.stringify([...new Set(input.lessonIds)].sort()),
        input.d,
        trial.id,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason, ref_json)
            VALUES (?, 1, NULL, 'proposed', ?, ?, ?, ?)`,
      args: [
        id,
        input.d,
        input.actor,
        `${input.origin} version ${ruleVersionId}`,
        JSON.stringify({ trial_id: trial.id, rule_version: ruleVersionId }),
      ],
    });
    await tx.commit();
    return { status: "created", id, ruleVersionId };
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      // already closed by an explicit rollback above
    }
    throw e;
  } finally {
    tx.close();
  }
}

// ---- reading ------------------------------------------------------------------------------------------

export async function loadChallenger(db: Exec, id: string): Promise<ChallengerRow | null> {
  const rs = await db.execute({ sql: "SELECT * FROM challenger WHERE id = ?", args: [id] });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0]!;
  return {
    id: text(r.id),
    lineage_id: text(r.lineage_id),
    rule_version_id: text(r.rule_version_id),
    incumbent_version_id: text(r.incumbent_version_id),
    origin: text(r.origin) as ChallengerRow["origin"],
    lesson_ids_json: text(r.lesson_ids_json),
    state: text(r.state) as ChallengerState,
    state_d: text(r.state_d),
    trial_id: text(r.trial_id),
    shakedown_ok_sessions: num(r.shakedown_ok_sessions),
    shadow_viewed_d: r.shadow_viewed_d === null ? null : text(r.shadow_viewed_d),
    ready: num(r.ready) as ChallengerRow["ready"],
  };
}

// ---- transitions ----------------------------------------------------------------------------------------

export type Transition = {
  readonly id: string;
  readonly to: ChallengerState;
  readonly d: string;
  /** `A6`, `A7` or a hashed user id. */
  readonly actor: string;
  readonly reason: string;
  readonly ref?: Readonly<Record<string, unknown>>;
};

export type TransitionResult = {
  readonly changed: boolean;
  readonly from: ChallengerState;
  readonly to: ChallengerState;
};

/**
 * Moves a challenger along one KB-040 edge and appends the `challenger_event`, in one transaction.
 * Idempotent: a challenger already in `to` is left alone (no second event). Guards beyond the edge
 * table (the database enforces the table and the monotone `state_d`; these enforce the rules):
 *   - `shakedown -> review` needs the counter at `shakedown_sessions` (D-110 / KB-040);
 *   - `review -> approved` needs the `ready` mark (AGT-042: a failed check blocks promotion);
 *   - leaving `review` for a terminal state clears `ready` (the table CHECK ties it to review...promoted).
 *   - leaving `approved` for a terminal state clears `ready` too (migration 0010 allows exactly that).
 */
export async function transitionChallenger(
  db: Client,
  t: Transition,
  learning: Pick<LearningParams, "shakedownSessions">,
): Promise<TransitionResult> {
  const tx = await db.transaction("write");
  try {
    const row = await loadChallenger(tx, t.id);
    if (row === null) throw new ChallengerError(`unknown challenger ${t.id}`);
    if (row.state === t.to) {
      await tx.rollback();
      return { changed: false, from: row.state, to: t.to };
    }
    if (!isAllowedEdge(row.state, t.to)) {
      throw new ChallengerError(`${t.id}: ${row.state} -> ${t.to} is not a KB-040 edge`);
    }
    if (t.d < row.state_d) throw new ChallengerError(`${t.id}: d ${t.d} is before ${row.state_d}`);
    if (t.to === "review" && row.shakedown_ok_sessions < learning.shakedownSessions) {
      throw new ChallengerError(
        `${t.id}: ${row.shakedown_ok_sessions} of ${learning.shakedownSessions} shakedown sessions`,
      );
    }
    if (t.to === "approved" && row.ready !== 1) {
      throw new ChallengerError(`${t.id}: not ready (a Critic check has not passed)`);
    }
    const clearReady =
      (row.state === "review" || row.state === "approved") &&
      (t.to === "rejected" || t.to === "retired");
    await tx.execute({
      sql: `UPDATE challenger SET state = ?, state_d = ?${clearReady ? ", ready = 0" : ""} WHERE id = ?`,
      args: [t.to, t.d, t.id],
    });
    const seq = await tx.execute({
      sql: "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM challenger_event WHERE challenger_id = ?",
      args: [t.id],
    });
    await tx.execute({
      sql: `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason, ref_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id,
        num(seq.rows[0]!.s),
        row.state,
        t.to,
        t.d,
        t.actor,
        t.reason,
        JSON.stringify(t.ref ?? {}),
      ],
    });
    await tx.commit();
    return { changed: true, from: row.state, to: t.to };
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back
    }
    throw e;
  } finally {
    tx.close();
  }
}

// ---- shakedown (KB-040: sessions, not evidence) ------------------------------------------------------------

/** One trading session of a challenger in shakedown. */
export type ShakedownSession = {
  readonly d: string;
  /** Batch 2b and batch 3 succeeded, with no rule-load and no ledger error (design 2.8). */
  readonly ok: boolean;
};

export function shakedownSessionOk(s: {
  readonly batch2b: boolean;
  readonly batch3: boolean;
  readonly ruleLoadError: boolean;
  readonly ledgerError: boolean;
}): boolean {
  return s.batch2b && s.batch3 && !s.ruleLoadError && !s.ledgerError;
}

/**
 * The shakedown counter from the session history: only sessions after `enteredD` count, one verdict
 * per date (a date with any failed record is a failure), in date order; an operational error resets
 * the count to 0 (not evidence, D-111) and counting restarts with the next ok session.
 */
export function shakedownCount(enteredD: string, sessions: readonly ShakedownSession[]): number {
  const byDate = new Map<string, boolean>();
  for (const s of sessions) {
    if (s.d <= enteredD) continue;
    byDate.set(s.d, (byDate.get(s.d) ?? true) && s.ok);
  }
  let count = 0;
  for (const d of [...byDate.keys()].sort()) count = byDate.get(d)! ? count + 1 : 0;
  return count;
}

export type ShakedownSync = {
  readonly count: number;
  readonly changed: boolean;
  readonly moved: boolean;
};

/**
 * Sets the stored counter to the value the history gives and, at `shakedown_sessions`, moves the
 * challenger to review. Idempotent (an absolute set from the same history). A lower value is written
 * as 0 first and then the new value, which are the only moves the trigger allows (D-111).
 * Only a challenger in `shakedown` is touched.
 */
export async function syncShakedown(
  db: Client,
  args: {
    readonly id: string;
    readonly d: string;
    readonly sessions: readonly ShakedownSession[];
    readonly learning: Pick<LearningParams, "shakedownSessions">;
  },
): Promise<ShakedownSync> {
  const tx = await db.transaction("write");
  let count: number;
  let changed = false;
  try {
    const row = await loadChallenger(tx, args.id);
    if (row === null) throw new ChallengerError(`unknown challenger ${args.id}`);
    if (row.state !== "shakedown") {
      throw new ChallengerError(`${args.id}: ${row.state} is not shakedown`);
    }
    count = shakedownCount(row.state_d, args.sessions);
    if (count !== row.shakedown_ok_sessions) {
      changed = true;
      if (count < row.shakedown_ok_sessions && count !== 0) {
        await tx.execute({
          sql: "UPDATE challenger SET shakedown_ok_sessions = 0 WHERE id = ?",
          args: [args.id],
        });
      }
      await tx.execute({
        sql: "UPDATE challenger SET shakedown_ok_sessions = ? WHERE id = ?",
        args: [count, args.id],
      });
    }
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back
    }
    throw e;
  } finally {
    tx.close();
  }
  if (count < args.learning.shakedownSessions) return { count, changed, moved: false };
  const r = await transitionChallenger(
    db,
    {
      id: args.id,
      to: "review",
      d: args.d,
      actor: "A6",
      reason: `shakedown complete: ${count} sessions`,
      ref: { shakedown_ok_sessions: count },
    },
    args.learning,
  );
  return { count, changed, moved: r.changed };
}

// ---- review (KB-040 review, AGT-041/042) --------------------------------------------------------------------

export const CRITIC_CHECK_COUNT = 6; // threshold-ok: the six deterministic checks of AGT-041
export type CriticState = "pass" | "fail" | "pending" | "not_assessable";

export type ReviewVerdict = {
  /** All six checks read `pass`. */
  readonly ready: boolean;
  readonly failed: readonly number[];
  /** Checks that are pending or not assessable: not a pass, so not ready (conservative). */
  readonly open: readonly number[];
};

/** `checks[i]` is check i+1 (1..6). Anything but exactly six `pass` is not ready. */
export function reviewVerdict(checks: readonly CriticState[]): ReviewVerdict {
  if (checks.length !== CRITIC_CHECK_COUNT) {
    throw new ChallengerError(`review needs ${CRITIC_CHECK_COUNT} checks, got ${checks.length}`);
  }
  const failed: number[] = [];
  const open: number[] = [];
  checks.forEach((c, i) => {
    if (c === "fail") failed.push(i + 1);
    else if (c !== "pass") open.push(i + 1);
  });
  return { ready: failed.length === 0 && open.length === 0, failed, open };
}

/**
 * Applies the verdict to a challenger in `review`: sets or clears `ready` (idempotent; the trigger
 * lets `ready` flip only in review). Nothing else changes: a failed check keeps it in review (the
 * Owner may force-apply or reject), nothing promotes here.
 */
export async function reviewChallenger(
  db: Client,
  id: string,
  checks: readonly CriticState[],
): Promise<{ readonly verdict: ReviewVerdict; readonly changed: boolean }> {
  const verdict = reviewVerdict(checks);
  const row = await loadChallenger(db, id);
  if (row === null) throw new ChallengerError(`unknown challenger ${id}`);
  if (row.state !== "review") throw new ChallengerError(`${id}: ${row.state} is not review`);
  const want = verdict.ready ? 1 : 0;
  if (row.ready === want) return { verdict, changed: false };
  await db.execute({ sql: "UPDATE challenger SET ready = ? WHERE id = ?", args: [want, id] });
  return { verdict, changed: true };
}
