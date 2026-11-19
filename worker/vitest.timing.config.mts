import { defineConfig } from "vitest/config";

// M18 TST-136 (D-968): the wall-clock timing variants (worker/timing/*.wall.test.ts), run only by the
// non-blocking "Timing report" CI step: `cd worker && npx vitest run --config vitest.timing.config.mts`.
export default defineConfig({
  test: {
    include: ["timing/**/*.wall.test.ts"],
    testTimeout: 60_000,
  },
});
