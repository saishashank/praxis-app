// Seed call proposals (M22 E3; KB-084, D-1435, D-543). Owner-run on the build machine:
//   node scripts/experts/call-proposals.mjs --seed <seed-folder> --dry-run   # counts only, writes nothing
//   node scripts/experts/call-proposals.mjs --seed <seed-folder>             # writes call-proposals.json beside the seed
// Re-extracts a proposal for every claim of type `call` in the private seed (`claims.json`) with the deterministic rules
// of `src/lib/experts/callEngine.mjs` (no model, no network, no database). The codes it may find are those of
// `calls.json` (when the seed has one) and of an optional `--universe <file>` (a JSON list or one code per line). The
// folder is private data and must lie OUTSIDE this repository (SEC-110): nothing about a claim reaches the repository,
// a log or the screen; the screen gets counts only.
//
// `call-proposals.json` (format `praxis-call-proposals/1`): { format, market, created_at, proposals: [ { claim_id, state,
//   code|null, direction|null, call_d|null, horizon_sessions|null, price_basis, target_micro|null, stop_micro|null,
//   missing[], reason } ] }. The importer (format 2) loads it as proposals of source `rules`; a proposal is never a
// call: only the Owner confirmation or a `calls.json` row (the seed structured call) writes `expert_call`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proposeCallStructure } from "../../src/lib/experts/callEngine.mjs";
import { insideRepo } from "./licence-check.mjs";

export const FORMAT = "praxis-call-proposals/1";
export const OUT_FILE = "call-proposals.json";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

/** The codes of a universe file: a JSON array of strings, or one code per line. */
export function codesOfFile(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch {
    // not JSON: one code per line
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/** The call claims of the seed as `{ id, statement }`; a malformed row is skipped, never echoed. */
export function callClaimsOf(json) {
  const list = json && Array.isArray(json.claims) ? json.claims : [];
  return list
    .filter(
      (c) => c && c.type === "call" && typeof c.id === "string" && typeof c.statement === "string",
    )
    .map((c) => ({ id: c.id, statement: c.statement }));
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} _env
 * @param {{ out?: (s: string) => void, now?: () => Date, allowInsideRepo?: boolean }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, _env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const dir = arg(argv, "--seed");
  const dry = argv.includes("--dry-run");
  if (!dir) {
    out("call proposals: failed (usage: --seed <seed-folder> [--dry-run] [--universe <file>])");
    return 1;
  }
  if (!deps.allowInsideRepo && insideRepo(dir)) {
    out(
      "call proposals: failed (the seed folder must be outside the repository; it is private data)",
    );
    return 1;
  }
  const claimsFile = path.join(dir, "claims.json");
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(claimsFile) || !existsSync(manifestFile)) {
    out("call proposals: failed (claims.json or manifest.json not found in the seed folder)");
    return 1;
  }
  let claims;
  let market;
  const codes = new Set();
  let structured = new Set();
  try {
    claims = callClaimsOf(readJson(claimsFile));
    market = readJson(manifestFile).market;
    if (typeof market !== "string" || market === "") throw new Error("market");
    const callsFile = path.join(dir, "calls.json");
    if (existsSync(callsFile)) {
      const calls = readJson(callsFile).calls ?? [];
      structured = new Set(calls.map((c) => c.claim_id).filter((x) => typeof x === "string"));
      for (const c of calls)
        if (typeof c.code === "string" && c.market === market) codes.add(c.code);
    }
    const uni = arg(argv, "--universe");
    if (uni) for (const c of codesOfFile(readFileSync(uni, "utf8"))) codes.add(c);
  } catch {
    out("call proposals: failed (a seed file or the universe file is not readable)");
    return 1;
  }
  const universe = { market, codes };
  const by = { complete: 0, incomplete: 0, not_trackable: 0 };
  const missing = { code: 0, direction: 0, date: 0, horizon: 0 };
  const proposals = [];
  for (const c of claims) {
    const p = proposeCallStructure(c.statement, universe, []);
    by[p.state] += 1;
    for (const f of p.missing) missing[f] += 1;
    proposals.push({
      claim_id: c.id,
      state: p.state,
      code: p.code,
      direction: p.direction,
      call_d: p.callD,
      horizon_sessions: p.horizonSessions,
      price_basis: p.priceBasis,
      target_micro: p.targetMicro,
      stop_micro: p.stopMicro,
      missing: p.missing,
      reason: p.reason,
    });
  }
  const own = claims.filter((c) => structured.has(c.id)).length;
  let line =
    `call proposals: ${claims.length} call claims, ${by.complete} complete, ${by.incomplete} incomplete ` +
    `(missing: ${JSON.stringify(missing)}), ${by.not_trackable} not trackable; ${own} already structured in calls.json`;
  if (dry) {
    out(`${line}; dry run, nothing written`);
    return 0;
  }
  const body = {
    format: FORMAT,
    market,
    created_at: (deps.now ?? (() => new Date()))().toISOString(),
    proposals,
  };
  writeFileSync(path.join(dir, OUT_FILE), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  line += `; wrote ${OUT_FILE} beside the seed`;
  out(line);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
