// @vitest-environment node
// M22 L5 (LLM-079, D-1414): the fixtures lane. Loads the REAL pinned model and checks that it embeds, unit length and
// deterministically. Skipped unless the private fixtures hold the files (PRAXIS_FIXTURES_DIR/minilm/model.onnx and vocab.txt)
// and the lock is pinned; the model file is never committed. Wiring into the CI fixtures job is task Z's.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealEmbedder } from "@/lib/llm/minilm/cli";
import { LOCK } from "@/lib/llm/minilm/model";

const dir = process.env.PRAXIS_FIXTURES_DIR;
const model = dir ? path.join(dir, "minilm", "model.onnx") : "";
const vocab = dir ? path.join(dir, "minilm", "vocab.txt") : "";
const present = dir !== undefined && existsSync(model) && existsSync(vocab) && LOCK.sha256 !== null;

describe.skipIf(!present)("real MiniLM model (fixtures lane)", () => {
  it("embeds two titles to unit vectors of the pinned length, the same each time", async () => {
    const e = await loadRealEmbedder(model, vocab);
    if (typeof e === "string") throw new Error(e);
    expect(e.dim).toBe(LOCK.dim);
    expect(e.modelSha).toBe(LOCK.sha256);
    const a = await e.embed(["Trading Halt", "Half year results and dividend"]);
    const b = await e.embed(["Trading Halt"]);
    expect(a).toHaveLength(2);
    for (const v of a) {
      expect(v).toHaveLength(LOCK.dim);
      expect(Math.hypot(...v)).toBeCloseTo(1, 4);
    }
    expect(b[0]).toEqual(a[0]);
    // different titles are different vectors
    expect(a[0]).not.toEqual(a[1]);
  });
});
