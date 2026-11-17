// Validates the cluster expressions of the private seed (M22 E4; KB-085, D-1436, D-1437, D-1438). Owner-run, read-only:
//   node scripts/experts/express-check.mjs --seed <seed-folder>
// Reads the seed folder (format `praxis-expert-seed/2`, the file `expressions.json`), checks every expressed entry's rule
// against the schema-v2 loader and its exit against the fixed menu, and prints the COUNTS and the cluster ids (K-ids)
// by outcome: expressed, parked by reason, and not yet addressed. The summary prints no name, statement, rule or text (a
// rejection names the entry and the grammar rule it breaks so the Owner can fix the file), writes nothing and makes no
// network request. The folder is private data and must lie OUTSIDE this repository (SEC-110).
// The "at least 20 expressed" target is REPORTED (met, or the shortfall with the reasons), never enforced: a shortfall is
// not an error. Exit code 0 when every entry is valid, 1 when anything is rejected.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideRepo, loadSeed } from "./import.mjs";
import { PARK_REASONS } from "./validate.mjs";

export const TARGET_EXPRESSED = 20;

const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

/** The schema-v2 loader (bundled on demand; tests pass their own). */
async function defaultSchema() {
  const { loadRuleSchema } = await import("../learning/engine.mjs");
  return loadRuleSchema();
}

/**
 * Pure core: classifies every cluster of a loaded seed. Returns the problems found (file, path, rule; never a value) and
 * the K-ids by outcome. `schema` has `validateExpressedRule(rule)` and `validateExpressionExit(exit)`.
 */
export function checkExpressions(data, schema) {
  const errors = [];
  const clusters = data["clusters.json"].clusters;
  const entries = data["expressions.json"]?.expressions ?? [];
  const eod = new Map(clusters.map((k) => [k.id, k.testability === "testable_eod"]));
  // the newest version of each cluster decides its outcome
  const newest = new Map();
  entries.forEach((x, i) => {
    const v = x.version ?? 1;
    const cur = newest.get(x.cluster_id);
    if (cur === undefined || v > cur.version)
      newest.set(x.cluster_id, { ...x, version: v, index: i });
  });
  entries.forEach((x, i) => {
    if (x.outcome !== "expressed") return;
    const p = `expressions[${i}]`;
    for (const m of schema.validateExpressedRule(x.rule))
      errors.push(`expressions.json: ${p}.rule: ${m}`);
    for (const m of schema.validateExpressionExit(x.exit))
      errors.push(`expressions.json: ${p}.exit: ${m}`);
    if (typeof x.preregistration !== "string" || x.preregistration.trim() === "")
      errors.push(`expressions.json: ${p}.preregistration: text required`);
    if (eod.get(x.cluster_id) === false)
      errors.push(
        `expressions.json: ${p}.cluster_id: an expressed cluster must be end-of-day testable`,
      );
  });
  const expressed = [];
  const parked = Object.fromEntries(PARK_REASONS.map((r) => [r, []]));
  const unaddressed = [];
  for (const k of clusters) {
    const x = newest.get(k.id);
    if (x === undefined) unaddressed.push(k.id);
    else if (x.outcome === "expressed") expressed.push(k.id);
    else parked[x.park_reason]?.push(k.id);
  }
  return { errors, expressed, parked, unaddressed, total: clusters.length };
}

/**
 * The "at least 20 expressed" target, reported and never enforced (D-1437): met, or the shortfall with the park reasons
 * (counts) that explain it and the clusters not yet addressed.
 */
export function targetReport(r, target = TARGET_EXPRESSED) {
  const reasons = Object.fromEntries(
    Object.entries(r.parked)
      .filter(([, l]) => l.length > 0)
      .map(([k, l]) => [k, l.length]),
  );
  const expressed = r.expressed.length;
  return {
    target,
    expressed,
    met: expressed >= target,
    shortfall: Math.max(0, target - expressed),
    reasons,
    unaddressed: r.unaddressed.length,
  };
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} _env
 * @param {{ out?: (s: string) => void, schema?: { validateExpressedRule: (r: unknown) => string[], validateExpressionExit: (r: unknown) => string[] }, allowInsideRepo?: boolean }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, _env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const dir = arg(argv, "--seed");
  if (!dir) {
    out("express check: failed (usage: --seed <seed-folder>)");
    return 1;
  }
  if (!deps.allowInsideRepo && insideRepo(dir)) {
    out(
      "express check: failed (the seed folder must be outside the repository; it is private data)",
    );
    return 1;
  }
  if (!existsSync(dir)) {
    out("express check: failed (seed folder not found)");
    return 1;
  }
  const loaded = loadSeed(dir);
  if (!loaded.ok) {
    out(`express check: rejected (${loaded.errors.length} schema errors)`);
    for (const m of loaded.errors) out(`  ${m}`);
    return 1;
  }
  if (loaded.data["expressions.json"] === undefined) {
    out("express check: failed (expressions.json is missing; the seed needs format 2)");
    return 1;
  }
  const schema = deps.schema ?? (await defaultSchema());
  const r = checkExpressions(loaded.data, schema);
  if (r.errors.length > 0) {
    out(`express check: rejected (${r.errors.length} errors)`);
    for (const m of r.errors) out(`  ${m}`);
    return 1;
  }
  const parkedCount = Object.values(r.parked).reduce((a, l) => a + l.length, 0);
  const report = targetReport(r);
  const byReason = report.reasons;
  out(
    `express check (${loaded.data["manifest.json"].market}): clusters ${r.total}; expressed ${r.expressed.length}; parked ${parkedCount} ${JSON.stringify(byReason)}; not yet addressed ${r.unaddressed.length}`,
  );
  out(
    report.met
      ? `target of ${TARGET_EXPRESSED} expressed: met`
      : `target of ${TARGET_EXPRESSED} expressed: short by ${report.shortfall}; the rest are parked with the reasons above, nothing is forced`,
  );
  out(`expressed: ${r.expressed.join(" ") || "none"}`);
  for (const [reason, ids] of Object.entries(r.parked)) {
    if (ids.length > 0) out(`parked ${reason}: ${ids.join(" ")}`);
  }
  if (r.unaddressed.length > 0) out(`not yet addressed: ${r.unaddressed.join(" ")}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
