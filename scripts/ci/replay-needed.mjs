// D-905 (Owner 2026-11-09, O-81): the post-deploy full replay runs only when the deploy changed
// code the replay's results depend on. A replay re-runs every strategy over the whole history with
// the new code; a deploy that only changes the website, docs, workflows or tests leaves its
// results the same, and each run reads the whole recent price window from the database.
// Compares the deploy being replayed (CURRENT_SHA) with the approved deploy before it through
// GitHub's compare API (github.token: contents/deployments read; no environment secret).
// Writes `run=true|false` to $GITHUB_OUTPUT. Anything unknown (no earlier deploy, a cut file list,
// an API error) gives run=true: when in doubt the replay runs, as before.
// D-917 (Owner 2026-11-10): a main-database migration counts only when it touches a table that the
// replay-relevant code (REPLAY_PATHS outside the migrations) names; a migration that only adds
// display or tracking tables (quote_latest, pick_portfolio_*) does not re-run every strategy.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Fail, SHA, changedFileDetails, listApprovedShas } from "./approved-commit-core.mjs";

/** Paths whose change can move a replay result (strategy, data shaping, statistics, schema). */
export const REPLAY_PATHS = Object.freeze([
  "src/lib/agents/",
  "src/lib/arena/",
  "src/lib/cortex/",
  "src/lib/replay/",
  "src/lib/stats/",
  "src/lib/learning/",
  "src/lib/money/",
  "src/lib/config/",
  "src/lib/data/backfill/",
  "src/lib/data/calendar.ts",
  "scripts/replay/",
  "db/migrations/main/",
]);

const MIGRATIONS = "db/migrations/main/";
const inPaths = (f) => REPLAY_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));

/**
 * The tables a migration patch touches in its added lines (CREATE/ALTER/DROP TABLE, INSERT INTO,
 * UPDATE, DELETE FROM, an index or trigger ON a table). Empty when none is recognised.
 */
export function migrationTables(patch) {
  const added = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).replace(/--.*$/, ""))
    .join("\n");
  const name = String.raw`["\x60]?([a-z_][a-z0-9_]*)`;
  const patterns = [
    String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + name,
    String.raw`\bALTER\s+TABLE\s+` + name,
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` + name,
    String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+` + name,
    String.raw`\bDELETE\s+FROM\s+` + name,
    String.raw`(?:^|;)\s*UPDATE\s+` + name, // a statement, not "BEFORE UPDATE ON"
    String.raw`\bINDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+` + name,
    String.raw`\bTRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+` +
      name,
  ];
  const out = new Set();
  for (const p of patterns)
    for (const m of added.matchAll(new RegExp(p, "gim"))) out.add(m[1].toLowerCase());
  return [...out];
}

/** Every source file under the replay paths (migrations excluded), read once. */
export function replayCodeText(root = process.cwd()) {
  const parts = [];
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
    else if (/\.(?:ts|tsx|mjs|js|sql|json)$/.test(p)) parts.push(readFileSync(p, "utf8"));
  };
  for (const p of REPLAY_PATHS) if (p !== MIGRATIONS) walk(path.join(root, p));
  return parts.join("\n");
}

/** A table is used by the replay when the replay-relevant code names it as a whole word. */
export function usedIn(text) {
  return (table) => new RegExp(`\\b${table}\\b`).test(text);
}

/**
 * Pure: does this change need a replay? `files` are names or { filename, patch }; null (unknown)
 * means yes. A code file under REPLAY_PATHS always counts. A migration counts when its patch is
 * missing, names no table we can read, or touches a table `usedByReplay` says the replay code names.
 */
export function needsReplay(files, usedByReplay = () => true) {
  if (files === null) return true;
  return files.some((x) => {
    const f = typeof x === "string" ? x : x.filename;
    if (!inPaths(f)) return false;
    if (!f.startsWith(MIGRATIONS)) return true;
    const patch = typeof x === "string" ? null : x.patch;
    if (patch === null) return true;
    const tables = migrationTables(patch);
    return tables.length === 0 || tables.some((t) => usedByReplay(t));
  });
}

/** Returns the process exit code (0 in every handled case; the answer is in the output). */
export async function run(env, fetchImpl, out = console.log) {
  const write = (v, why) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${v}\n`);
    out(`replay-needed: run=${v} (${why})`);
    return 0;
  };
  const current = (env.CURRENT_SHA ?? "").trim();
  if (!SHA.test(current)) return write(true, "no current commit");
  try {
    const shas = await listApprovedShas(fetchImpl, env.GITHUB_TOKEN, env.GITHUB_REPOSITORY, 2);
    const prev = shas.find((s) => s !== current);
    if (prev === undefined) return write(true, "no earlier approved deploy");
    const files = await changedFileDetails(
      fetchImpl,
      env.GITHUB_TOKEN,
      env.GITHUB_REPOSITORY,
      prev,
      current,
    );
    if (files === null) return write(true, "change list unknown");
    let text = null;
    const usedBy = (t) => {
      text ??= replayCodeText(env.REPLAY_ROOT ?? process.cwd());
      return usedIn(text)(t);
    };
    return needsReplay(files, usedBy)
      ? write(true, "replay inputs changed")
      : write(false, `no replay input changed in ${files.length} files`);
  } catch (e) {
    return write(true, e instanceof Fail ? e.message : "request failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run(process.env, fetch));
}
