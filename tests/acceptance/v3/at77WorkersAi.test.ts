// @vitest-environment node
// AT-77 (M22 clause, L3; LLM-078): Workers AI is disabled in a fresh configuration, and without a token it is unavailable.
import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config/store";
import { providerForRoster } from "@/lib/llm/providers";
import { ROSTER } from "@/lib/llm/roster";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(() => cleanupTempDbs());

describe("AT-77 Workers AI", () => {
  it("a fresh configuration has the neuron budget at 0", async () => {
    const db = await freshDb("main");
    expect(await getConfig(db, "llm_budget_workers_ai_daily")).toBe(0);
  });

  it("without a token (or account id) the adapter is unavailable even with a budget", () => {
    const mk = (env: Record<string, string>) =>
      providerForRoster("workers-ai", {
        models: { R2: "@cf/test/model-8b" },
        trainsOnPrompts: false,
        dailyNeurons: 1000,
        env,
      })!.available();
    expect(mk({})).toBe(false);
    expect(mk({ CF_ACCOUNT_ID: "a" })).toBe(false);
    expect(mk({ CF_WORKERS_AI_TOKEN: "t" })).toBe(false);
    expect(mk({ CF_ACCOUNT_ID: "a", CF_WORKERS_AI_TOKEN: "t" })).toBe(true);
  });

  it("no roster row for Workers AI is routable before a bake-off", () => {
    for (const r of ROSTER.filter((e) => e.provider === "workers-ai")) {
      expect(r.status).not.toBe("verified");
      expect(r.tier).not.toBeNull();
    }
  });
});
