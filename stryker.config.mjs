// StrykerJS mutation testing (M8 T12; docs/M8_design.md 2.8, decisions 12 and 22; TST-130, AT-31).
// Weekly (.github/workflows/mutation.yml), never per PR. Scope = the decision-12 groups: money maths,
// validation statistics and the rule interpreter. The score floor is TST-130's "surviving-mutant
// score >= 80 %" (`mutation_score_min`): `thresholds.break` makes Stryker exit non-zero below it and
// scripts/ci/mutation-summary.mjs reads the same number for the job summary.
//
// NOT INSTALLED YET: this file is ready for @stryker-mutator/core and @stryker-mutator/vitest-runner
// (Apache-2.0, dev-only, never shipped). Adding them to package.json waits for the Owner's approval
// (decision 22, as for Lighthouse in D-153); the workflow refuses to run until they are installed.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.mts" },
  mutate: [
    // money maths
    "src/lib/money/**/*.ts",
    "src/lib/arena/{fills,costs,slippage,ledger,nav,sleeve,sizing,terminal,corpActions,recost,invariants}.ts",
    // validation statistics
    "src/lib/stats/**/*.ts",
    "src/lib/replay/{cif,scorecards}.ts",
    // rule interpreter
    "src/lib/agents/families/**/*.ts",
    "src/lib/agents/{candidates,params}.ts",
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
