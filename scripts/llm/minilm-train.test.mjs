// M22 L5 (D-1415): the head trainer on synthetic embeddings only (no model, no text, no network).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildHead, parseEmbeddings, run, softmax, trainHead } from "./minilm-train.mjs";

const SHA = "a".repeat(64);
const LOCK = { sha256: SHA, dim: 4 };

/** Three well separated classes over four dimensions, a little deterministic jitter. */
function items(n = 60) {
  const centres = { alpha: [1, 0, 0, 0], beta: [0, 1, 0, 0], gamma: [0, 0, 1, 1] };
  const out = [];
  for (let i = 0; i < n; i++) {
    const label = Object.keys(centres)[i % 3];
    const j = ((i * 37) % 11) / 100;
    out.push({ label, embedding: centres[label].map((v, k) => v + (k === 3 ? j : -j / 2)) });
  }
  return out;
}
const file = (its, sha = SHA) =>
  [
    JSON.stringify({ format: "praxis-minilm-emb/1", modelSha: sha, dim: 4 }),
    ...its.map((i) => JSON.stringify(i)),
  ].join("\n");

test("softmax sums to one", () => {
  assert.ok(Math.abs(softmax([1, 2, 3]).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test("training separates the classes and is deterministic", () => {
  const a = trainHead(items());
  const b = trainHead(items());
  assert.deepEqual(a, b);
  assert.deepEqual(a.labels, ["alpha", "beta", "gamma"]);
  assert.equal(a.accuracy, 1);
});

test("buildHead writes the head shape and is accepted by the same maths the app uses", () => {
  const r = buildHead(file(items()), LOCK, { date: "2030-01-01", minItems: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.head.trained, true);
  assert.equal(r.head.modelSha, SHA);
  assert.equal(r.head.trainedOn, 60);
  assert.equal(r.head.weights.length, 3);
  assert.equal(r.head.weights[0].length, 4);
  assert.equal(r.head.trainedAt, "2030-01-01");
});

test("refusals write nothing: unpinned lock, other model, few items, one label, bad file", () => {
  const f = file(items());
  assert.equal(buildHead(f, { sha256: null, dim: 4 }, { minItems: 10 }).ok, false);
  assert.equal(buildHead(file(items(), "b".repeat(64)), LOCK, { minItems: 10 }).ok, false);
  assert.equal(buildHead(f, LOCK).ok, true); // the default minimum is 50, 60 items pass
  assert.equal(buildHead(file(items(6)), LOCK).ok, false);
  assert.equal(
    buildHead(file(items().map((i) => ({ ...i, label: "x" }))), LOCK, { minItems: 10 }).ok,
    false,
  );
  assert.equal(buildHead("nonsense", LOCK).ok, false);
  assert.throws(() =>
    parseEmbeddings(
      file([
        { label: "a", embedding: [1] },
        { label: "b", embedding: [1] },
      ]),
    ),
  );
});

test("run: refuses without arguments, writes the file on success", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "minilm-train-"));
  try {
    const lines = [];
    assert.equal(
      run([], (s) => lines.push(s)),
      2,
    );
    const emb = path.join(dir, "e.jsonl");
    const lock = path.join(dir, "lock.json");
    const out = path.join(dir, "head.json");
    writeFileSync(emb, file(items()));
    writeFileSync(lock, JSON.stringify(LOCK));
    assert.equal(
      run(["--embeddings", emb, "--lock", lock, "--out", out, "--date", "2030-01-01"], (s) =>
        lines.push(s),
      ),
      0,
    );
    const head = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(head.format, "praxis-minilm-head/1");
    assert.equal(head.trained, true);
    writeFileSync(lock, JSON.stringify({ sha256: null, dim: 4 }));
    assert.equal(
      run(["--embeddings", emb, "--lock", lock, "--out", path.join(dir, "no.json")], (s) =>
        lines.push(s),
      ),
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
