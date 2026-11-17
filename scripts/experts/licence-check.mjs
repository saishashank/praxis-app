// First licence check of the expert seed (M22 E1; KB-083, D-1430, D-1431). Owner-run on the build machine:
//   node scripts/experts/licence-check.mjs --seed <seed-folder>
// Reads `experts.json` of the private seed, checks every fetchable source once (robots.txt first, then the terms
// page; manual-only platforms are never fetched) and writes `licence-check.json` BESIDE the seed (inside the seed
// folder). The importer loads that file with actor `import`. Output on screen: counts only, never a name, a handle
// or a URL. The folder is private data and must lie OUTSIDE this repository (SEC-110); nothing about an expert
// reaches the repository, a log or a database from here. No database is opened.
//
// `licence-check.json` (format `praxis-licence-check/1`):
//   { format, checked_at, results: [ { expert_id, source_key, checked_at, terms_url|null,
//     robots allows|disallows|absent|unreachable, summarisation yes|no|unknown, status unchecked|enabled|no,
//     note|null } ] }
// The status is never `owner-accepted-risk`: only the Owner sets that, on the expert page.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExperts } from "../../src/lib/experts/licence/engine.mjs";

export const FORMAT = "praxis-licence-check/1";
export const OUT_FILE = "licence-check.json";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** True when `dir` lies inside the repository (a private seed must not). */
export function insideRepo(dir) {
  const rel = path.relative(REPO_ROOT, path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The experts of the seed that the check reads; a malformed row is skipped, never echoed. */
export function expertsOf(json) {
  const list = json && Array.isArray(json.experts) ? json.experts : [];
  const out = [];
  for (const x of list) {
    if (!x || typeof x.id !== "string") continue;
    if (x.status !== "candidate" && x.status !== "tracked") continue;
    const handles = {};
    if (x.handles && typeof x.handles === "object")
      for (const [k, v] of Object.entries(x.handles)) if (typeof v === "string") handles[k] = v;
    out.push({
      id: x.id,
      platforms: strings(x.platforms),
      handles,
      homeUrls: strings(x.home_urls),
      noFeed: x.no_feed === true,
    });
  }
  return out;
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} _env
 * @param {{ out?: (s: string) => void, fetch?: Function, sleep?: (ms: number) => Promise<void>,
 *   now?: () => Date, allowInsideRepo?: boolean }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, _env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const i = argv.indexOf("--seed");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir || dir.startsWith("--")) {
    out("licence check: failed (usage: --seed <seed-folder>)");
    return 1;
  }
  if (!deps.allowInsideRepo && insideRepo(dir)) {
    out(
      "licence check: failed (the seed folder must be outside the repository; it is private data)",
    );
    return 1;
  }
  const file = path.join(dir, "experts.json");
  if (!existsSync(file)) {
    out("licence check: failed (experts.json not found in the seed folder)");
    return 1;
  }
  let experts;
  try {
    experts = expertsOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    out("licence check: failed (experts.json is not readable JSON)");
    return 1;
  }
  const now = deps.now ?? (() => new Date());
  const doFetch =
    deps.fetch ??
    ((url, init) =>
      fetch(url, {
        headers: init.headers,
        redirect: init.redirect,
        signal: AbortSignal.timeout(20_000),
      })); // threshold-ok: 20 s per request
  const { rows, report } = await checkExperts({
    experts,
    fetch: doFetch,
    sleep: deps.sleep,
    now,
  });
  const body = {
    format: FORMAT,
    checked_at: now().toISOString(),
    results: rows.map((r) => ({
      expert_id: r.expertId,
      source_key: r.sourceKey,
      checked_at: r.checkedAt,
      terms_url: r.termsUrl,
      robots: r.robots,
      summarisation: r.summarisation,
      status: r.status,
      note: r.note,
    })),
  };
  writeFileSync(path.join(dir, OUT_FILE), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const by = { enabled: 0, no: 0, unchecked: 0 };
  for (const r of rows) by[r.status] += 1;
  out(
    `licence check: ${report.sources} sources, ${report.checked} checked (${JSON.stringify(by)}), ` +
      `${report.notFetched} not fetched (manual or no feed address), ${report.capped} left over the request cap; ` +
      `wrote ${OUT_FILE} beside the seed`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
