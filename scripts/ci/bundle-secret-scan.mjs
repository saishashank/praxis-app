// AT-03 / SEC-101: no server-only secret name may appear in the client bundle.
// Scans .next/static/** (everything served to browsers). Zero dependencies.
// Usage: node scripts/ci/bundle-secret-scan.mjs [dir]   (default .next/static)
// Output never includes file contents, only file path and the variable name.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_NAMES = [
  "AUTH_SECRET",
  "CRON_SECRET",
  "PII_HASH_KEY",
  "ACTIONS_HMAC_SECRET",
  "TEST_IDENTITY_SECRET",
  "TURSO_",
  "RESEND_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_READ_TOKEN",
  "AUTH_GOOGLE_SECRET",
];

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
