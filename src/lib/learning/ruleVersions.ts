// Rule versions (KB-010..012, M6 decision 32 and 45 / D-110, D-111): the v1 seed from the registry
// (the lock that makes the Lane-B keys read-only once v1 exists is ./bKeyLock.ts).
//
// v1 of every family and market is created once, from the registry values of that moment, with
// origin `seed` (the label UNVALIDATED and grade L0 are the defaults of a version with no evidence
// rows; its metrics are empty until measured, KB-012). A version is immutable (KB-011): the seed is
// idempotent and a stored version whose parameters differ from the registry raises (ARN-102 style).
// The lock on the B keys after the seed lives in ./bKeyLock.ts (the config store imports it).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import { FAMILY_ORDER, FAMILY_RULE_VERSION } from "@/lib/agents/families/constants";
import {
  FAMILY_PARAM_KEYS,
  RULE_SCHEMA_VERSION,
  ruleSpecJson,
  validateRuleSpec,
  FAMILY_SPECS,
} from "@/lib/agents/families/ruleSchema";
import type { Family } from "@/lib/agents/schema";

export class RuleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleVersionError";
  }
}

/** Key-sorted JSON (the canonical form of params_json). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The full canonical parameter set of a family from a value source (the registry or a config read). */
export function canonicalParams(
  family: Family,
  value: (key: ConfigKey) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...FAMILY_PARAM_KEYS[family]].sort()) out[k] = value(k as ConfigKey);
  return out;
}

export const paramsJson = (params: Record<string, unknown>): string => canonical(params);
export const paramsSha = (params: Record<string, unknown>): string =>
  createHash("sha256").update(canonical(params)).digest("hex");

export type SeedResult = {
  readonly inserted: readonly string[];
  readonly unchanged: readonly string[];
};

/**
 * Seeds `<family>.v1` for every family of the market, idempotently. `value` supplies the B-key
 * values (default: the registry defaults). Each version is validated against the rule schema (every
 * parameter within its ch.15 bounds) before it is written; its status history starts `registered`
 * then `live` (v1 is the incumbent). Runs in one transaction.
 */
export async function seedRuleVersions(
  db: Client,
  opts: { market: string; d: string; value?: (key: ConfigKey) => unknown },
): Promise<SeedResult> {
  const value = opts.value ?? ((k: ConfigKey) => CONFIG_KEYS[k].default);
  const inserted: string[] = [];
  const unchanged: string[] = [];
  const tx = await db.transaction("write");
  try {
    for (const family of FAMILY_ORDER) {
      const id = FAMILY_RULE_VERSION[family];
      const params = canonicalParams(family, value);
      const problems = validateRuleSpec(FAMILY_SPECS[family], params);
      if (problems.length > 0) {
        throw new RuleVersionError(`${id}: ${problems.join("; ")}`);
      }
      const sha = paramsSha(params);
      const existing = await tx.execute({
        sql: "SELECT params_sha FROM rule_version WHERE id = ?",
        args: [id],
      });
      if (existing.rows.length > 0) {
        if (String(existing.rows[0]!.params_sha) !== sha) {
          throw new RuleVersionError(`${id}: stored parameters differ from the registry`);
        }
        unchanged.push(id);
        continue;
      }
      await tx.execute({
        sql: `INSERT INTO rule_version (id, market, family, n, parent, origin, params_json, params_sha,
                spec_json, schema_version, registered_d, created_by)
              VALUES (?, ?, ?, 1, NULL, 'seed', ?, ?, ?, ?, ?, 'system')
              ON CONFLICT DO NOTHING`,
        args: [
          id,
          opts.market,
          family,
          paramsJson(params),
          sha,
          ruleSpecJson(family),
          RULE_SCHEMA_VERSION,
          opts.d,
        ],
      });
      for (const [seq, status, reason] of [
        [1, "registered", "v1 seed"],
        [2, "live", "incumbent"],
      ] as const) {
        await tx.execute({
          sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [id, seq, status, opts.d, reason],
        });
      }
      inserted.push(id);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
  return { inserted, unchanged };
}
