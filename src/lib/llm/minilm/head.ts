// The MiniLM shadow classifier's head (M22 L5, LLM-079, D-1415): a multinomial logistic head over the sentence embedding, a
// pure function of weights stored in head.weights.json (written by scripts/llm/minilm-train.mjs; text is never stored). Also
// the readiness check the switch guard and the health line share: no trained head, an unpinned lock or a head trained on a
// different model file all read as "not ready" (fail closed). No I/O and no runtime import here, so the config guard can
// import this file without pulling the model runtime into the web bundle.

export type Head = {
  readonly format: string;
  readonly trained: boolean;
  readonly labels: readonly string[];
  readonly dim: number;
  /** sha256 of the model file the head was trained on. */
  readonly modelSha: string | null;
  /** labels x dim. */
  readonly weights: readonly (readonly number[])[];
  readonly bias: readonly number[];
  readonly trainedOn: number;
  readonly trainedAt: string | null;
};

export type MinilmLock = {
  readonly format: string;
  readonly model: string;
  readonly url: string;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly maxBytes: number;
  readonly dim: number;
  readonly maxSeqLen: number;
  readonly vocab: { readonly url: string; readonly sha256: string | null };
};

export const HEAD_FORMAT = "praxis-minilm-head/1";
export const LOCK_FORMAT = "praxis-minilm-lock/1";
const HEX64 = /^[0-9a-f]{64}$/; // threshold-ok: hex length of a SHA-256 digest
export const isSha = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/** The refusal texts, in plain words (D-1415). */
export const NOT_TRAINED = "The local classifier has not been trained yet";
export const NOT_PINNED = "The local classifier's model file has no pinned fingerprint yet";
export const MODEL_MISMATCH =
  "The local classifier was trained on a different model file than the pinned one";

/** Null when the value has the shape of a Head, else a short reason. Pure. */
export function headShapeProblem(h: unknown): string | null {
  if (typeof h !== "object" || h === null) return "not an object";
  const x = h as Partial<Head>;
  if (x.format !== HEAD_FORMAT) return "unknown format";
  if (typeof x.trained !== "boolean") return "trained flag missing";
  if (!Array.isArray(x.labels) || !x.labels.every((l) => typeof l === "string" && l.length > 0))
    return "labels";
  if (!Number.isInteger(x.dim) || (x.dim as number) < 1) return "dim";
  if (!Array.isArray(x.weights) || !Array.isArray(x.bias)) return "weights";
  if (!x.trained) return null;
  if (x.labels.length < 2) return "fewer than two labels";
  if (x.weights.length !== x.labels.length || x.bias.length !== x.labels.length) return "shape";
  for (const row of x.weights)
    if (
      !Array.isArray(row) ||
      row.length !== x.dim ||
      !row.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      return "weight row";
  if (!x.bias.every((n) => typeof n === "number" && Number.isFinite(n))) return "bias";
  return null;
}

/** Null when the lock is pinned (hash 64 lowercase hex, size within the cap), else the refusal text. */
export function lockProblem(lock: MinilmLock): string | null {
  if (!isSha(lock.sha256)) return NOT_PINNED;
  if (
    lock.sizeBytes !== null &&
    (!Number.isInteger(lock.sizeBytes) || lock.sizeBytes < 1 || lock.sizeBytes > lock.maxBytes)
  )
    return NOT_PINNED;
  return null;
}

/** Null when the shadow may run and the switch may go on, else the refusal text in plain words. Fails closed on any doubt. */
export function readinessProblem(head: unknown, lock: MinilmLock): string | null {
  if (headShapeProblem(head) !== null) return NOT_TRAINED;
  const h = head as Head;
  if (!h.trained) return NOT_TRAINED;
  const l = lockProblem(lock);
  if (l !== null) return l;
  if (h.dim !== lock.dim || h.modelSha !== lock.sha256) return MODEL_MISMATCH;
  return null;
}

/** Softmax, numerically stable. */
export function softmax(z: readonly number[]): number[] {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  const e = z.map((v) => Math.exp(v - m));
  let s = 0;
  for (const v of e) s += v;
  return e.map((v) => v / s);
}

export type Prediction = { label: string; prob: number; probs: number[] };

/** The class of one embedding: argmax of softmax(W e + b); the first label wins a tie. Throws on a shape error. */
export function predict(head: Head, emb: ArrayLike<number>): Prediction {
  if (emb.length !== head.dim) throw new Error("embedding length differs from the head");
  const z = head.weights.map((row, k) => {
    let s = head.bias[k]!;
    for (let i = 0; i < row.length; i++) s += row[i]! * emb[i]!;
    return s;
  });
  const probs = softmax(z);
  let best = 0;
  for (let k = 1; k < probs.length; k++) if (probs[k]! > probs[best]!) best = k;
  return { label: head.labels[best]!, prob: probs[best]!, probs };
}
