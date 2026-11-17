// @vitest-environment node
// M22 A2 (D-1410; LLM-050, LLM-061, LLM-068): the budget buckets partition the unchanged 240,000 daily total. A committee
// call spends the committee cap and not R6's; R7 reads the committee cap and is never charged directly; the total cap still
// binds; the call row holds the bucket; model lookup still uses the role.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  allowance,
  BUDGET_KEYS,
  bucketOf,
  ROLES,
  type BudgetKey,
  type BudgetUsage,
} from "@/lib/llm/budget";
import { createMockProvider } from "@/lib/llm/providers";
import { MemoryStore, sumUsage, type CallRow } from "@/lib/llm/store";
import { makeRouter, MOCK_MODEL, request } from "./helpers";

const p = defaultAgentParams().llm;
const zero: BudgetUsage = { roleDay: 0, totalDay: 0, marketNight: 0 };
const D = "2026-03-05";

const row = (role: BudgetKey, tokens: number, over: Partial<CallRow> = {}): CallRow => ({
  id: `${role}-${tokens}`,
  role,
  provider: "mock",
  modelId: MOCK_MODEL,
  fallbackDepth: "0",
  tokensIn: tokens,
  tokensOut: 0,
  cached: 0,
  outcome: "ok",
  injectionFiltered: 0,
  market: "AU",
  d: D,
  ...over,
});

describe("the caps partition the unchanged total (D-1410)", () => {
  it("roles plus the two buckets sum to 235,000, inside the 240,000 total", () => {
    const t = p.roleDailyTokens;
    expect(p.dailyTotal).toBe(240_000);
    expect(t.R1 + t.R2 + t.R3 + t.R5 + t.R6 + t.committee + t.experts).toBe(235_000);
    expect(t.committee).toBe(40_000);
    expect(t.experts).toBe(30_000);
    expect(t.R7).toBe(t.committee);
    expect(235_000).toBeLessThanOrEqual(p.dailyTotal);
  });

  it("the budget keys are five roles and the two buckets; R7 is a role but never a charged bucket", () => {
    expect(ROLES).toContain("R7");
    expect([...BUDGET_KEYS].sort()).toEqual(
      ["R1", "R2", "R3", "R5", "R6", "committee", "experts"].sort(),
    );
    expect(bucketOf("R7")).toBe("committee");
    for (const k of BUDGET_KEYS) expect(bucketOf(k)).toBe(k);
  });
});

describe("allowance by budget key", () => {
  it("a committee or experts bucket reads its own cap; R7 reads the committee cap", () => {
    expect(allowance(p, "committee", "AU", false, zero)).toEqual({
      allowed: 40_000,
      binding: "role",
    });
    expect(allowance(p, "experts", "AU", false, zero)).toEqual({
      allowed: 30_000,
      binding: "role",
    });
    expect(allowance(p, "R7", "AU", false, zero)).toEqual({ allowed: 40_000, binding: "role" });
    expect(allowance(p, "R6", "AU", false, zero)).toEqual({ allowed: 20_000, binding: "role" });
  });

  it("the all-roles total still binds over a bucket", () => {
    const a = allowance(p, "committee", "AU", false, { ...zero, totalDay: p.dailyTotal - 123 });
    expect(a).toEqual({ allowed: 123, binding: "total" });
  });

  it("a bucket cap at zero allows nothing", () => {
    const off = { ...p, roleDailyTokens: { ...p.roleDailyTokens, committee: 0, R7: 0 } };
    expect(allowance(off, "committee", "AU", false, zero).allowed).toBe(0);
    expect(allowance(off, "R7", "AU", false, zero).allowed).toBe(0);
  });
});

describe("usage by bucket", () => {
  it("committee rows count to the committee bucket and to the total, not to R6", () => {
    const rows = [row("committee", 1_000), row("R6", 200), row("experts", 50)];
    expect(sumUsage(rows, "committee", "AU", D)).toMatchObject({ roleDay: 1_000, totalDay: 1_250 });
    expect(sumUsage(rows, "R6", "AU", D).roleDay).toBe(200);
    expect(sumUsage(rows, "experts", "AU", D).roleDay).toBe(50);
  });
});

describe("the router charges the bucket (task A2)", () => {
  const mock = (roles: Array<"R1" | "R2" | "R3" | "R5" | "R6" | "R7">) =>
    createMockProvider({ model: MOCK_MODEL, roles, fixtures: {} });
  const ALL = ["R1", "R2", "R3", "R5", "R6", "R7"] as const;

  it("a spent committee bucket stops a committee call and leaves R6 whole; the row holds the bucket", async () => {
    const store = new MemoryStore();
    store.rows.push(row("committee", p.roleDailyTokens.committee));
    const { router } = makeRouter("mock", [mock([...ALL])], store);
    const r = await router.route(request({ role: "R7", budgetKey: "committee" }));
    expect(r.budgetExhausted).toBe(true);
    expect(r.source).toBe("rules-only");
    expect(r.attempts.some((a) => a.outcome === "budget-exhausted:role")).toBe(true);
    expect(store.rows.at(-1)).toMatchObject({ role: "committee" });
    const r6 = await store.usage("R6", "AU", D);
    expect(allowance(p, "R6", "AU", false, r6).allowed).toBe(p.roleDailyTokens.R6);
  });

  it("an R7 request without a budgetKey is charged to the committee bucket, never to R7", async () => {
    const { router, store } = makeRouter("rules-only", [mock([...ALL])]);
    await router.route(request({ role: "R7" }));
    expect(store.rows[0]!.role).toBe("committee");
  });

  it("with no budgetKey the bucket is the role, so every earlier call is unchanged; a key overrides it", async () => {
    const { router, store } = makeRouter("rules-only", [mock([...ALL])]);
    await router.route(request({ role: "R2" }));
    expect(store.rows[0]!.role).toBe("R2");
    await router.route(request({ role: "R3", budgetKey: "experts" }));
    expect(store.rows[1]!.role).toBe("experts");
  });

  it("a spent experts bucket stops an experts call by R1 but not R1's own calls", async () => {
    const store = new MemoryStore();
    store.rows.push(row("experts", p.roleDailyTokens.experts));
    const { router } = makeRouter("mock", [mock([...ALL])], store);
    const stopped = await router.route(request({ role: "R1", budgetKey: "experts" }));
    expect(stopped.budgetExhausted).toBe(true);
    const plain = await router.route(request({ role: "R1" }));
    expect(plain.budgetExhausted).toBe(false); // R1's own cap is whole (no fixture: a rules-only answer)
  });

  it("the total cap still binds a bucket call", async () => {
    const store = new MemoryStore();
    store.rows.push(row("R2", p.dailyTotal));
    const { router } = makeRouter("mock", [mock([...ALL])], store);
    const r = await router.route(request({ role: "R7", budgetKey: "committee" }));
    expect(r.budgetExhausted).toBe(true);
    expect(r.attempts.some((a) => a.outcome === "budget-exhausted:total")).toBe(true);
  });

  it("model lookup still uses the role: a provider with no R7 model is unavailable", async () => {
    const { router } = makeRouter("mock", [mock(["R1"])]);
    const r = await router.route(request({ role: "R7", budgetKey: "committee" }));
    expect(r.attempts[0]).toMatchObject({ outcome: "unavailable" });
  });
});
