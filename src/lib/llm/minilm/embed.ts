// Sentence embeddings for the MiniLM shadow (M22 L5, LLM-079, D-1414): a plain WordPiece tokenizer (uncased BERT rules), the
// model call, mean pooling over the attention mask and unit-length scaling. `Embedder` is the one seam: the shadow, the CLI
// and the tests all take it, so the shadow harness runs with a fake embedder and no model file.
import type { LoadedModel } from "./model";

export type Embedder = {
  readonly dim: number;
  /** sha256 of the model file the vectors come from (stored beside every shadow row). */
  readonly modelSha: string;
  embed(texts: readonly string[]): Promise<number[][]>;
};

const UNK = "[UNK]";
const MAX_WORD_CHARS = 100;

/** Uncased BERT basic tokenization: lowercase, accents stripped, punctuation and symbols split off. Pure. */
export function basicTokens(text: string): string[] {
  const clean = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const out: string[] = [];
  let cur = "";
  for (const ch of clean) {
    if (/\s/u.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else if (/[\p{P}\p{S}]/u.test(ch)) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Greedy longest-match WordPiece ids of `text`, wrapped in [CLS] ... [SEP] and cut to `maxLen`. Pure. */
export function wordPieceIds(
  text: string,
  vocab: ReadonlyMap<string, number>,
  maxLen: number,
): number[] {
  const cls = vocab.get("[CLS]");
  const sep = vocab.get("[SEP]");
  const unk = vocab.get(UNK);
  if (cls === undefined || sep === undefined || unk === undefined)
    throw new Error("vocabulary lacks the special tokens");
  const ids: number[] = [cls];
  for (const word of basicTokens(text)) {
    const chars = Array.from(word);
    if (chars.length > MAX_WORD_CHARS) {
      ids.push(unk);
      continue;
    }
    const pieces: number[] = [];
    let start = 0;
    let bad = false;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
        const id = vocab.get(sub);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found === undefined) {
        bad = true;
        break;
      }
      pieces.push(found);
      start = end;
    }
    if (bad) ids.push(unk);
    else ids.push(...pieces);
  }
  ids.length = Math.min(ids.length, maxLen - 1);
  ids.push(sep);
  return ids;
}

/** `vocab.txt` (one token per line, the line number is the id) into token -> id. */
export function parseVocab(text: string): Map<string, number> {
  const m = new Map<string, number>();
  text.split(/\r?\n/).forEach((t, i) => {
    if (t !== "" && !m.has(t)) m.set(t, i);
  });
  return m;
}

/** Mean of the hidden states over the attended positions, scaled to unit length. Pure. `hidden` is seq x dim, row-major. */
export function meanPoolNormalize(
  hidden: ArrayLike<number>,
  mask: readonly number[],
  dim: number,
): number[] {
  const out = new Array<number>(dim).fill(0);
  let n = 0;
  for (let t = 0; t < mask.length; t++) {
    if (mask[t] !== 1) continue;
    n++;
    for (let i = 0; i < dim; i++) out[i]! += hidden[t * dim + i]!;
  }
  if (n === 0) return out;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    out[i] = out[i]! / n;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  return norm === 0 ? out : out.map((v) => v / norm);
}

/** The real embedder over a loaded model; one text per run (announcement titles are short, so no padding is needed). */
export function onnxEmbedder(
  model: Extract<LoadedModel, { ok: true }>,
  vocab: ReadonlyMap<string, number>,
  dim: number,
  maxLen: number,
): Embedder {
  return {
    dim,
    modelSha: model.sha,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) {
        const ids = wordPieceIds(text, vocab, maxLen);
        const len = ids.length;
        const big = (f: (i: number) => number) =>
          BigInt64Array.from({ length: len }, (_, i) => BigInt(f(i)));
        const dims = [1, len];
        const feeds: Record<string, unknown> = {
          input_ids: new model.Tensor(
            "int64",
            big((i) => ids[i]!),
            dims,
          ),
          attention_mask: new model.Tensor(
            "int64",
            big(() => 1),
            dims,
          ),
        };
        if (model.session.inputNames.includes("token_type_ids"))
          feeds.token_type_ids = new model.Tensor(
            "int64",
            big(() => 0),
            dims,
          );
        const res = await model.session.run(feeds);
        const hidden = res.last_hidden_state ?? Object.values(res)[0];
        if (!hidden || hidden.dims[hidden.dims.length - 1] !== dim)
          throw new Error("unexpected model output");
        out.push(meanPoolNormalize(hidden.data, new Array<number>(len).fill(1), dim));
      }
      return out;
    },
  };
}
