// UXN-019: third-party licence allow-list (M7 design decision 60). Check only, zero dependencies.
// Reads package-lock.json (production packages only: no dev / devOptional) and, where a package is
// installed, its package.json licence. Fails on a licence outside the allow-list or an unknown
// licence, unless the Owner listed the package in scripts/ci/licence-exceptions.json.
// The Settings -> About notices are generated elsewhere (scripts/gen-notices.mjs).
// Usage: node scripts/ci/licence-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ALLOWED = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "MPL-2.0",
  "OFL-1.1",
];

/** Normalise a licence string / legacy object / array into one SPDX-like expression, or "". */
export function normaliseLicence(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim().replace(/^\((.*)\)$/, "$1");
  if (Array.isArray(raw)) {
    return raw.map(normaliseLicence).filter(Boolean).join(" OR ");
  }
  if (typeof raw === "object" && typeof raw.type === "string") return raw.type.trim();
  return "";
}

/** True when an SPDX expression is acceptable: OR needs one allowed branch, AND needs all. */
export function isAllowed(expression, allowed = ALLOWED) {
  const expr = normaliseLicence(expression);
  if (!expr) return false;
  if (/\bWITH\b/.test(expr)) return false;
  const set = new Set(allowed);
  return expr.split(/\s+OR\s+/i).some((alt) =>
    alt
      .replace(/[()]/g, " ")
      .split(/\s+AND\s+/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .every((id) => set.has(id)),
  );
}

/** Package name from a lockfile key such as node_modules/@a/b or node_modules/x/node_modules/y. */
export function nameFromKey(key) {
  const i = key.lastIndexOf("node_modules/");
  return i < 0 ? key : key.slice(i + "node_modules/".length);
}

/** Production packages from a lockfile object: [{ name, version, licence, key }]. */
export function productionPackages(lock, readInstalled = () => null) {
  const out = [];
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || v.dev || v.devOptional) continue;
    const name = v.name ?? nameFromKey(key);
    const installed = readInstalled(key);
    const licence = normaliseLicence(installed?.license ?? installed?.licenses ?? v.license);
    out.push({ name, version: v.version ?? installed?.version ?? "", licence, key });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Returns { failures, exceptionsUsed }. Unknown licence is a failure unless excepted. */
export function evaluate(packages, exceptions = [], allowed = ALLOWED) {
  const failures = [];
  const exceptionsUsed = [];
  for (const p of packages) {
    if (isAllowed(p.licence, allowed)) continue;
    const ex = exceptions.find(
      (e) => e.package === p.name && (!e.licence || e.licence === p.licence),
    );
    if (ex) {
      exceptionsUsed.push({ ...p, approvedBy: ex.approvedBy, date: ex.date });
      continue;
    }
    failures.push({ ...p, reason: p.licence ? "not on the allow-list" : "unknown licence" });
  }
  return { failures, exceptionsUsed };
}

function readInstalledFactory(root) {
  return (key) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, key, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };
}

export function run({ root = ROOT } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  let exceptions = [];
  const exFile = path.join(root, "scripts/ci/licence-exceptions.json");
  if (fs.existsSync(exFile)) {
    exceptions = JSON.parse(fs.readFileSync(exFile, "utf8")).exceptions ?? [];
  }
  const packages = productionPackages(lock, readInstalledFactory(root));
  const { failures, exceptionsUsed } = evaluate(packages, exceptions);
  return { packages, failures, exceptionsUsed };
}

function main() {
  const { packages, failures, exceptionsUsed } = run();
  console.log(
    `licence-check: ${packages.length} production packages, ${exceptionsUsed.length} Owner exceptions`,
  );
  if (failures.length) {
    for (const f of failures) {
      console.error(`FAIL ${f.name}@${f.version}  ${f.licence || "(none)"}  ${f.reason}`);
    }
    console.error(
      "Add an Owner-approved entry to scripts/ci/licence-exceptions.json or remove the dependency.",
    );
    process.exit(1);
  }
  console.log("licence-check: all production licences are allowed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
