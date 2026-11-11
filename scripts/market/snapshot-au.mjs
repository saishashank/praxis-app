// M19 integration step 0 (D-1007, CXA-001, A-20): records the AU constants snapshot
// tests/market/au-constants.snapshot.json from the PRE-REFACTOR tree. The constants live in TypeScript modules
// (aliased imports), so the record runs inside vitest (tests/market/auConstants.test.ts, RECORD_AU_SNAPSHOT=1).
// Usage: node scripts/market/snapshot-au.mjs [--check]   (--check runs the equality test without recording)
// The snapshot is never rewritten once the first M19 branch has merged; a diff there is a defect (A-20).
import { spawnSync } from "node:child_process";

const check = process.argv.includes("--check");
const env = { ...process.env };
if (check) delete env.RECORD_AU_SNAPSHOT;
else env.RECORD_AU_SNAPSHOT = "1";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const r = spawnSync(npx, ["vitest", "run", "tests/market/auConstants.test.ts"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
