// The holdout registry gate (M23 A2; CXA-015, D-1602…D-1605). The only module that writes `holdout_look` (a static test
// proves it). `preregister` freezes a test plan once (the sha256 of its text is the registry hash); `takeLook` takes the
// one look of a lineage and market. A look needs a frozen plan with the same hash (the database refuses it otherwise),
// a second attempt is refused, audited in `holdout_look_refusal` and logged for the Owner, and never throws and never
// computes. A computation that finds the sample too small (counted before any outcome is read) writes nothing, so the one
// look stays for the day the sample is met (D-1605). The look and its numbers are written in one batch.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { isVerdict, type Verdict } from "./verdict";

/** The item ids the `research_prereg` table accepts (migration 0040). */
export type PreregItem =
  | "CXA-003"
  | "CXA-004"
  | "CXA-008"
  | "CXA-009"
  | "CXA-011"
  | "CXA-014"
  | "VAL-118"
  | "DAT-248"
  | "VAL-121"
  | "VAL-111"
  | "M15";

/** A frozen plan: a JSON object (stored with its keys in sorted order) or the exact JSON text to store as it is. */
export type FrozenPlan = string | Readonly<Record<string, unknown>>;

const SQL_ERROR_UNIQUE = /constraint|unique|primary key/i;
const TRIGGER_ERROR = /PreregistrationMissing|VerdictVocabulary/;
const CALLER_MAX = 64; // threshold-ok: the caller column is at most 64 characters
const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters
const STATS_MAX = 4000; // threshold-ok: research_result.stats_json is at most 4000 characters

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** JSON with every object's keys sorted: the same plan always gives the same text and the same hash. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The text stored for a plan: a string as given (it must be JSON), an object in canonical form. */
export function frozenTextOf(frozen: FrozenPlan): string {
  if (typeof frozen === "string") {
    JSON.parse(frozen); // throws on text that is not JSON: a plan that cannot be stored is refused loudly
    return frozen;
  }
  return canonicalJson(frozen);
}

export type PreregOutcome =
  | { readonly status: "written"; readonly sha: string }
  | { readonly status: "present"; readonly sha: string }
  | { readonly status: "refused"; readonly reason: "changed"; readonly sha: string };

async function auditLine(db: Client, now: string, message: string): Promise<void> {
  try {
    // rows-ok: one Owner-visible warning line per refused attempt
    await db.execute({
      sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
      args: [now, "research", message.slice(0, LOG_MAX)],
    });
  } catch {
    // the log is shadow-grade: a failed line never turns a refusal into an error
  }
}

/**
 * Freezes a plan once. The same text again is "present"; a different text for the same lineage and market is refused and
 * logged, and the first plan stays.
 */
export async function preregister(
  db: Client,
  o: {
    lineage: string;
    market: string;
    item: PreregItem;
    frozen: FrozenPlan;
    now: string;
  },
): Promise<PreregOutcome> {
  const text = frozenTextOf(o.frozen);
  const sha = sha256Hex(text);
  // rows-ok: research_prereg primary key (lineage, market), one row
  const have = await db.execute({
    sql: "SELECT sha FROM research_prereg WHERE lineage = ? AND market = ?",
    args: [o.lineage, o.market],
  });
  const first = have.rows[0];
  if (first !== undefined) {
    if (String(first.sha) === sha) return { status: "present", sha };
    await auditLine(
      db,
      o.now,
      "A frozen test plan was changed after it was frozen; the change was refused and the first plan stands.",
    );
    return { status: "refused", reason: "changed", sha: String(first.sha) };
  }
  // rows-ok: one keyed insert into research_prereg, once per lineage and market
  await db.execute({
    sql: `INSERT INTO research_prereg (lineage, market, item, frozen_json, sha, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [o.lineage, o.market, o.item, text, sha, o.now],
  });
  return { status: "written", sha };
}

/** Aggregates only (counts, means, bounds, words); any JSON value, at most 4000 characters once written. */
export type LookStats = Readonly<Record<string, unknown>>;

/** What a computation returns: a verdict with its counts and aggregates, or "below sample" (nothing was read). */
export type LookComputed =
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly verdict: Verdict;
      readonly nSetups: number;
      readonly nBlocks: number;
      readonly stats: LookStats;
    };

export type LookCompute = () => Promise<LookComputed> | LookComputed;

export type LookResult =
  | { readonly status: "refused"; readonly reason: "already_looked" | "not_preregistered" }
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly status: "looked";
      readonly verdict: Verdict;
      readonly nSetups: number;
      readonly nBlocks: number;
      readonly stats: LookStats;
    };

async function refuse(
  db: Client,
  o: { lineage: string; market: string; sha: string; caller: string; now: string },
): Promise<LookResult> {
  try {
    // rows-ok: one audit row per refused attempt (lineage, market, at)
    await db.execute({
      sql: `INSERT INTO holdout_look_refusal (lineage, market, at, prereg_sha, caller)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [o.lineage, o.market, o.now, o.sha, o.caller.slice(0, CALLER_MAX)],
    });
  } catch {
    // an audit row that cannot be written (for example a market that is off) never turns the refusal into an error
  }
  await auditLine(db, o.now, "A second look at a finished test was refused.");
  return { status: "refused", reason: "already_looked" };
}

/**
 * Takes the one look of a lineage and market. `sha` is the hash `preregister` returned. A look already on file is refused,
 * audited and logged, and `compute` is not called. A computation that returns "below sample" writes nothing. A verdict writes
 * the look and its numbers together. A plan that was never frozen is refused without a write.
 */
export async function takeLook(
  db: Client,
  o: {
    lineage: string;
    market: string;
    sha: string;
    caller: string;
    now: string;
    compute: LookCompute;
  },
): Promise<LookResult> {
  // rows-ok: holdout_look primary key (lineage, market), one row
  const seen = await db.execute({
    sql: "SELECT 1 FROM holdout_look WHERE lineage = ? AND market = ?",
    args: [o.lineage, o.market],
  });
  if (seen.rows.length > 0) return refuse(db, o);
  // rows-ok: research_prereg primary key (lineage, market), one row
  const plan = await db.execute({
    sql: "SELECT sha FROM research_prereg WHERE lineage = ? AND market = ?",
    args: [o.lineage, o.market],
  });
  if (plan.rows.length !== 1 || String(plan.rows[0]!.sha) !== o.sha) {
    await auditLine(db, o.now, "A look was refused because its test plan was not frozen first.");
    return { status: "refused", reason: "not_preregistered" };
  }
  const out = await o.compute();
  if ("status" in out) return { status: "below_sample", reason: out.reason };
  if (!isVerdict(out.verdict)) throw new Error("a look ends in PASS, NULL or INCONCLUSIVE");
  if (!Number.isSafeInteger(out.nSetups) || out.nSetups < 0) throw new Error("bad setup count");
  if (!Number.isSafeInteger(out.nBlocks) || out.nBlocks < 0) throw new Error("bad block count");
  const statsJson = JSON.stringify(out.stats);
  if (statsJson.length > STATS_MAX) throw new Error("the statistics text is too long");
  try {
    await db.batch(
      [
        {
          // rows-ok: the one look of this lineage and market (primary key); a repeat fails the batch and is refused
          sql: `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict)
                VALUES (?, ?, ?, ?, ?)`,
          args: [o.lineage, o.market, o.now, o.sha, out.verdict],
        },
        {
          // rows-ok: the numbers of that look, one row (lineage, market)
          sql: `INSERT INTO research_result (lineage, market, looked_at, prereg_sha, n_setups, n_blocks, stats_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [o.lineage, o.market, o.now, o.sha, out.nSetups, out.nBlocks, statsJson],
        },
      ],
      "write",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // a primary-key conflict means another writer looked first: the same refusal path (trigger errors are not caught)
    if (SQL_ERROR_UNIQUE.test(msg) && !TRIGGER_ERROR.test(msg)) return refuse(db, o);
    throw e;
  }
  return {
    status: "looked",
    verdict: out.verdict,
    nSetups: out.nSetups,
    nBlocks: out.nBlocks,
    stats: out.stats,
  };
}
