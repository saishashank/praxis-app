// @vitest-environment node
// M22 L5 (LLM-079, D-1415): the head maths and the readiness check (fails closed).
import { describe, expect, it } from "vitest";
import {
  headShapeProblem,
  lockProblem,
  MODEL_MISMATCH,
  NOT_PINNED,
  NOT_TRAINED,
  predict,
  readinessProblem,
  softmax,
} from "@/lib/llm/minilm/head";
import { headOf, lockOf, SHA_B } from "./helpers";

describe("softmax and predict", () => {
  it("sums to one and is stable for large logits", () => {
    const p = softmax([1000, 1001, 999]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[1]).toBeGreaterThan(p[0]!);
  });

  it("picks the class with the larger score and returns its probability", () => {
    const h = headOf();
    const a = predict(h, [0.7, 0.7, 0, 0]);
    expect(a.label).toBe("halt_suspension");
    expect(a.prob).toBeGreaterThan(0.9);
    expect(predict(h, [0, 0, 0.7, 0.7]).label).toBe("other");
  });

  it("matches a hand-computed value", () => {
    const h = headOf({
      weights: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      bias: [0.5, 0],
    });
    const p = predict(h, [1, 2, 0, 0]);
    // logits 1.5 and 2 -> softmax
    const e0 = Math.exp(1.5 - 2);
    expect(p.probs[1]).toBeCloseTo(1 / (e0 + 1), 12);
    expect(p.label).toBe("halt_suspension");
  });

  it("a tie goes to the first label; a wrong length throws", () => {
    const h = headOf({
      weights: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    });
    expect(predict(h, [1, 1, 1, 1]).label).toBe("other");
    expect(() => predict(h, [1, 2])).toThrow();
  });
});

describe("readiness (the guard and the shadow share it)", () => {
  it("a trained head on the pinned model is ready", () => {
    expect(readinessProblem(headOf(), lockOf())).toBeNull();
  });
  it("an untrained head is refused with the plain sentence", () => {
    expect(readinessProblem(headOf({ trained: false }), lockOf())).toBe(NOT_TRAINED);
    expect(NOT_TRAINED).toBe("The local classifier has not been trained yet");
  });
  it("garbage and a malformed head fail closed", () => {
    for (const bad of [null, 3, {}, { ...headOf(), weights: [[1]] }, { ...headOf(), format: "x" }])
      expect(readinessProblem(bad, lockOf())).toBe(NOT_TRAINED);
    expect(headShapeProblem({ ...headOf(), bias: [0, Number.NaN] })).not.toBeNull();
  });
  it("an unpinned lock refuses", () => {
    expect(readinessProblem(headOf(), lockOf(null))).toBe(NOT_PINNED);
    expect(lockProblem({ ...lockOf(), sha256: "ABC" })).toBe(NOT_PINNED);
    expect(lockProblem({ ...lockOf(), sizeBytes: 200_000_000 })).toBe(NOT_PINNED);
  });
  it("a head trained on another model file refuses (hash mismatch)", () => {
    expect(readinessProblem(headOf({ modelSha: SHA_B }), lockOf())).toBe(MODEL_MISMATCH);
    const wide = headOf({ dim: 8, weights: [new Array(8).fill(0), new Array(8).fill(0)] });
    expect(readinessProblem(wide, lockOf())).toBe(MODEL_MISMATCH);
  });
});
