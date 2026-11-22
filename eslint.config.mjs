import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".claude/**",
    ".next/**",
    "out/**",
    "coverage/**",
    // D-1854: Stryker's instrumented sandbox (gitignored; left behind when a local run stops early)
    ".stryker-tmp/**",
    "worker/**",
    "spec/**",
    "docs/**",
    "scripts/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
