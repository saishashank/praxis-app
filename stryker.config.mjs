// StrykerJS mutation testing (M8 T12; docs/M8_design.md 2.8, decisions 12 and 22; TST-130, AT-31).
// Weekly (.github/workflows/mutation.yml), never per PR. Scope = the decision-12 groups: money maths,
// validation statistics and the rule interpreter. The score floor is TST-130's "surviving-mutant
// score >= 80 %" (`mutation_score_min`): `thresholds.break` makes Stryker exit non-zero below it and
// scripts/ci/mutation-summary.mjs reads the same number for the job summary.
//
// @stryker-mutator/core and @stryker-mutator/vitest-runner (Apache-2.0, dev-only, never shipped) are in
// devDependencies (decision 22).
//
// D-1854: the dry run (Stryker first runs all its tests once) failed every weekly run since 24 Oct 2026
// with "Initial test run timed out" after the 5-minute default. The vitest runner's "related" set for
// the mutated files was nearly the whole suite, because src/lib/agents/params.ts is imported almost
// everywhere. Now Stryker runs only the unit tests in vitest.mutation.config.mts (`related: false`), with
// a 20-minute dry-run limit. The two loader files src/lib/agents/{candidates,params}.ts left the mutate
// list: AT-31 and docs/M8_design.md 2.8 set the floor on the money and statistics modules, the families
// are the pure rule interpreter, and those two are a database loader and the parameter registry that only
// the database tests reach. They keep their 90 % coverage floor in vitest.config.mts.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.mutation.config.mts", related: false },
  dryRunTimeoutMinutes: 20,
  mutate: [
    // money maths
    "src/lib/money/**/*.ts",
    "src/lib/arena/{fills,costs,slippage,ledger,nav,sleeve,sizing,terminal,corpActions,recost,invariants}.ts",
    // validation statistics
    "src/lib/stats/**/*.ts",
    "src/lib/replay/{cif,scorecards}.ts",
    // rule interpreter
    "src/lib/agents/families/**/*.ts",
  ],
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 90, low: 80, break: 80 },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  timeoutMS: 60000,
  concurrency: 2,
};

export default config;
