// Angle registry (M15 C1a; docs/M15_design.md 3a; CTX-011, CTX-030, CTX-051, D-290, D-291, D-292).
// The registry is the source of angle definitions; the `angle_passport` table holds their measured
// values (D-281). Rules kept here, not in the angles:
//   - an angle is activatable only when every InputKind it reads has a live reader (LIVE_READERS),
//     it names no `needsData`, and (score kind) it has a compute; otherwise `active` is demoted;
//   - a candidate or retired angle, or one with no compute, evaluates to undefined;
//   - score outputs are rank-standardised to [-1, 1] within the universe each night, ties averaged
//     (rankIc.ts averageRanks) over code-sorted input, so the same values give the same bytes.
// Pure and deterministic: no clock, no store, no random source.
import { averageRanks } from "@/lib/stats/rankIc";
import type { InputKind } from "../pit/types";
import { D10_ANGLES } from "./d10";
import { D7_ANGLES } from "./d7";
import { D9_ANGLES } from "./d9";
import {
  ANGLE_CLUSTERS,
  GATE_CLUSTERS,
  type AngleDef,
  type AngleDomain,
  type AngleStatus,
  type AngleValue,
  type AsOfView,
  type GridPoint,
} from "./types";

export const ANGLE_ID_RE = /^A-D(10|[1-9])-(\d{2})$/;
/** Angles per domain in the D1...D10 lists (10 x 10 = 100, CTX-011). */
export const ANGLES_PER_DOMAIN = 10;
export const ANGLE_COUNT = 100;

/**
 * InputKinds the live app can read at the cut-off. `macro` has no live fetcher in M15 (D-291), so
 * a macro angle can be measured offline but never `active` live; `index_us` reads the GSPC/VIX rows
 * P1 adds under the existing Yahoo register row (D-290).
 */
export const LIVE_READERS: ReadonlySet<InputKind> = new Set<InputKind>([
  "bar_au",
  "index_au",
  "index_us",
  "asic_short",
  "announcement",
  "corp_action",
  "index_change",
  "calendar",
  "sector_map",
]);

export function domainOf(id: string): AngleDomain {
  const m = ANGLE_ID_RE.exec(id);
  if (!m) throw new RangeError(`not an angle id: ${id}`);
  return Number(m[1]) as AngleDomain;
}

const SCORE_CLUSTERS: ReadonlySet<string> = new Set(ANGLE_CLUSTERS);
const GATE_CLUSTER_SET: ReadonlySet<string> = new Set(GATE_CLUSTERS);

/** Validates a list of definitions (ids, domains, kind/cluster consistency, grids) and returns it sorted by id. */
export function defineAngles(defs: readonly AngleDef[]): readonly AngleDef[] {
  const seen = new Set<string>();
  for (const a of defs) {
    if (seen.has(a.id)) throw new RangeError(`duplicate angle id ${a.id}`);
    seen.add(a.id);
    if (domainOf(a.id) !== a.domain)
      throw new RangeError(`${a.id}: domain ${a.domain} does not match id`);
    if (!Number.isInteger(a.version) || a.version < 1) throw new RangeError(`${a.id}: bad version`);
    if (a.orientation !== 1 && a.orientation !== -1)
      throw new RangeError(`${a.id}: bad orientation`);
    if (a.kind === "score" && !SCORE_CLUSTERS.has(a.cluster))
      throw new RangeError(`${a.id}: a score angle needs a score cluster, got ${a.cluster}`);
    if (a.kind !== "score" && !GATE_CLUSTER_SET.has(a.cluster))
      throw new RangeError(`${a.id}: a ${a.kind} angle needs a gate cluster, got ${a.cluster}`);
    if (!Number.isInteger(a.horizonSessions) || a.horizonSessions < 0)
      throw new RangeError(`${a.id}: bad horizon`);
    if (!Number.isInteger(a.warmupSessions) || a.warmupSessions < 0)
      throw new RangeError(`${a.id}: bad warm-up`);
    if (new Set(a.inputs).size !== a.inputs.length)
      throw new RangeError(`${a.id}: duplicate input`);
    for (const [k, pts] of Object.entries(a.grid)) {
      if (pts.length === 0 || pts.some((p) => !Number.isFinite(p)))
        throw new RangeError(`${a.id}: grid ${k} needs finite points`);
    }
    if (a.kind !== "score" && a.compute === undefined && !a.existing?.length && !a.needsData)
      throw new RangeError(
        `${a.id}: a ${a.kind} entry without compute must cite the existing rule (D-292)`,
      );
  }
  return [...defs].sort((x, y) => cmpId(x.id, y.id));
}

function cmpId(a: string, b: string): number {
  const da = domainOf(a);
  const db = domainOf(b);
  return da - db || (a < b ? -1 : a > b ? 1 : 0);
}

/** The registry: D7/D9/D10 (C1a); C1b adds d1, d2 and C1c adds d3...d6, d8 here. 100 ids when complete. */
export const ANGLES: readonly AngleDef[] = defineAngles([
  ...D7_ANGLES,
  ...D9_ANGLES,
  ...D10_ANGLES,
]);

const BY_ID = new Map(ANGLES.map((a) => [a.id, a] as const));

export function angleById(id: string): AngleDef | undefined {
  return BY_ID.get(id);
}

export type ActivationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "needs_data" | "no_compute" | "no_live_reader";
      readonly missing: readonly InputKind[];
    };

/** Whether the angle may be `active` (or `watch`) in the app that has `liveReaders`. */
export function canActivate(
  def: AngleDef,
  liveReaders: ReadonlySet<InputKind> = LIVE_READERS,
): ActivationCheck {
  if (def.needsData) return { ok: false, reason: "needs_data", missing: [] };
  if (def.kind === "score" && def.compute === undefined)
    return { ok: false, reason: "no_compute", missing: [] };
  const missing = def.inputs.filter((k) => !liveReaders.has(k));
  if (missing.length > 0) return { ok: false, reason: "no_live_reader", missing };
  return { ok: true };
}

/**
 * The status the registry grants against the one the passport declares: `active` and `watch` need
 * `canActivate`; otherwise an angle that needs data or has no compute is `candidate`, and one that
 * only lacks a live reader is at most `measured` (offline evidence only, D-291).
 */
export function resolveStatus(
  def: AngleDef,
  declared: AngleStatus,
  liveReaders: ReadonlySet<InputKind> = LIVE_READERS,
): AngleStatus {
  const check = canActivate(def, liveReaders);
  if (check.ok) return declared;
  if (check.reason === "no_live_reader")
    return declared === "active" || declared === "watch" ? "measured" : declared;
  return declared === "retired" ? "retired" : "candidate";
}

/** The first point of every grid dimension: the pre-registered default cell. */
export function defaultGrid(def: AngleDef): GridPoint {
  const out: Record<string, number> = {};
  for (const [k, pts] of Object.entries(def.grid)) out[k] = pts[0]!;
  return out;
}

/** One angle on one code tonight; undefined for a candidate / retired angle or one without a compute. */
export function evaluateAngle(
  def: AngleDef,
  status: AngleStatus,
  view: AsOfView,
  code: string,
  t: number,
  grid: GridPoint = defaultGrid(def),
): AngleValue {
  if (status === "candidate" || status === "retired") return undefined;
  if (def.compute === undefined) return undefined;
  return def.compute(view, code, t, grid);
}

/** The angles that enter S tonight: score kind with status `active` (watch keeps its weight, CTX-032). */
export function scoredSet(
  defs: readonly AngleDef[],
  statusOf: (id: string) => AngleStatus,
): readonly AngleDef[] {
  return defs.filter((a) => {
    if (a.kind !== "score") return false;
    const s = statusOf(a.id);
    return s === "active" || s === "watch";
  });
}

/**
 * Rank standardisation within one night's universe to [-1, 1]: average ranks (ties share the mean
 * rank) over the codes sorted by code, mapped linearly so the lowest value is -1 and the highest +1,
 * then multiplied by the orientation. Non-finite values are dropped; one code maps to 0.
 */
export function rankStandardise(
  values: ReadonlyMap<string, number>,
  orientation: 1 | -1,
): ReadonlyMap<string, number> {
  const codes = [...values.keys()]
    .filter((c) => Number.isFinite(values.get(c)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<string, number>();
  const n = codes.length;
  if (n === 0) return out;
  const ranks = averageRanks(codes.map((c) => values.get(c)!));
  for (let i = 0; i < n; i += 1) {
    const s = n === 1 ? 0 : (2 * (ranks[i]! - 1)) / (n - 1) - 1;
    out.set(codes[i]!, s === 0 ? 0 : orientation * s); // never -0: same bytes either way
  }
  return out;
}
