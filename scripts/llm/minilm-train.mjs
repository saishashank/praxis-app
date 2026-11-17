// Trains the MiniLM shadow head (M22 L5, LLM-079, D-1415): a multinomial logistic head (softmax regression) over sentence
// embeddings, by deterministic full-batch gradient descent (zero start, fixed order, no randomness). It reads an embeddings
// file written by `minilm embed` (first line {format, modelSha, dim}, then one {label, embedding} per line: vectors and labels
// only, never text) and writes src/lib/llm/minilm/head.weights.json. Only the weights are committed.
//   node scripts/llm/minilm-train.mjs --embeddings <file.jsonl> [--out <head.weights.json>] [--date YYYY-MM-DD]
//        [--epochs 300] [--lr 0.5] [--l2 0.0001] [--min-items 50] [--lock <model.lock.json>]
// Refused (exit 2, nothing written) when the lock has no fingerprint, the embeddings come from another model file than the
// lock's, there are fewer than two labels, or fewer items than --min-items. The model file hash is the lock's, so the
// committed head and the pinned model agree (the switch guard checks the same). No network, no database.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.resolve(HERE, "../../src/lib/llm/minilm/head.weights.json");
export const LOCK_FILE = path.resolve(HERE, "../../src/lib/llm/minilm/model.lock.json");
const HEX64 = /^[0-9a-f]{64}$/;

/** Numerically stable softmax. */
export function softmax(z) {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

const logits = (W, b, x) => W.map((row, k) => row.reduce((s, w, i) => s + w * x[i], b[k]));

/**
 * Full-batch gradient descent on the mean cross-entropy plus an L2 penalty on the weights (not the bias).
 * @param {{ label: string, embedding: number[] }[]} items
 * @param {{ epochs?: number, lr?: number, l2?: number }} [opts]
 * @returns {{ labels: string[], dim: number, weights: number[][], bias: number[], accuracy: number }}
 */
export function trainHead(items, opts = {}) {
  const epochs = opts.epochs ?? 300;
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;
  const labels = [...new Set(items.map((i) => i.label))].sort();
  const dim = items[0].embedding.length;
  const K = labels.length;
  const idx = new Map(labels.map((l, k) => [l, k]));
  const W = labels.map(() => new Array(dim).fill(0));
  const b = new Array(K).fill(0);
  const n = items.length;
  for (let ep = 0; ep < epochs; ep++) {
    const gW = labels.map(() => new Array(dim).fill(0));
    const gb = new Array(K).fill(0);
    for (const it of items) {
      const p = softmax(logits(W, b, it.embedding));
      const y = idx.get(it.label);
      for (let k = 0; k < K; k++) {
        const d = p[k] - (k === y ? 1 : 0);
        gb[k] += d;
        for (let i = 0; i < dim; i++) gW[k][i] += d * it.embedding[i];
      }
    }
    for (let k = 0; k < K; k++) {
      b[k] -= (lr * gb[k]) / n;
      for (let i = 0; i < dim; i++) W[k][i] -= lr * (gW[k][i] / n + l2 * W[k][i]);
    }
  }
  let right = 0;
  for (const it of items) {
    const z = logits(W, b, it.embedding);
    let best = 0;
    for (let k = 1; k < K; k++) if (z[k] > z[best]) best = k;
    if (labels[best] === it.label) right++;
  }
  return { labels, dim, weights: W, bias: b, accuracy: right / n };
}

/** Parses the embeddings file; throws a plain Error on a malformed file. */
export function parseEmbeddings(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("the embeddings file is empty");
  const head = JSON.parse(lines[0]);
  if (
    head.format !== "praxis-minilm-emb/1" ||
    !HEX64.test(String(head.modelSha)) ||
    !Number.isInteger(head.dim)
  )
    throw new Error("the embeddings file has no valid header");
  const items = lines.slice(1).map((l) => JSON.parse(l));
  for (const it of items)
    if (
      typeof it.label !== "string" ||
      !Array.isArray(it.embedding) ||
      it.embedding.length !== head.dim
    )
      throw new Error("an item has the wrong shape");
  return { modelSha: head.modelSha, dim: head.dim, items };
}

/**
 * @returns {{ ok: true, head: object, accuracy: number } | { ok: false, reason: string }}
 */
export function buildHead(embText, lock, opts = {}) {
  let e;
  try {
    e = parseEmbeddings(embText);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unreadable" };
  }
  if (!HEX64.test(String(lock.sha256)))
    return { ok: false, reason: "the model lock has no fingerprint yet" };
  if (e.modelSha !== lock.sha256)
    return { ok: false, reason: "the embeddings come from another model file than the lock's" };
  if (e.dim !== lock.dim)
    return { ok: false, reason: "the embedding length differs from the lock's" };
  const min = opts.minItems ?? 50;
  if (e.items.length < min) return { ok: false, reason: `fewer than ${min} items` };
  if (new Set(e.items.map((i) => i.label)).size < 2)
    return { ok: false, reason: "fewer than two labels" };
  const t = trainHead(e.items, opts);
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    ok: true,
    accuracy: t.accuracy,
    head: {
      format: "praxis-minilm-head/1",
      trained: true,
      labels: t.labels,
      dim: t.dim,
      modelSha: e.modelSha,
      weights: t.weights.map((r) => r.map(round)),
      bias: t.bias.map(round),
      trainedOn: e.items.length,
      trainedAt: opts.date ?? null,
    },
  };
}

const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function run(argv, out = console.log) {
  const file = arg(argv, "--embeddings");
  if (!file) {
    out("usage: minilm-train.mjs --embeddings <file.jsonl> [--out <file>] [--date YYYY-MM-DD]");
    return 2;
  }
  const num = (name) => (arg(argv, name) === undefined ? undefined : Number(arg(argv, name)));
  let text;
  let lock;
  try {
    text = readFileSync(file, "utf8");
    lock = JSON.parse(readFileSync(arg(argv, "--lock") ?? LOCK_FILE, "utf8"));
  } catch {
    out("minilm-train: cannot read the embeddings file or the lock");
    return 2;
  }
  const r = buildHead(text, lock, {
    epochs: num("--epochs"),
    lr: num("--lr"),
    l2: num("--l2"),
    minItems: num("--min-items"),
    date: arg(argv, "--date"),
  });
  if (!r.ok) {
    out(`minilm-train: refused (${r.reason})`);
    return 2;
  }
  writeFileSync(arg(argv, "--out") ?? DEFAULT_OUT, `${JSON.stringify(r.head, null, 2)}\n`);
  out(
    `minilm-train: head written (${r.head.trainedOn} items, ${r.head.labels.length} labels, training accuracy ${(r.accuracy * 100).toFixed(1)} %)`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2));
