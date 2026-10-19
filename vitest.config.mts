import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // Database-backed tests (migrations, replays) need more than the 5 s default on CI runners;
    // one limit for local and CI runs so a slow test cannot pass locally and fail in CI.
    testTimeout: 30_000,
    coverage: { provider: "v8", include: ["src/**"] },
  },
});
