// @vitest-environment node
// M22 L5 (D-1415): a head written by scripts/llm/minilm-train.mjs on synthetic embeddings is accepted by the app's readiness
// check and classifies the training classes correctly with the app's own maths (the two implementations agree).
import { describe, expect, it } from "vitest";
import { buildHead } from "../../../scripts/llm/minilm-train.mjs";
import { predict, readinessProblem, type Head } from "@/lib/llm/minilm/head";
import { lockOf, SHA_A } from "./helpers";

const centres: Record<string, number[]> = {
  alpha: [1, 0, 0, 0],
  beta: [0, 1, 0, 0],
  gamma: [0, 0, 1, 1],
};
const items = Array.from({ length: 60 }, (_, i) => {
  const label = Object.keys(centres)[i % 3]!;
  const j = ((i * 37) % 11) / 100;
  return { label, embedding: centres[label]!.map((v, k) => v + (k === 3 ? j : -j / 2)) };
});
const text = [
  JSON.stringify({ format: "praxis-minilm-emb/1", modelSha: SHA_A, dim: 4 }),
  ...items.map((i) => JSON.stringify(i)),
].join("\n");

describe("trainer and app agree", () => {
  it("the trained head is ready and predicts every class", () => {
    const r = buildHead(text, { sha256: SHA_A, dim: 4 }, { date: "2030-01-01" });
    if (!r.ok) throw new Error(r.reason);
    const head = r.head as unknown as Head;
    expect(readinessProblem(head, lockOf())).toBeNull();
    for (const [label, c] of Object.entries(centres)) expect(predict(head, c).label).toBe(label);
  });
});
