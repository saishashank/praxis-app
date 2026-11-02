// M16 fix B1: Next's file tracer cannot see the files the Blueprint reads through process.cwd(), so
// next.config.ts lists them. This test fails when a path in specBrowser.ts is not listed (no drift).
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig, { BLUEPRINT_TRACE_INCLUDES } from "../../next.config";
import { DOCS_ALLOW, SPEC_DIR } from "@/lib/blueprint/specBrowser";

const norm = (p: string) => p.replace(/^\.\//, "");

describe("Blueprint file tracing", () => {
  it("is wired into the Next config", () => {
    expect(nextConfig.outputFileTracingIncludes).toBe(BLUEPRINT_TRACE_INCLUDES);
  });
  it("lists every file the spec browser can read, for the page", () => {
    const page = BLUEPRINT_TRACE_INCLUDES["/blueprint"].map(norm);
    expect(page).toContain(`${SPEC_DIR}/*.md`);
    for (const f of Object.values(DOCS_ALLOW)) expect(page).toContain(f);
    expect(page).toContain("docs/architecture/architecture.json");
  });
  it("lists the model for the model route, and every listed path exists", () => {
    expect(BLUEPRINT_TRACE_INCLUDES["/api/blueprint/model"].map(norm)).toEqual([
      "docs/architecture/architecture.json",
    ]);
    for (const list of Object.values(BLUEPRINT_TRACE_INCLUDES))
      for (const f of list.map(norm).filter((x) => !x.includes("*")))
        expect(fs.existsSync(f), f).toBe(true);
  });
});
