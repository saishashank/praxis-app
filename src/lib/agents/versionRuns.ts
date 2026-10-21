// Rule versions in the money path (M6 T8; D-110 #32 "rule versions change parameters only" and #44
// "batch 2b runs every rule version"; D-115). Pure resolution plus one read of the version tables.
//
// Batch 2b evaluates `runFamilies` once for the live set (the incumbent version of every family,
// parameters taken from its `rule_version` row, not from the Lane-B config keys) and once more for
// every other active version of a family: live older versions, shadow versions, challengers in
// shakedown / review / approved, and any version a cohort of this market is assigned to. Every
// version's candidates are stored (signal rows carry the version in their id); only a cohort whose
// execution is assigned to a version trades its candidates. With no `rule_version` row (a database
// before the v1 seed) the behaviour is the old single call with the configuration parameters.
import type { Client } from "@libsql/client";
import type { ExecutionRow } from "@/lib/arena/schema";
import { FAMILY_ORDER, FAMILY_RULE_VERSION } from "./families/constants";
import { runFamilies } from "./families";
import type { Candidate, BlockedCandidate, Family, FamilyInputs, FamilyOutput } from "./families";
import { paramsWithVersion, type AgentParams } from "./params";

export type VersionRole = "live" | "shadow" | "challenger" | "assigned";

export type RuleVersionRef = {
  readonly id: string;
  readonly family: Family;
  readonly n: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly role: VersionRole;
};

export type VersionSet = {
  /** The incumbent (live, highest n) version per family; a family without one keeps the base. */
  readonly live: ReadonlyMap<Family, RuleVersionRef>;
  /** Every other version to evaluate, ordered by family then n. */
  readonly extra: readonly RuleVersionRef[];
};

const FAMILY_SET: ReadonlySet<string> = new Set(FAMILY_ORDER);

/** `v1` (the registry value of an execution) becomes `<family>.v1`; a full id stays as it is. */
export function versionIdOf(family: Family, executionRuleVersion: string): string {
  return executionRuleVersion.includes(".")
    ? executionRuleVersion
    : `${family}.${executionRuleVersion}`;
}

/** The rule-version id an execution trades (null for an execution without a family: C1). */
export function executionVersionId(
  exec: Pick<ExecutionRow, "family" | "rule_version">,
): string | null {
  return exec.family === null ? null : versionIdOf(exec.family as Family, exec.rule_version);
}

/**
 * Reads the versions to run. Null when the market has no `rule_version` row (or the table does not
 * exist yet): the caller then runs the old single call.
 */
export async function loadVersionSet(
  db: Client,
  market: string,
  executions: readonly Pick<ExecutionRow, "market" | "family" | "rule_version">[],
): Promise<VersionSet | null> {
  let rows;
  try {
    rows = (
      await db.execute({
        sql: `SELECT r.id, r.family, r.n, r.params_json,
                (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
                  ORDER BY s.seq DESC LIMIT 1) AS status,
                EXISTS (SELECT 1 FROM challenger c WHERE c.rule_version_id = r.id
                  AND c.state IN ('shakedown','review','approved')) AS running
              FROM rule_version r WHERE r.market = ? ORDER BY r.family, r.n`,
        args: [market],
      })
    ).rows;
  } catch {
    return null; // a database without migration 0010
  }
  if (rows.length === 0) return null;
  const assigned = new Set(
    executions
      .filter((e) => e.market === market && e.family !== null)
      .map((e) => versionIdOf(e.family as Family, e.rule_version)),
  );
  const live = new Map<Family, RuleVersionRef>();
  const rest: RuleVersionRef[] = [];
  for (const r of rows) {
    const family = String(r.family);
    if (!FAMILY_SET.has(family)) continue;
    const status = r.status === null ? "registered" : String(r.status);
    const id = String(r.id);
    const role: VersionRole | null =
      status === "live"
        ? "live"
        : status === "shadow"
          ? "shadow"
          : Number(r.running) === 1
            ? "challenger"
            : assigned.has(id)
              ? "assigned"
              : null;
    if (role === null) continue;
    const ref: RuleVersionRef = {
      id,
      family: family as Family,
      n: Number(r.n),
      params: JSON.parse(String(r.params_json)) as Record<string, unknown>,
      role,
    };
    const incumbent = live.get(ref.family);
    if (role === "live" && (incumbent === undefined || incumbent.n < ref.n)) {
      if (incumbent !== undefined) rest.push({ ...incumbent, role: "live" });
      live.set(ref.family, ref);
    } else rest.push(ref);
  }
  const extra = rest.sort((a, b) =>
    a.family === b.family ? a.n - b.n : a.family < b.family ? -1 : 1,
  );
  return { live, extra };
}

/** The base parameters with every family's incumbent version laid over them (the live parameters). */
export function liveParams(base: AgentParams, set: VersionSet | null): AgentParams {
  if (set === null) return base;
  let p = base;
  for (const family of FAMILY_ORDER) {
    const v = set.live.get(family);
    if (v !== undefined) p = paramsWithVersion(p, family, v.params);
  }
  return p;
}

export type VersionRun = {
  /** All candidates and blocked entries of every version (live set first, then by family and n). */
  readonly out: FamilyOutput;
  /** Parameters per version id, for sizing, plans and cards of the cohorts assigned to it. */
  readonly paramsOf: ReadonlyMap<string, AgentParams>;
  /** The live parameters (the base with the incumbents laid over it). */
  readonly live: AgentParams;
};

/**
 * `runFamilies` once for the live set and once per other version (same day inputs). With no version
 * set this is exactly `runFamilies(inputs, base)`. Deterministic: the order of versions is fixed.
 */
export function runVersions(
  inputs: FamilyInputs,
  base: AgentParams,
  set: VersionSet | null,
): VersionRun {
  const paramsOf = new Map<string, AgentParams>();
  if (set === null) {
    return { out: runFamilies(inputs, base), paramsOf, live: base };
  }
  const live = liveParams(base, set);
  const liveIds: Partial<Record<Family, string>> = {};
  for (const [family, v] of set.live) {
    liveIds[family] = v.id;
    paramsOf.set(v.id, paramsWithVersion(live, family, v.params));
  }
  for (const family of FAMILY_ORDER) {
    if (!paramsOf.has(FAMILY_RULE_VERSION[family]) && set.live.get(family) === undefined) {
      paramsOf.set(FAMILY_RULE_VERSION[family], live);
    }
  }
  const first = runFamilies(inputs, live, { ruleVersions: liveIds });
  const candidates: Candidate[] = [...first.candidates];
  const blocked: BlockedCandidate[] = [...first.blocked];
  for (const v of set.extra) {
    const p = paramsWithVersion(live, v.family, v.params);
    paramsOf.set(v.id, p);
    const o = runFamilies(inputs, p, { families: [v.family], ruleVersions: { [v.family]: v.id } });
    candidates.push(...o.candidates);
    blocked.push(...o.blocked);
  }
  return {
    out: { d: first.d, candidates, blocked, blockedData: first.blockedData },
    paramsOf,
    live,
  };
}
