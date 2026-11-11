// Generates the market profile fixtures tests/market/profiles/<CODE>.json from the seed modules (M19 A1; TST-139,
// D-970, D-1001): the fixture IS the seed (a seed edit without a fixture edit fails `--check`), so the test
// matrix (describeEachMarket) runs AU, IN and US from one definition. Usage:
//   node scripts/market/gen-fixtures.mjs           writes the three files
//   node scripts/market/gen-fixtures.mjs --check   exits 1 when a committed file differs from the seed
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SEEDS } from "../../src/lib/market/seed/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "tests", "market", "profiles");

/** The fixture of one seed (the MarketProfileFixture shape of tests/market/profiles/index.ts). */
export function fixtureOf(seed) {
  const v = (n) => seed.fields[n].value;
  const live = seed.enabled === 1;
  return {
    code: seed.code,
    name: seed.name,
    tz: v("tz"),
    decisionTz: v("decision_cutoff").zone,
    openTime: v("session_open"),
    closeTime: v("session_close"),
    cutoffTime: v("decision_cutoff").time,
    currency: v("currency"),
    productionMode: live ? "full" : "off",
    seededMode: seed.mode,
    built: true,
    note: live
      ? "Generated from src/lib/market/seed/AU.mjs (M19 A1): today's constants to the byte; tests/market/profiles.test.ts proves the loaded profile equals it."
      : `Generated from src/lib/market/seed/${seed.code}.mjs (M19 A1): built and off in production (MKT-110); every value is [VERIFY] until M20 (MKT-114).`,
  };
}

const textOf = (seed) => JSON.stringify(fixtureOf(seed), null, 2) + "\n";

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const check = process.argv.includes("--check");
let bad = 0;
if (invoked)
  for (const code of Object.keys(SEEDS).sort()) {
    const file = join(dir, `${code}.json`);
    const text = textOf(SEEDS[code]);
    if (check) {
      let cur = "";
      try {
        cur = readFileSync(file, "utf8");
      } catch {
        /* missing: differs */
      }
      if (cur !== text) {
        console.error(
          `${code}.json differs from its seed: run node scripts/market/gen-fixtures.mjs`,
        );
        bad += 1;
      }
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${file}`);
    }
  }
if (invoked && check) {
  if (bad > 0) process.exit(1);
  console.log("market fixtures match their seeds");
}
