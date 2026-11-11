import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "node:path";

// M18 TST-136 (D-968): the wall-clock timing variants (tests/timing/*.wall.test.ts) are not part of the default
// suite. This config runs only them, from the non-blocking "Timing report" CI step:
//   npx vitest run --config vitest.timing.config.mts
// (the Worker's own wall variants: cd worker && npx vitest run --config vitest.timing.config.mts).
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
    include: ["tests/timing/**/*.wall.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.mts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
