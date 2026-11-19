// Golden-set spot check (TST-137, D-969; the measurement side of CXA-008, whose threshold logic is M23).
// The Owner re-labels 20 random items and sees how often the stored label agrees.
//   node scripts/cortex/golden-spot-check.mjs [--db <file|url>] [--seed N] [--n 20] [--template <file>]
//        [--answers <file>] [--date YYYY-MM-DD]
//   1. Draw: `--seed N` (default 1) picks n rows of the `label` table by a stable hash, so the same seed on the
//      same table gives the same rows. The table shows execution, rule version, variant and day, NOT the stored
//      label (the check is blind); `--template <file>` writes the answers file to fill in ({"<id>": ""}).
//   2. Answer: the Owner writes the label they would give each row into the file (one of the eight label words).
//   3. Measure: `--answers <file>` prints the agreement (percent and counts) and Cohen's kappa, and writes ONE
//      run_record `golden-spot-check:<date>` (job golden-spot-check) with those numbers. Measurement only: no
//      threshold, nothing blocks.
// Read-only apart from that one run record. Without --db it uses TURSO_MAIN_URL / TURSO_MAIN_TOKEN. Output:
// ids, words and counts only: never a secret, a URL or a driver error. Exit 0 done, 1 failed, 2 usage.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";

export const LABELS = [
  "UNVALIDATED",
  "PASSED-BACKTEST",
  "CONSISTENT-FORWARD",
  "FAILED",
  "NOT-DEMONSTRATED",
  "UNVALIDATABLE",
  "insufficient evidence",
  "possible luck",
];
export const DEFAULT_N = 20; // threshold-ok: CXA-008 / TST-137 "20 random items"
const JOB = "golden-spot-check";

/** The n rows with the smallest sha256(seed|id), ties by id: stable for a seed, independent of row order. */
export function drawRows(rows, seed, n = DEFAULT_N) {
  const key = (r) => createHash("sha256").update(`${seed}|${r.id}`).digest("hex");
  return [...rows]
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.r.id < b.r.id ? -1 : 1))
    .slice(0, n)
    .map((x) => x.r);
}

/** Share of equal pairs, as { agree, total, pct (one decimal) }. */
export function agreement(pairs) {
  const total = pairs.length;
  const agree = pairs.filter(([a, b]) => a === b).length;
  return { agree, total, pct: total === 0 ? 0 : Math.round((agree / total) * 1000) / 10 };
}

/** Cohen's kappa of [owner, stored] pairs, 3 decimals; null when chance agreement is 1 (no spread to judge). */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const ca = new Map();
  const cb = new Map();
  for (const [a, b] of pairs) {
    ca.set(a, (ca.get(a) ?? 0) + 1);
    cb.set(b, (cb.get(b) ?? 0) + 1);
  }
  let pe = 0;
  for (const [k, v] of ca) pe += (v / n) * ((cb.get(k) ?? 0) / n);
  if (1 - pe < 1e-12) return null;
  return Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
}

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ out?: (s: string) => void, nowMs?: () => number }} deps
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const seed = Number(flag(argv, "--seed") ?? 1);
  const n = Number(flag(argv, "--n") ?? DEFAULT_N);
  if (!Number.isInteger(seed) || !Number.isInteger(n) || n < 1 || n > 200) {
    out(
      "golden-spot-check: usage [--db <file|url>] [--seed N] [--n 1..200] [--template F] [--answers F]",
    );
    return 2;
  }
  const dbArg = flag(argv, "--db");
  const url =
    dbArg === null
      ? env.TURSO_MAIN_URL
      : /^[a-z]+:\/\//i.test(dbArg)
        ? dbArg
        : pathToFileURL(path.resolve(dbArg)).href;
  if (typeof url !== "string" || url === "") {
    out("golden-spot-check: failed (no database: pass --db or set TURSO_MAIN_URL)");
    return 1;
  }
  const db = createClient({ url, authToken: dbArg === null ? env.TURSO_MAIN_TOKEN : undefined });
  try {
    // rows-ok: the label table holds one row per (execution, rule version, variant, day): hundreds, read once
    const r = await db.execute(
      "SELECT id, execution_id, rule_version, variant, label, d FROM label ORDER BY id",
    );
    const rows = r.rows.map((x) => ({
      id: String(x.id),
      execution: String(x.execution_id),
      ruleVersion: String(x.rule_version),
      variant: String(x.variant),
      label: String(x.label),
      d: String(x.d),
    }));
    if (rows.length === 0) {
      out("golden-spot-check: there are no labels yet, nothing to draw");
      return 0;
    }
    const drawn = drawRows(rows, seed, n);
    const template = flag(argv, "--template");
    const answers = flag(argv, "--answers");
    if (answers === null) {
      out(`golden-spot-check: ${drawn.length} of ${rows.length} labels drawn, seed ${seed}`);
      out("id | execution | rule version | variant | day | your label");
      for (const x of drawn)
        out(`${x.id} | ${x.execution} | ${x.ruleVersion} | ${x.variant} | ${x.d} | ?`);
      out(`Labels you may write: ${LABELS.join(", ")}`);
      if (template !== null) {
        writeFileSync(
          template,
          `${JSON.stringify(Object.fromEntries(drawn.map((x) => [x.id, ""])), null, 2)}\n`,
        );
        out(
          `golden-spot-check: answers template written (fill it in, then run again with --answers)`,
        );
      }
      return 0;
    }
    let given;
    try {
      given = JSON.parse(readFileSync(answers, "utf8"));
    } catch {
      out("golden-spot-check: failed (the answers file is not readable JSON)");
      return 1;
    }
    const pairs = [];
    let unanswered = 0;
    for (const x of drawn) {
      const a = given?.[x.id];
      if (typeof a === "string" && LABELS.includes(a.trim())) pairs.push([a.trim(), x.label]);
      else unanswered += 1;
    }
    const ag = agreement(pairs);
    const kappa = cohenKappa(pairs);
    out(
      `golden-spot-check: agreement ${ag.pct} % (${ag.agree} of ${ag.total} answered), kappa ${kappa === null ? "n/a" : kappa.toFixed(3)}, unanswered ${unanswered}, seed ${seed}`,
    );
    out("Measurement only: the CXA-008 thresholds are applied in M23.");
    const d = flag(argv, "--date") ?? new Date(nowMs()).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      out("golden-spot-check: failed (--date is YYYY-MM-DD)");
      return 2;
    }
    const at = new Date(nowMs()).toISOString();
    const w = await db.execute({
      sql: `INSERT OR IGNORE INTO run_record (job, market, concurrency_key, started_at, ended_at, status, items_processed, details_json)
            VALUES (?, NULL, ?, ?, ?, 'success', ?, ?)`,
      args: [
        JOB,
        `${JOB}:${d}`,
        at,
        at,
        ag.total,
        JSON.stringify({
          seed,
          drawn: drawn.length,
          answered: ag.total,
          agree: ag.agree,
          agreement_pct: ag.pct,
          kappa: kappa,
          unanswered,
        }),
      ],
    });
    out(
      w.rowsAffected > 0
        ? `golden-spot-check: recorded ${JOB}:${d}`
        : `golden-spot-check: ${JOB}:${d} was already recorded; nothing written`,
    );
    return 0;
  } catch {
    out("golden-spot-check: failed (query error)");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
