import { defineConfig } from "vitest/config";

// Worker package coverage (M8 T3, decision 12): 90 % lines and branches on the scheduling files,
// checked only under --coverage. Shortfalls are closed with tests in test/coverage/**, never exclusions.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary", "lcov"],
      thresholds: {
        "src/{clock,schedule,routes,localtime,dispatch}.ts": { lines: 90, branches: 90 },
      },
    },
  },
});
