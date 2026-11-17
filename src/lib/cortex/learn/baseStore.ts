// The candidate measures and the numbered base (Owner O-81; migration 0031 tables 5 and 6, the probe and
// base events of cortex_learn_event, the charges in cortex_ledger_cell / trial_ledger). The only DB
// layer of learn/probes.ts and learn/base.ts. Writers are insert-or-ignore (a re-run writes nothing
// new); readers scan a primary-key or index prefix (no OFFSET) and chunk IN lists at 200 (Turso free
// plan, D-903/D-904). Nothing here reads a price bar, an outcome or anything of the sealed holdout.
import type { InStatement } from "@libsql/client";
import { ANGLES } from "../angles/registry";
import type { AngleDef, AngleValue } from "../angles/types";
import { getCell, logCell, setCellResult } from "../store/ledger";
import {
  CORTEX_FAMILIES,
  jsonText,
  num,
  parseJson,
  str,
  strOrNull,
  type BatchExec,
  type CortexFamily,
  type Exec,
} from "../store/common";
import type { FeatureNight } from "./scorecard";
import { LEARN_BATCH, type LearnEvent } from "./store";

/** Codes / angle ids per IN list (Turso: chunks of 200). */
export const IN_CHUNK = 200; // threshold-ok: query chunk size (Turso rule)

function chunks<T>(xs: readonly T[], n: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const missingTable = (e: unknown): boolean =>
  /no such table/i.test(String((e as Error)?.message ?? e));

// ---- cortex_feature_probe -------------------------------------------------------------------------

export type ProbeFeatureRow = {
  readonly market: string;
  readonly d: string;
  readonly code: string;
  readonly angleId: string;
  readonly value: number | null;
  readonly flag: string | null;
  readonly angleVersion: number;
  readonly manifestId: string;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** PURE: a night's probe values as table rows, sorted by code then angle id. */
export function probeRowsOf(
  market: string,
  d: string,
  probes: ReadonlyMap<string, ReadonlyMap<string, AngleValue>>,
  manifestId: string,
  angles: readonly AngleDef[] = ANGLES,
): ProbeFeatureRow[] {
  const version = new Map(angles.map((a) => [a.id, a.version] as const));
  const out: ProbeFeatureRow[] = [];
  for (const [code, feats] of [...probes].sort((a, b) => byText(a[0], b[0]))) {
    for (const [angleId, v] of [...feats].sort((a, b) => byText(a[0], b[0]))) {
      const value = typeof v === "number" && Number.isFinite(v) ? v : null;
      const flag =
        v !== undefined && typeof v === "object" ? ("flag" in v ? v.flag : v.bucket) : null;
      out.push({
        market,
        d,
        code,
        angleId,
        value,
        flag,
        angleVersion: version.get(angleId) ?? 1,
        manifestId,
      });
    }
  }
  return out;
}

export async function insertProbeRows(
  db: BatchExec,
  rows: readonly ProbeFeatureRow[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += LEARN_BATCH) {
    const res = await db.batch(
      rows.slice(i, i + LEARN_BATCH).map((r): InStatement => ({
        sql: `INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version,
                  manifest_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [r.market, r.d, r.code, r.angleId, r.value, r.flag, r.angleVersion, r.manifestId],
      })),
      "write",
    );
    inserted += res.reduce((n, x) => n + x.rowsAffected, 0);
  }
  return { inserted };
}

/** The probe values of the given nights as feature nights (code → {angle: value}); one read per
 *  night and angle chunk (2 nights × probes × codes rows). */
export async function probeFeatureNights(
  db: Exec,
  market: string,
  ds: readonly string[],
  angleIds: readonly string[],
): Promise<Map<string, FeatureNight>> {
  const out = new Map<string, FeatureNight>();
  if (angleIds.length === 0) return out;
  for (const d of ds) {
    const byCode = new Map<string, { features: Record<string, unknown>; manifestId: string }>();
    for (const part of chunks([...angleIds].sort(byText))) {
      const r = await db.execute({
        sql: `SELECT code, angle_id, value, manifest_id FROM cortex_feature_probe
              WHERE market = ? AND d = ? AND angle_id IN (${part.map(() => "?").join(", ")})
              ORDER BY code, angle_id`,
        args: [market, d, ...part],
      });
      for (const x of r.rows) {
        const code = str(x.code);
        const row = byCode.get(code) ?? { features: {}, manifestId: str(x.manifest_id) };
        row.features[str(x.angle_id)] = x.value === null ? null : Number(x.value);
        byCode.set(code, row);
      }
    }
    if (byCode.size === 0) continue;
    out.set(d, {
      d,
      rows: [...byCode]
        .sort((a, b) => byText(a[0], b[0]))
        .map(([code, v]) => ({
          code,
          features: v.features,
          activeSetHash: PROBE_SET_HASH,
          manifestId: v.manifestId,
        })),
    });
  }
  return out;
}

/** The `active_set_hash` a probe scorecard row carries (probes are outside every scored set). */
export const PROBE_SET_HASH = "probe";

// ---- probe / base events --------------------------------------------------------------------------

/** The event kinds the probe and base logic reads back. */
export const BASE_EVENT_KINDS = ["probe_open", "probe_close", "escalate", "base_change"] as const;

/** Probe and base events of nights up to `toD` (inclusive; `exclusive` = strictly before), oldest
 *  first. Index scan (market, kind, d): a few rows a month. */
export async function baseEvents(
  db: Exec,
  market: string,
  toD: string,
  exclusive = false,
): Promise<LearnEvent[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_learn_event INDEXED BY cortex_learn_event_kind WHERE market = ?
            AND kind IN (${BASE_EVENT_KINDS.map(() => "?").join(", ")}) AND d ${exclusive ? "<" : "<="} ?
          ORDER BY d, seq`,
    args: [market, ...BASE_EVENT_KINDS, toD],
  });
  return r.rows.map((row) => {
    const x = row as Record<string, unknown>;
    return {
      market: str(x.market),
      d: str(x.d),
      seq: num(x.seq),
      kind: str(x.kind) as LearnEvent["kind"],
      family: strOrNull(x.family),
      angleId: strOrNull(x.angle_id),
      generation: x.generation === null ? null : num(x.generation),
      evidence: parseJson(x.evidence_json),
      words: str(x.words),
      reversesSeq: x.reverses_seq === null ? null : num(x.reverses_seq),
      expiresD: strOrNull(x.expires_d),
      createdAt: str(x.created_at),
    };
  });
}

/** One probe as the events tell it (learn/probes.ts `probeStates` is the pure fold). */
export type ProbeEventLike = Pick<LearnEvent, "d" | "seq" | "kind" | "family" | "angleId">;

/** The angles of every probe open before night `d` (opened on an earlier night, not closed since),
 *  any family, sorted. A database before 0031 has none. The Cortex stage computes these. */
export async function openProbeAngles(db: Exec, market: string, d: string): Promise<string[]> {
  let events: LearnEvent[];
  try {
    events = await baseEvents(db, market, d, true);
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
  const open = new Map<string, string>(); // family|angle -> angle
  for (const e of events) {
    if (e.angleId === null || e.angleId === undefined || !e.family) continue;
    const key = `${e.family}|${e.angleId}`;
    if (e.kind === "probe_open") open.set(key, e.angleId);
    else if (e.kind === "probe_close") open.delete(key);
  }
  return [...new Set(open.values())].sort(byText);
}

// ---- cortex_base_version --------------------------------------------------------------------------

export type BaseReason = "initial" | "promote" | "retire" | "owner_import";

export type BaseVersionRow = {
  readonly market: string;
  readonly family: CortexFamily;
  readonly version: number;
  /** The first night the version is in force (the night after it was written). */
  readonly sinceD: string;
  readonly reason: BaseReason;
  /** The cortex_map rule version that scores this base (the fixed rule, or `<rule>+b<version>`). */
  readonly ruleVersion: string;
  readonly angles: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly evidence: unknown;
  readonly createdAt: string;
};

export async function insertBaseVersion(
  db: Exec,
  v: BaseVersionRow,
): Promise<{ inserted: boolean }> {
  const r = await db.execute({
    sql: `INSERT INTO cortex_base_version (market, family, version, since_d, reason, rule_version,
            angles_json, added_json, removed_json, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      v.market,
      v.family,
      v.version,
      v.sinceD,
      v.reason,
      v.ruleVersion,
      JSON.stringify(v.angles),
      JSON.stringify(v.added),
      JSON.stringify(v.removed),
      jsonText(v.evidence),
      v.createdAt,
    ],
  });
  return { inserted: r.rowsAffected > 0 };
}

/** Every base version of a market (a handful a year), by family then version. */
export async function baseVersions(db: Exec, market: string): Promise<BaseVersionRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_base_version WHERE market = ? ORDER BY family, version",
    args: [market],
  });
  return r.rows.map((row) => {
    const x = row as Record<string, unknown>;
    return {
      market: str(x.market),
      family: str(x.family) as CortexFamily,
      version: num(x.version),
      sinceD: str(x.since_d),
      reason: str(x.reason) as BaseReason,
      ruleVersion: str(x.rule_version),
      angles: parseJson<string[]>(x.angles_json),
      added: parseJson<string[]>(x.added_json),
      removed: parseJson<string[]>(x.removed_json),
      evidence: parseJson(x.evidence_json),
      createdAt: str(x.created_at),
    };
  });
}

/** The newest version of each family's base (any since_d: the latest written). */
export function latestBases(rows: readonly BaseVersionRow[]): Map<CortexFamily, BaseVersionRow> {
  const out = new Map<CortexFamily, BaseVersionRow>();
  for (const v of rows) {
    const have = out.get(v.family);
    if (have === undefined || v.version > have.version) out.set(v.family, v);
  }
  return out;
}

/**
 * The base in force on night `d` per family (the newest version with since_d <= d). The learner's
 * weekly run builds its generation 0 on `inForce.ruleVersion` after a change (`restartLearner`).
 */
export async function baseInForce(
  db: Exec,
  market: string,
  d: string,
): Promise<Map<CortexFamily, BaseVersionRow>> {
  let rows: BaseVersionRow[];
  try {
    rows = await baseVersions(db, market);
  } catch (e) {
    if (missingTable(e)) return new Map();
    throw e;
  }
  return latestBases(rows.filter((v) => v.sinceD <= d));
}

// ---- charges (cortex_ledger_cell + trial_ledger, logged before the result) -------------------------

/** cortex_ledger_cell kinds of the two charged trials. */
export const PROBE_CELL_KIND = "learn_probe";
export const BASE_CELL_KIND = "learn_base";

export type Charge = {
  readonly market: string;
  readonly family: CortexFamily;
  readonly angleId: string | null;
  readonly kind: typeof PROBE_CELL_KIND | typeof BASE_CELL_KIND;
  readonly cellId: string;
  readonly spec: unknown;
  /** Logged-at instant (before any result). */
  readonly at: string;
  /** Session of the trial row. */
  readonly d: string;
  /** trial_ledger rule_version / variant. */
  readonly ruleVersion: string;
  readonly variant: string;
};

/**
 * Charges a trial BEFORE its result exists (CTX-031, design B.3 check 4, LRN-AT-12): the ledger cell
 * (`logCell`, result empty) and, when the family's lineage has a split, one `trial_ledger` row of kind
 * 'challenger' (the keyEdit.ts pattern). Idempotent: a cell already logged is left as it was.
 */
export async function chargeTrial(db: BatchExec, c: Charge): Promise<{ charged: boolean }> {
  if ((await getCell(db, c.cellId)) !== null) return { charged: false };
  await logCell(db, {
    cellId: c.cellId,
    market: c.market,
    family: c.family,
    angleId: c.angleId,
    kind: c.kind,
    spec: c.spec,
    loggedAt: c.at,
    split: "validation",
    lineageId: null,
  });
  const lineage = `${c.market}:${c.family}`;
  const split = await db.execute({
    sql: "SELECT MAX(version) AS v FROM lineage_split WHERE lineage_id = ?",
    args: [lineage],
  });
  const v = split.rows[0]?.v;
  if (v !== null && v !== undefined) {
    await db.execute({
      sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant,
              run_id, d) VALUES (?, ?, ?, ?, 'challenger', ?, ?, NULL, ?) ON CONFLICT DO NOTHING`,
      args: [`cortex-${c.cellId}`, c.market, lineage, Number(v), c.ruleVersion, c.variant, c.d],
    });
  }
  return { charged: true };
}

/** Sets a charged trial's result once (false = missing or already set). */
export async function settleTrial(
  db: Exec,
  cellId: string,
  at: string,
  result: unknown,
): Promise<boolean> {
  return setCellResult(db, cellId, at, result);
}

export type ChargedCell = {
  readonly cellId: string;
  readonly family: string;
  readonly angleId: string | null;
  readonly loggedAt: string;
  readonly settled: boolean;
};

/** Every charged cell of a kind for the market (all families): the BH family "all probes tried". */
export async function chargedCells(
  db: Exec,
  market: string,
  kind: Charge["kind"],
): Promise<ChargedCell[]> {
  const r = await db.execute({
    sql: `SELECT cell_id, family, angle_id, logged_at, result_at FROM cortex_ledger_cell
          WHERE market = ? AND family IN (${CORTEX_FAMILIES.map(() => "?").join(", ")}) AND kind = ?
          ORDER BY cell_id`,
    args: [market, ...CORTEX_FAMILIES, kind],
  });
  return r.rows.map((x) => ({
    cellId: str(x.cell_id),
    family: str(x.family),
    angleId: strOrNull(x.angle_id),
    loggedAt: str(x.logged_at),
    settled: x.result_at !== null && x.result_at !== undefined,
  }));
}

// ---- the daily loop's movers (read only) ----------------------------------------------------------

export type CauseNight = {
  readonly d: string;
  readonly movers: readonly { readonly code: string; readonly cause: string }[];
};

/** The explained movers of the daily learning nights fromD..toD (one row a night, ~20 rows). */
export async function moverNights(
  db: Exec,
  market: string,
  fromD: string,
  toD: string,
): Promise<CauseNight[]> {
  const r = await db.execute({
    sql: `SELECT d, json_extract(body_json, '$.movers') AS movers FROM daily_learning
          WHERE market = ? AND d >= ? AND d <= ? ORDER BY d`,
    args: [market, fromD, toD],
  });
  return r.rows.map((x) => {
    let list: unknown = [];
    try {
      list = x.movers === null || x.movers === undefined ? [] : JSON.parse(String(x.movers));
    } catch {
      list = [];
    }
    const movers = (Array.isArray(list) ? list : [])
      .map((m) => m as { code?: unknown; cause?: unknown })
      .filter((m) => typeof m.code === "string" && typeof m.cause === "string")
      .map((m) => ({ code: m.code as string, cause: m.cause as string }));
    return { d: str(x.d), movers };
  });
}
