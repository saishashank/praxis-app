// AT-03 / SEC-101: no server-only secret name may appear in the client bundle.
// Scans .next/static/** (everything served to browsers). Zero dependencies.
// Usage: node scripts/ci/bundle-secret-scan.mjs [dir]   (default .next/static)
// Output never includes file contents, only file path and the variable name.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSecrets } from "../architecture/readers.mjs";

// V1-I12 / D-786: the list is DERIVED from the secrets registry (src/lib/security/secretStores.ts,
// the same names allNames() returns) so a new secret is covered the day it is registered. The
// hand-kept entries below are only what the registry cannot express: the TURSO_ prefix (URLs and
// tokens of every database) and names that are secrets but are not held in a store row.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EXTRA_FORBIDDEN = ["TURSO_", "OWNER_RECOVERY_EMAIL"];

export function registryNames(root = REPO_ROOT) {
  return readSecrets(root).map((s) => s.name);
}

const ALL = [...new Set([...registryNames(), ...EXTRA_FORBIDDEN])];
// A name that contains another listed name adds nothing (substring scan) and would double-report.
export const FORBIDDEN_NAMES = ALL.filter((n) => !ALL.some((m) => m !== n && n.includes(m)));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Returns [{ file, name }] for each forbidden name found in each file under dir. */
export function scanDir(dir, names = FORBIDDEN_NAMES) {
  const hits = [];
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, "latin1");
    for (const name of names) {
      if (text.includes(name)) hits.push({ file: path.relative(dir, file), name });
    }
  }
  return hits;
}

function main() {
  const dir = path.resolve(process.argv[2] ?? path.join(".next", "static"));
  if (!fs.existsSync(dir)) {
    console.error(`bundle-secret-scan: ${dir} not found (run npm run build first)`);
    process.exit(1);
  }
  const hits = scanDir(dir);
  if (hits.length > 0) {
    for (const h of hits) console.error(`bundle-secret-scan: ${h.name} appears in ${h.file}`);
    console.error(`bundle-secret-scan: FAILED (${hits.length} hit(s))`);
    process.exit(1);
  }
  console.log(`bundle-secret-scan: ok (${walk(dir).length} client files, no forbidden names)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
