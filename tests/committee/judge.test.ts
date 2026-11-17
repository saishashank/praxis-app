// @vitest-environment node
// Committee judge (M22 C1; AGT-145, LLM-010, LLM-064/065; D-1418): approve, neutral or reject with at most five cited
// reasons, checked like the statements; the judge is never the bear's model.
import { describe, expect, it } from "vitest";
import type { Point } from "@/lib/committee/debate";
import { judgeRequest, parseJudge, runJudge } from "@/lib/committee/judge";
import { buildPack } from "@/lib/steelman/pack";
import { CUT } from "../steelman/nightHarness";
import { committeeLlm, committeeProvider, judgeSays } from "./harness";

const PACK = buildPack({
  cutoffAt: CUT,
  maxItems: 25,
  items: [
    { kind: "card", text: "Family F3 rule v1: drift after a contract win." },
    { kind: "rule", text: "Rule volume_surge value 2.4 threshold 2.0 passed" },
    { kind: "flag", text: "Flag thin" },
    { kind: "headline", text: "ZZA contract notice", at: "2026-03-04T02:00:00.000Z" },
  ],
});
const pt = (text: string): Point => ({ text, citations: ["E01"] });
const INPUT = {
  market: "AU",
  d: "2026-03-04",
  code: "ZZA",
  pack: PACK,
  statements: {
    bull: [pt("The rule evidence on the card passed its check.")],
    bear: [pt("A data flag limits how far the evidence can be trusted.")],
    risk: [pt("Thin trading could make an exit costly.")],
  },
};

describe("judge request and parser", () => {
  it("is role R7, charged to the Committee bucket, with the pack's citation enum and the statements as facts", () => {
    const req = judgeRequest(INPUT);
    expect(req).toMatchObject({ role: "R7", budgetKey: "committee", nightly: true });
    expect(req.citationIds).toEqual(["E01", "E02", "E03", "E04"]);
    expect(JSON.stringify(req.facts)).toContain("statements");
    expect(req.untrusted).toEqual(["E04: ZZA contract notice"]);
  });
  it("parses only the three ratings", () => {
    expect(parseJudge({ rating: "approve", reasons: [] })).toEqual({
      rating: "approve",
      reasons: [],
    });
    expect(parseJudge({ rating: "buy", reasons: [] })).toBeNull();
    expect(parseJudge({ rating: "reject" })).toBeNull();
    expect(parseJudge("approve")).toBeNull();
  });
});

describe("runJudge", () => {
  const run = (providers = [committeeProvider("alpha")], bearModel: string | null = "beta-r6") => {
    const llm = committeeLlm(providers);
    return runJudge(llm.routerFor("R7")!, llm.providers, INPUT, bearModel);
  };

  it("returns the rating, the checked reasons and a call record", async () => {
    const r = await run();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.rating).toBe("approve");
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.model).toBe("alpha-r7");
    expect(r.record.stage).toBe("judge");
    expect(JSON.parse(r.record.paramsJson)).toMatchObject({ role: "R7", budgetKey: "committee" });
  });

  it.each(["approve", "neutral", "reject"])("passes the rating %s through", async (rating) => {
    const r = await run([committeeProvider("alpha", undefined, judgeSays(rating))]);
    expect(r).toMatchObject({ kind: "ok", rating });
  });

  it("refuses an answer from the bear's own model (the judge is never the bear)", async () => {
    expect(await run([committeeProvider("alpha")], "alpha-r7")).toEqual({ kind: "same_model" });
  });

  it("rejects reasons that fail the claim checks (invented number, bad citation, a link)", async () => {
    const bad = () =>
      JSON.stringify({
        rating: "approve",
        reasons: [
          { text: "Volume rose 77 percent.", citations: ["E02"] },
          { text: "See www.example.com.", citations: ["E01"] },
        ],
      });
    expect((await run([committeeProvider("alpha", undefined, bad)])).kind).toBe("rejected");
  });

  it("keeps at most five reasons", async () => {
    const six = () =>
      JSON.stringify({
        rating: "neutral",
        reasons: Array.from({ length: 6 }, () => ({
          text: "The rule evidence on the card passed its check.",
          citations: ["E01"],
        })),
      });
    const r = await run([committeeProvider("alpha", undefined, six)]);
    expect(r.kind === "ok" && r.reasons.length).toBe(5);
  });

  it("an answer that is not a rating is rejected, never rated", async () => {
    const odd = () => JSON.stringify({ rating: "strong buy", reasons: [] });
    expect((await run([committeeProvider("alpha", undefined, odd)])).kind).toBe("rejected");
  });
});
