import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

// D-1854: the test set of the weekly mutation run (stryker.config.mjs, TST-130, AT-31). Stryker's dry run
// first runs every test it is given. With its default "related" set that was nearly the whole suite (the
// mutated parameter registry is imported almost everywhere), which never finished inside the dry-run
// limit, so every weekly run since 24 Oct 2026 failed before the first mutant. This list is the unit tests
// of the mutated modules only. The database writer, replay-parity and acceptance tests (13 s to 215 s a
// file) are left to the normal suite: each mutant would rerun them. A new unit test of a mutated module
// is added here; scripts/ci/mutation-config.test.mjs checks that every listed file exists.
export const MUTATION_TESTS = [
  // money maths
  "tests/money/money.test.ts",
  "tests/money/tick.in.test.ts",
  "tests/arena/corpActions.test.ts",
  "tests/arena/cohort.test.ts",
  "tests/arena/costs.test.ts",
  "tests/arena/exDividendStop.test.ts",
  "tests/arena/fillEntryLimit.test.ts",
  "tests/arena/fills.test.ts",
  "tests/arena/invariants.test.ts",
  "tests/arena/ledger.test.ts",
  "tests/arena/ledgerProperty.test.ts",
  "tests/arena/marketThreading.test.ts",
  "tests/arena/nav.test.ts",
  "tests/arena/profileParams.test.ts",
  "tests/arena/recost.test.ts",
  "tests/arena/settlement.t1.test.ts",
  "tests/arena/sizing.test.ts",
  "tests/arena/sleeve.test.ts",
  "tests/arena/slippage.markets.test.ts",
  "tests/arena/slippage.test.ts",
  "tests/arena/terminal.test.ts",
  "tests/arena/tst101.test.ts",
  // validation statistics
  "tests/replay/cif.test.ts",
  "tests/replay/controlLibrary.test.ts",
  "tests/replay/costGateParity.test.ts",
  "tests/replay/exDividendParity.test.ts",
  "tests/replay/ledger.test.ts",
  "tests/replay/pickHistory.test.ts",
  "tests/replay/replayStats.test.ts",
  "tests/replay/returns.test.ts",
  "tests/replay/scorecards.test.ts",
  "tests/stats/errorBudget.test.ts",
  "tests/stats/harami.test.ts",
  "tests/stats/killSwitch.test.ts",
  "tests/stats/m15/breakEven.test.ts",
  "tests/stats/m15/calibration.test.ts",
  "tests/stats/m15/cells.test.ts",
  "tests/stats/m15/distinctness.test.ts",
  "tests/stats/m15/multiplicity.test.ts",
  "tests/stats/m15/nulls.test.ts",
  "tests/stats/m15/stationaryBootstrap.test.ts",
  "tests/stats/rankIc.test.ts",
  "tests/stats/rankScore.test.ts",
  "tests/stats/studentT.test.ts",
  // rule interpreter (the families)
  "tests/agents/families/f1f2f3.test.ts",
  "tests/agents/families/f4f5.test.ts",
  "tests/agents/families/f6common.test.ts",
  "tests/agents/families/m14Variants.test.ts",
  "tests/agents/families/rankVariants.test.ts",
  "tests/agents/families/ruleSchemaV2.test.ts",
  "tests/agents/families/targetExit.test.ts",
  "tests/agents/families/targetRebase.test.ts",
];

// The same alias, environment and setup as vitest.config.mts (copied, as vitest.timing.config.mts does:
// a config cannot import another .mts under the typecheck), with the list as the include.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "jsdom",
    include: MUTATION_TESTS,
    exclude: [...configDefaults.exclude],
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.mts"],
    // Instrumented code runs several times slower: the heavy statistics tests (the AR(1) bootstrap)
    // pass the suite limit of 30 s only uninstrumented.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // D-1855: one plain reporter. On GitHub vitest otherwise adds its "github-actions" reporter, which
    // appends a job summary on every one of Stryker's ~15,000 runs (1.4 MB, over GitHub's 1 MB limit).
    reporters: ["dot"],
  },
});
