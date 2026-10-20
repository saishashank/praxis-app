import react from "@vitejs/plugin-react";
import { coverageConfigDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The real "server-only" package throws unless the bundler sets the react-server condition (Next does);
      // tests import server-only loaders directly, so they get the package's own empty marker module.
      "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // Database-backed tests (migrations, replays) need more than the 5 s default on CI runners;
    // one limit for local and CI runs so a slow test cannot pass locally and fail in CI.
    testTimeout: 30_000,
    // Same limit for beforeAll/beforeEach: DB setup hooks hit the 10 s default on a loaded machine.
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Type declaration files hold no executable code.
      exclude: [...coverageConfigDefaults.exclude, "**/*.d.ts", "**/*.d.mts"],
      // TST-121 (M6 T16): 90 % on the lesson engine, set only under --coverage (npm run test:coverage),
      // so the default run stays fast. Weekly mutation testing (TST-130) is a CI job, not a dev dependency here.
      reporter: ["text-summary", "json-summary", "lcov"],
      thresholds: {
        // Decision 12 (M8 T3, TST-121): 80 % lines overall; 90 % lines and branches on the named groups.
        // Globs aggregate over the matched files. Shortfalls are closed with tests (tests/coverage/**), never exclusions.
        lines: 80,
        "src/lib/learning/{lessons,alphaInvesting,comparisons,critic}.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Money maths.
        "src/lib/money/**": { lines: 90, branches: 90 },
        "src/lib/arena/{fills,costs,slippage,ledger,nav,sleeve,sizing,terminal,corpActions,recost,invariants}.ts":
          {
            lines: 90,
            branches: 90,
          },
        // Validation statistics and replay statistics.
        "src/lib/stats/**": { lines: 90, branches: 90 },
        // Decision 12: "the replay statistics in src/lib/replay/**" = the modules that compute figures:
        // scorecards (trade, barrier, headline, CIF and zero-edge rows), returns (per-position and period
        // returns, paired excess, brokerage), cif (Aalen-Johansen and bootstrap intervals), zeroEdge (the
        // zero-edge Monte Carlo) and nullRuns (size and power of the validation tests). The orchestration
        // (cli, runner, learningMode, snapshot*, cohortReplay, ledger, controlLibrary) stays under the 80 % overall floor.
        "src/lib/replay/{scorecards,returns,cif,zeroEdge,nullRuns}.ts": { lines: 90, branches: 90 },
        // Rule interpreter.
        "src/lib/agents/families/**": { lines: 90, branches: 90 },
        "src/lib/agents/{candidates,params}.ts": { lines: 90, branches: 90 },
        // Auth and roles. The design names src/lib/ui/mask.ts; the masking module in this repo is src/lib/view/mask.ts.
        "src/lib/auth/**": { lines: 90, branches: 90 },
        "src/lib/http/{gate,rateLimit}.ts": { lines: 90, branches: 90 },
        "src/lib/view/mask.ts": { lines: 90, branches: 90 },
      },
    },
  },
});
