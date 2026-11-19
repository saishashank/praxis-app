// @vitest-environment node
// M22 A2 (D-1401, D-1445 seam; AT-80 defaults), pointed at the factory by L1: the one place every night-time CLI takes its
// routers from. With no list read (or an empty one) it is rules-only: no provider, no network, one logged rules-only row
// per call. The live cases are in tests/llm/factory.test.ts and tests/acceptance/v3/at80Routes.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadNightLlm, nightlyLlm } from "@/lib/llm/nightlyLlm";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";
import { fixture, request } from "./helpers";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  cleanupTempDbs();
});

const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("nightlyLlm (rules-only seam)", () => {
  it("has no provider, answers every role from the template and logs a rules-only row", async () => {
    const db = await freshDb("main");
    const llm = nightlyLlm({ db, params: defaultAgentParams(), kbVersion: "kb1" });
    expect(llm.providers).toEqual([]);
    for (const role of ["R1", "R2", "R3", "R5", "R6", "R7"] as const) {
      const router = llm.routerFor(role);
      expect(router.mode).toBe("rules-only");
      const res = await router.route(request({ role, market: "AU", d: "2026-03-05" }));
      expect(res.source).toBe("rules-only");
      expect(res.value).toEqual(fixture.rulesNote);
      expect(res.llmUsed).toBe(false);
    }
    const n = await db.execute("SELECT COUNT(*) n FROM llm_call WHERE provider = 'rules-only'");
    expect(Number(n.rows[0]!.n)).toBe(6);
  });

  it("a router per call is independent of the others (a fresh cool-down state each time)", () => {
    const llm = nightlyLlm({ db: {} as never, params: defaultAgentParams(), kbVersion: "kb1" });
    expect(llm.routerFor("R5")).not.toBe(llm.routerFor("R5"));
  });
});

describe("the seam is the only router source of the night CLIs, and builds nothing live", () => {
  it("arena and steelman CLIs import it and no longer build routers themselves", () => {
    for (const f of ["src/lib/arena/cli.ts", "src/lib/steelman/cli.ts"]) {
      const text = src(f);
      expect(text, f).toContain("@/lib/llm/nightlyLlm");
      expect(text, f).not.toMatch(/\bcreateRouter\b/);
    }
  });

  it("nightlyLlm.ts builds no router and no provider itself: both come from the factory (L1)", () => {
    const text = src("src/lib/llm/nightlyLlm.ts");
    expect(text).not.toMatch(/mode:\s*"(live|mock|rules-only)"/);
    expect(text).not.toMatch(/createLiveProvider|createMockProvider|createRouter/);
    expect(text).toContain('from "./factory"');
  });

  it("a list that is absent, null or empty keeps every role rules-only; a failed read does too", async () => {
    const db = await freshDb("main");
    const base = { db, params: defaultAgentParams(), kbVersion: "kb1", env: { GROQ_API_KEY: "k" } };
    for (const liveRoles of [undefined, null, []] as const) {
      const llm = nightlyLlm({ ...base, liveRoles });
      expect(llm.providers).toEqual([]);
      expect(llm.routerFor("R6").mode).toBe("rules-only");
    }
    const failing = { ...base, db: { execute: () => Promise.reject(new Error("down")) } as never };
    const failed = await loadNightLlm(failing);
    expect(failed.status.liveRoles).toBeNull();
    expect(failed.routerFor("R6").mode).toBe("rules-only");
  });
});
