// TST-120 (M8 T3): diff-coverage gate. Fails when the changed (added) lines of executable source
// have < diff_coverage_min lines covered (default 90) or < diff_branch_min branches covered
// (default 80), measured from one coverage report (unit + integration tests merged).
// Inputs: an lcov file (`--lcov`) or an istanbul `coverage-final.json` (`--json`), and a unified
// diff (`--diff <file>`, or `--base <ref>` to run `git diff -U0 <ref>...HEAD`).
// A json-summary file has no per-line data, so it cannot be used for changed-line coverage.
// A diff with no executable changed line (docs, config text, tests only) passes: TST-120 exemption.
// A changed source file with no coverage record at all counts as a failure, because
// "no record" means no test loads it.
// Usage: node scripts/ci/diff-coverage.mjs --lcov coverage/lcov.info --base origin/main
//        [--root <dir>] [--lines 90] [--branches 80] [--include src/,worker/src/]
// Output: per-file and total counts, never file contents. Exit 1 below threshold.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LINES = 90;
export const DEFAULT_BRANCHES = 80;
export const DEFAULT_INCLUDE = ["src/", "worker/src/"];
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Added line numbers per file from a unified diff. */
export function parseDiff(text) {
  const out = new Map();
  let file = null;
  let next = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : norm(p.replace(/^b\//, ""));
      if (file && !out.has(file)) out.set(file, new Set());
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      next = m ? Number(m[1]) : 0;
    } else if (file && line.startsWith("+")) {
      out.get(file).add(next++);
    } else if (file && line.startsWith(" ")) {
      next++;
    }
  }
  return out;
}

const rel = (p, root) => {
  const n = norm(p);
  const r = norm(root);
  return r && n.startsWith(`${r}/`) ? n.slice(r.length + 1) : n;
};

/** lcov text to Map<file, {lines: Map<line, hits>, branches: Map<line, boolean[]>}>. */
export function parseLcov(text, root = "") {
  const out = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = { lines: new Map(), branches: new Map() };
      out.set(rel(line.slice(3), root), cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      cur.lines.set(Number(n), Number(hits));
    } else if (line.startsWith("BRDA:")) {
      const [n, , , taken] = line.slice(5).split(",");
      const arr = cur.branches.get(Number(n)) ?? [];
      arr.push(taken !== "-" && Number(taken) > 0);
      cur.branches.set(Number(n), arr);
    } else if (line === "end_of_record") {
      cur = null;
    }
  }
  return out;
}

/** istanbul coverage-final.json to the same shape as parseLcov. */
export function parseIstanbul(json, root = "") {
  const out = new Map();
  for (const [file, f] of Object.entries(json)) {
    const cur = { lines: new Map(), branches: new Map() };
    for (const [id, loc] of Object.entries(f.statementMap ?? {})) {
      const n = loc.start.line;
      cur.lines.set(n, Math.max(cur.lines.get(n) ?? 0, f.s[id]));
    }
    for (const [id, b] of Object.entries(f.branchMap ?? {})) {
      const n = b.loc?.start?.line ?? b.locations?.[0]?.start?.line;
      const arr = cur.branches.get(n) ?? [];
      for (const hits of f.b[id] ?? []) arr.push(hits > 0);
      cur.branches.set(n, arr);
    }
    out.set(rel(file, root), cur);
  }
  return out;
}

/**
 * Computes changed-line coverage. `changed` is Map<file, Set<line>>, `cov` is a parsed report.
 * Returns {files, lines:{covered,total}, branches:{covered,total}, missing:[files without record]}.
 */
export function measure(changed, cov, { include = DEFAULT_INCLUDE } = {}) {
  const res = {
    files: [],
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    missing: [],
  };
  for (const [file, set] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    // type-declaration files (.d.ts, .d.mts, .d.cts) hold no runtime code, so no test can cover them
    if (!SOURCE_EXT.test(file) || /\.d\.[cm]?ts$/.test(file) || /\.(?:test|spec)\./.test(file))
      continue;
    if (!include.some((p) => file.startsWith(p))) continue;
    const c = cov.get(file);
    if (!c) {
      res.missing.push(file);
      continue;
    }
    const f = { file, lc: 0, lt: 0, bc: 0, bt: 0 };
    for (const n of set) {
      if (c.lines.has(n)) {
        f.lt++;
        if (c.lines.get(n) > 0) f.lc++;
      }
      for (const taken of c.branches.get(n) ?? []) {
        f.bt++;
        if (taken) f.bc++;
      }
    }
    if (f.lt || f.bt) res.files.push(f);
    res.lines.covered += f.lc;
    res.lines.total += f.lt;
    res.branches.covered += f.bc;
    res.branches.total += f.bt;
  }
  return res;
}

const pct = (c, t) => (t === 0 ? 100 : (c / t) * 100);

/** Returns {ok, findings, summary} for a measure() result. */
export function evaluate(m, { lines = DEFAULT_LINES, branches = DEFAULT_BRANCHES } = {}) {
  const findings = [];
  const lp = pct(m.lines.covered, m.lines.total);
  const bp = pct(m.branches.covered, m.branches.total);
  if (lp < lines) findings.push(`changed lines ${lp.toFixed(1)}% covered, need ${lines}%`);
  if (bp < branches) findings.push(`changed branches ${bp.toFixed(1)}% covered, need ${branches}%`);
  for (const f of m.missing)
    findings.push(`${f}: changed source file has no coverage record (no test loads it)`);
  const summary = [
    ...m.files.map((f) => `${f.file}: lines ${f.lc}/${f.lt}, branches ${f.bc}/${f.bt}`),
    `total: lines ${m.lines.covered}/${m.lines.total} (${lp.toFixed(1)}%), branches ${m.branches.covered}/${m.branches.total} (${bp.toFixed(1)}%)`,
  ];
  return { ok: findings.length === 0, findings, summary };
}

function main(argv) {
  // The LAST occurrence wins, so `npm run test:diffcov -- --base <ref>` overrides the script defaults.
  const arg = (n) => {
    const i = argv.lastIndexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(arg("--root") ?? process.cwd());
  try {
    let diffText;
    if (arg("--diff")) diffText = fs.readFileSync(arg("--diff"), "utf8");
    else if (arg("--base")) {
      diffText = execFileSync("git", ["diff", "-U0", "--no-color", `${arg("--base")}...HEAD`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
    } else throw new Error("give --diff <file> or --base <ref>");
    let cov;
    if (arg("--lcov")) cov = parseLcov(fs.readFileSync(arg("--lcov"), "utf8"), root);
    else if (arg("--json"))
      cov = parseIstanbul(JSON.parse(fs.readFileSync(arg("--json"), "utf8")), root);
    else throw new Error("give --lcov <file> or --json <coverage-final.json>");
    const m = measure(parseDiff(diffText), cov, {
      include: arg("--include") ? arg("--include").split(",") : DEFAULT_INCLUDE,
    });
    const r = evaluate(m, {
      lines: Number(arg("--lines") ?? process.env.DIFF_COVERAGE_MIN ?? DEFAULT_LINES),
      branches: Number(arg("--branches") ?? process.env.DIFF_BRANCH_MIN ?? DEFAULT_BRANCHES),
    });
    for (const s of r.summary) console.log(s);
    for (const f of r.findings) console.error(`FAIL ${f}`);
    return r.ok ? 0 : 1;
  } catch (err) {
    console.error(`diff-coverage: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
