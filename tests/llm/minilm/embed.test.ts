// @vitest-environment node
// M22 L5 (LLM-079, D-1414): the tokenizer, pooling and the real embedder over a fake runtime session (no model file).
import { describe, expect, it } from "vitest";
import {
  basicTokens,
  meanPoolNormalize,
  onnxEmbedder,
  parseVocab,
  wordPieceIds,
} from "@/lib/llm/minilm/embed";
import type { LoadedModel } from "@/lib/llm/minilm/model";

const VOCAB = parseVocab(
  [
    "[PAD]",
    "[UNK]",
    "[CLS]",
    "[SEP]",
    "trading",
    "halt",
    "##s",
    "re",
    "##sult",
    ".",
    "caf",
    "##e",
  ].join("\n"),
);

describe("tokenizer", () => {
  it("lowercases, strips accents and splits punctuation", () => {
    expect(basicTokens("Café, HALT.")).toEqual(["cafe", ",", "halt", "."]);
  });
  it("greedy word pieces, unknown words and the special tokens", () => {
    expect(wordPieceIds("Trading halts zzzz", VOCAB, 16)).toEqual([2, 4, 5, 6, 1, 3]);
  });
  it("cuts to the maximum length and keeps the closing token", () => {
    expect(wordPieceIds("halt halt halt halt halt", VOCAB, 4)).toEqual([2, 5, 5, 3]);
  });
  it("a vocabulary without the special tokens throws", () => {
    expect(() => wordPieceIds("halt", parseVocab("halt"), 8)).toThrow();
  });
});

describe("pooling", () => {
  it("averages the attended rows and scales to unit length", () => {
    const v = meanPoolNormalize([3, 0, 0, 4, 9, 9], [1, 1, 0], 2);
    // mean of (3,0) and (0,4) = (1.5, 2), length 2.5
    expect(v[0]).toBeCloseTo(0.6, 12);
    expect(v[1]).toBeCloseTo(0.8, 12);
  });
  it("an all-masked input is the zero vector", () => {
    expect(meanPoolNormalize([1, 2], [0], 2)).toEqual([0, 0]);
  });
});

describe("onnxEmbedder over a fake session", () => {
  class FakeTensor {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: readonly number[],
    ) {}
  }
  const model = (names: string[]): Extract<LoadedModel, { ok: true }> => ({
    ok: true,
    sha: "c".repeat(64),
    Tensor: FakeTensor as never,
    session: {
      inputNames: names,
      async run(feeds) {
        const n = (feeds.input_ids as FakeTensor).dims[1]!;
        return { last_hidden_state: { data: new Array(n * 2).fill(1), dims: [1, n, 2] } };
      },
    },
  });
  it("returns one unit vector per text", async () => {
    const e = onnxEmbedder(model(["input_ids", "attention_mask", "token_type_ids"]), VOCAB, 2, 16);
    const out = await e.embed(["halt", "trading halt"]);
    expect(out).toHaveLength(2);
    expect(Math.hypot(out[0]![0]!, out[0]![1]!)).toBeCloseTo(1, 12);
    expect(e.modelSha).toBe("c".repeat(64));
  });
  it("an unexpected output width throws", async () => {
    const e = onnxEmbedder(model(["input_ids"]), VOCAB, 3, 16);
    await expect(e.embed(["halt"])).rejects.toThrow();
  });
});
