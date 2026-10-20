import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
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
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // TST-121 (M6 T16): 90 % on the lesson engine, set only under --coverage (npm run test:coverage),
      // so the default run stays fast. Weekly mutation testing (TST-130) is a CI job, not a dev dependency here.
      thresholds: {
        "src/lib/learning/{lessons,alphaInvesting,comparisons,critic}.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
