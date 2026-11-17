// @vitest-environment node
// LLM-062 / D-482: stage order within the night and what each stage must leave for the later ones.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { scaledCap, type BudgetKey, type BudgetUsage } from "@/lib/llm/budget";
import { DROP_ORDER, reserveAfter, reserveAfterLeft } from "@/lib/llm/dropOrder";

const p = defaultAgentParams().llm;

describe("drop order (D-482)", () => {
  it("lists the stages with the Evening Review last", () => {
    expect(DROP_ORDER[DROP_ORDER.length - 1]).toBe("evening_review");
    expect(DROP_ORDER.indexOf("steelman")).toBeLessThan(DROP_ORDER.indexOf("evening_review"));
  });

  it("the Evening Review reserves nothing; the steelman leaves the R5 cap", () => {
    expect(reserveAfter("evening_review", p)).toBe(0);
    expect(reserveAfter("steelman", p)).toBe(p.roleDailyTokens.R5);
  });

  it("an earlier stage reserves at least what a later one does", () => {
    for (let i = 1; i < DROP_ORDER.length; i++)
      expect(reserveAfter(DROP_ORDER[i - 1]!, p)).toBeGreaterThanOrEqual(
        reserveAfter(DROP_ORDER[i]!, p),
      );
  });
});

describe("drop order with caps (M22 A2, D-1411)", () => {
  const none = async (): Promise<BudgetUsage> => ({ roleDay: 0, totalDay: 0, marketNight: 0 });
  const t = p.roleDailyTokens;
  const cap = (n: number) => scaledCap(n, p.marketShare.AU);

  it("expert_ingest and committee take their bucket caps; reflections take none of their own", () => {
    expect(reserveAfter("evening_review", p)).toBe(0);
    expect(reserveAfter("steelman", p)).toBe(t.R5); // reflections share R6: nothing extra by default
    expect(reserveAfter("committee", p)).toBe(t.R6 + t.R5);
    expect(reserveAfter("expert_ingest", p)).toBe(t.committee + t.R6 + t.R5);
  });

  it("with no reservation argument the figures are as before", async () => {
    expect(await reserveAfterLeft("steelman", p, "AU", none)).toBe(cap(t.R5));
    expect(await reserveAfterLeft("committee", p, "AU", none)).toBe(cap(t.R6) + cap(t.R5));
    expect(await reserveAfterLeft("expert_ingest", p, "AU", none)).toBe(
      cap(t.committee) + cap(t.R6) + cap(t.R5),
    );
  });

  it("the reflection reservation reduces what the steelman may spend, capped by the R6 cap left", async () => {
    expect(await reserveAfterLeft("steelman", p, "AU", none, 2_000)).toBe(cap(t.R5) + 2_000);
    expect(await reserveAfterLeft("steelman", p, "AU", none, cap(t.R6) + 9_999)).toBe(
      cap(t.R5) + cap(t.R6),
    );
    const spent = async (k: BudgetKey): Promise<BudgetUsage> => ({
      roleDay: k === "R6" ? cap(t.R6) : 0,
      totalDay: 0,
      marketNight: 0,
    });
    expect(await reserveAfterLeft("steelman", p, "AU", spent, 2_000)).toBe(cap(t.R5));
    // a stage before the steelman already counts all of R6's cap, reflections included: no double count
    expect(await reserveAfterLeft("committee", p, "AU", none, 2_000)).toBe(cap(t.R6) + cap(t.R5));
    // the Evening Review comes after the reflections and reserves nothing
    expect(await reserveAfterLeft("evening_review", p, "AU", none, 2_000)).toBe(0);
    expect(await reserveAfterLeft("pick_reflection", p, "AU", none, 2_000)).toBe(cap(t.R5));
  });

  it("a bucket already spent reserves nothing for itself", async () => {
    const used = async (k: BudgetKey): Promise<BudgetUsage> => ({
      roleDay: k === "committee" ? cap(t.committee) : 0,
      totalDay: 0,
      marketNight: 0,
    });
    expect(await reserveAfterLeft("expert_ingest", p, "AU", used)).toBe(cap(t.R6) + cap(t.R5));
  });
});
