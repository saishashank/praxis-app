// M8 T18 (docs/M8_design.md decision 49; BLD-023, TST-132): CI minutes table.
// Reads the JSON that `gh api repos/<owner>/<repo>/actions/runs --paginate` prints (a file path, or
// stdin when no path or "-" is given) and writes a markdown table per workflow: runs, outcomes,
// wall-clock minutes (run start to last update; an upper-bound estimate of billed minutes, which
// are rounded up per job and not in this API answer) and the per-workflow share.
// No network inside this script: the orchestrator runs `gh api` read-only and pipes the answer in.
// Output: workflow names, counts and minutes only. No URL, user name, branch or commit text.
//   gh api "repos/<owner>/<repo>/actions/runs?per_page=100" --paginate > runs.json
//   node scripts/ci/minutes-table.mjs runs.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MS_PER_MIN = 60_000; // threshold-ok: unit conversion
const SAFE_NAME = /[^\w .()+/#-]/g;

/** Accepts one object, an array of pages or runs, or several objects glued together (gh --paginate). */
export function parseRuns(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const values = [];
  try {
    values.push(JSON.parse(trimmed));
  } catch {
    // gh --paginate prints one JSON object per page, back to back.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    for (let i = 0; i < trimmed.length; i += 1) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          values.push(JSON.parse(trimmed.slice(start, i + 1)));
          start = -1;
        }
      }
    }
    if (depth !== 0 || values.length === 0) throw new Error("input is not JSON from gh api");
  }
  const runs = [];
  const take = (v) => {
    if (Array.isArray(v)) v.forEach(take);
    else if (v && Array.isArray(v.workflow_runs)) runs.push(...v.workflow_runs);
    else if (v && typeof v === "object" && ("run_started_at" in v || "created_at" in v))
      runs.push(v);
  };
  values.forEach(take);
  return runs;
}

const minutesOf = (r) => {
  const a = Date.parse(r.run_started_at ?? r.created_at ?? "");
  const b = Date.parse(r.updated_at ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / MS_PER_MIN;
};

/** Pure: rows per workflow name (completed runs only), sorted by total minutes, plus totals. */
export function buildTable(runs) {
  const by = new Map();
  let skipped = 0;
  let first = null;
  let last = null;
  for (const r of runs) {
    const mins = r.status === "completed" ? minutesOf(r) : null;
    if (mins === null) {
      skipped += 1;
      continue;
    }
    const name = String(r.name ?? r.path ?? "(unnamed)").replace(SAFE_NAME, "?");
    const row = by.get(name) ?? {
      name,
      runs: 0,
      success: 0,
      failure: 0,
      other: 0,
      minutes: 0,
      max: 0,
    };
    row.runs += 1;
    if (r.conclusion === "success") row.success += 1;
    else if (r.conclusion === "failure") row.failure += 1;
    else row.other += 1;
    row.minutes += mins;
    row.max = Math.max(row.max, mins);
    by.set(name, row);
    const t = Date.parse(r.run_started_at ?? r.created_at);
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  const rows = [...by.values()].sort(
    (a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name),
  );
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  const totals = {
    runs: rows.reduce((s, r) => s + r.runs, 0),
    minutes: total,
    skipped,
    from: first === null ? null : new Date(first).toISOString().slice(0, 10),
    to: last === null ? null : new Date(last).toISOString().slice(0, 10),
  };
  return { rows, totals };
}

const f1 = (n) => n.toFixed(1);
const PERCENT = 100; // threshold-ok: percent

export function renderTable({ rows, totals }) {
  const out = [];
  out.push(
    "| Workflow | Runs | Success | Failure | Other | Minutes (wall) | Average | Longest | Share |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const share = totals.minutes > 0 ? `${f1((PERCENT * r.minutes) / totals.minutes)} %` : "n/a";
    out.push(
      `| ${r.name} | ${r.runs} | ${r.success} | ${r.failure} | ${r.other} | ${f1(r.minutes)} | ${f1(r.minutes / r.runs)} | ${f1(r.max)} | ${share} |`,
    );
  }
  out.push(`| **Total** | ${totals.runs} | | | | ${f1(totals.minutes)} | | | |`);
  out.push("");
  const span = totals.from ? `${totals.from} to ${totals.to}` : "no completed runs";
  out.push(
    `Completed runs ${span}; ${totals.skipped} run(s) skipped (not finished or no timestamps). Minutes are wall-clock (start to last update), jobs that run in parallel are not added up, and billing rounds each job up, so billed minutes can be higher.`,
  );
  return out.join("\n");
}

export function main(argv = process.argv.slice(2), readStdin = () => readFileSync(0, "utf8")) {
  const arg = argv[0];
  try {
    const text = arg && arg !== "-" ? readFileSync(arg, "utf8") : readStdin();
    process.stdout.write(`${renderTable(buildTable(parseRuns(text)))}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`minutes-table: ${e instanceof Error ? e.message : "failed"}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main();
