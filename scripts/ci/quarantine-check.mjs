// TST-131 (M8 T3): flaky-test quarantine record. `tests/quarantine.json` lists tests that are
// quarantined (still run nightly, listed in the job summary). Each entry needs a reason, an owner and
// an expiry no more than 30 days after it was added; an expired entry fails the check, so a
// quarantine can never become a silent skip (AGENT_PLAN section 6).
// Shape: { "quarantined": [{ "test": "tests/x.test.ts::name", "reason": "...", "owner": "...",
//                            "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD" }] }
// Usage: node scripts/ci/quarantine-check.mjs [--file <path>] [--today YYYY-MM-DD] [--root <dir>]
// Output: one line per finding plus a list of quarantined tests. Exit 1 on any finding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_DAYS = 30;
const DAY_MS = 86_400_000;

function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

/** Returns an array of finding strings; empty means the record is valid. */
export function checkQuarantine(data, { today, root, exists } = {}) {
  const findings = [];
  const now = parseDate(today ?? new Date().toISOString().slice(0, 10));
  if (!data || typeof data !== "object" || !Array.isArray(data.quarantined)) {
    return ['file must be an object with a "quarantined" array'];
  }
  const seen = new Set();
  data.quarantined.forEach((e, i) => {
    const id = `entry ${i + 1}${e && typeof e.test === "string" ? ` (${e.test})` : ""}`;
    if (!e || typeof e !== "object") return findings.push(`${id}: not an object`);
    for (const k of ["test", "reason", "owner"]) {
      if (typeof e[k] !== "string" || e[k].trim() === "") findings.push(`${id}: missing ${k}`);
    }
    if (typeof e.test === "string") {
      if (seen.has(e.test)) findings.push(`${id}: duplicate`);
      seen.add(e.test);
      const file = e.test.split("::")[0];
      if (exists && file && !exists(path.join(root ?? ".", file))) {
        findings.push(`${id}: test file ${file} does not exist`);
      }
    }
    const added = parseDate(e.added);
    const expires = parseDate(e.expires);
    if (added === null) findings.push(`${id}: added must be a YYYY-MM-DD date`);
    if (expires === null) findings.push(`${id}: expires must be a YYYY-MM-DD date`);
    if (added !== null && expires !== null) {
      if (expires < added) findings.push(`${id}: expires is before added`);
      else if ((expires - added) / DAY_MS > MAX_DAYS) {
        findings.push(`${id}: expiry is more than ${MAX_DAYS} days after it was added`);
      }
    }
    if (expires !== null && now !== null && expires < now) {
      findings.push(`${id}: expired on ${e.expires}; fix the test or renew with a new reason`);
    }
  });
  return findings;
}

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(
    arg("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
  const file = arg("--file") ?? path.join(root, "tests", "quarantine.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`quarantine-check: cannot read ${file}: ${err.message}`);
    return 1;
  }
  const findings = checkQuarantine(data, { today: arg("--today"), root, exists: fs.existsSync });
  const n = data?.quarantined?.length ?? 0;
  console.log(`Quarantined tests: ${n}`);
  for (const e of data?.quarantined ?? [])
    console.log(`- ${e.test} (owner ${e.owner}, expires ${e.expires})`);
  for (const f of findings) console.error(`FAIL ${f}`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
