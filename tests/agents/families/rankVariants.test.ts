// @vitest-environment node
// M14 WP6 (KB-081): F1 / F4 read their rank variant from rankScore.ts (WP4 fills it); the rank-score
// reader is injected here. v1 never calls it.
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/agents/families/rankScore", () => ({
  rankScores: (_f: string, _i: unknown, _p: unknown, variant: string) => {
    calls.n += 1;
    return variant === "v1"
      ? []
      : [
          { code: "ZZA", score: 0.5 },
          { code: "ZZB", score: 2.5 },
        ];
  },
}));

import { runFamilies } from "@/lib/agents/families";
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  CENT,
  factsOf,
  inputsOf,
  makeBars,
  volumes,
  rising,
} from "../../fixtures/agents/families/builders";

const p = defaultAgentParams();
const withKeys = (over: Partial<Record<ConfigKey, unknown>>) =>
  buildAgentParams((k) => (k in over ? over[k] : CONFIG_KEYS[k].default));

describe("rank variants", () => {
  const leaders = () =>
    ["ZZA", "ZZB"].map((code) =>
      factsOf(
        code,
        "U1",
        makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
        p,
      ),
    );

  it("v1 does not call the rank-score reader", () => {
    calls.n = 0;
    runFamilies(inputsOf(leaders()), p);
    expect(calls.n).toBe(0);
  });

  it("composite3 orders F1 by the variant score, highest first", () => {
    const out = runFamilies(inputsOf(leaders()), withKeys({ f1_rank_variant: "composite3" }), {
      u2OptInF1: false,
    });
    const f1 = out.candidates.filter((c) => c.family === "F1");
    // both clear the entry rules only if they are top-tier; whatever enters is ordered by score
    const codes = f1.map((c) => c.code);
    expect(codes).toEqual([...codes].sort((a, b) => (a === "ZZB" ? -1 : b === "ZZB" ? 1 : 0)));
    for (const c of f1) expect(c.rank[0]).not.toBeNull();
  });
});
