// Shared fixtures of the MiniLM tests (M22 L5): a fake embedder (no model file, no runtime), a tiny trained head and a pinned
// lock, all synthetic (ZZ, SEC-110).
import type { Embedder } from "@/lib/llm/minilm/embed";
import type { Head, MinilmLock } from "@/lib/llm/minilm/head";

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export const lockOf = (sha: string | null = SHA_A): MinilmLock => ({
  format: "praxis-minilm-lock/1",
  model: "zz-model",
  url: "https://example.invalid/model",
  sha256: sha,
  sizeBytes: null,
  maxBytes: 100_000_000,
  dim: 4,
  maxSeqLen: 16,
  vocab: { url: "https://example.invalid/vocab", sha256: null },
});

/** Two labels over four dimensions: the first two dimensions vote "halt_suspension", the last two "other". */
export const headOf = (over: Partial<Head> = {}): Head => ({
  format: "praxis-minilm-head/1",
  trained: true,
  labels: ["other", "halt_suspension"],
  dim: 4,
  modelSha: SHA_A,
  weights: [
    [0, 0, 4, 4],
    [4, 4, 0, 0],
  ],
  bias: [0, 0],
  trainedOn: 100,
  trainedAt: "2030-01-01",
  ...over,
});

/** "halt" in the text reads as the first direction, anything else as the second. */
export function fakeEmbedder(over: Partial<Embedder> = {}): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    dim: 4,
    modelSha: SHA_A,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => (/halt/i.test(t) ? [0.7, 0.7, 0, 0] : [0, 0, 0.7, 0.7]));
    },
    ...over,
  };
}

/**
 * A database view that answers the shadow's one announcement read with the given rows and passes everything else through
 * (used on the golden AT-32 world, whose `announcement` table is hashed and must not gain a row).
 */
export function withAnnouncements<
  T extends {
    execute: (s: never) => Promise<unknown>;
    batch: (s: never, m?: never) => Promise<unknown>;
  },
>(db: T, rows: Array<{ source: string; ann_id: string; type: string | null; title: string }>): T {
  return {
    execute: (s: { sql?: string } | string) => {
      const sql = typeof s === "string" ? s : (s.sql ?? "");
      if (/FROM announcement a/.test(sql)) return Promise.resolve({ rows });
      return db.execute(s as never);
    },
    batch: (s: never, m?: never) => db.batch(s, m),
  } as unknown as T;
}
