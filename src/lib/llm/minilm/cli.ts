// Command-line entry of the MiniLM shadow (M22 L5, LLM-079, D-1414…D-1416). Hands back nothing but an exit code and one summary
// line (counts only): a fault never fails the night (exit 0, "degraded" or "unavailable"), and nothing here feeds a decision.
//
//   minilm [shadow] [--date YYYY-MM-DD] --model <model.onnx> --vocab <vocab.txt>
//   minilm embed --in <items.jsonl> --out <embeddings.jsonl> --model <model.onnx> --vocab <vocab.txt>
//
// `shadow` runs only when `minilm_enabled` is "on", a trained head is committed, the model file matches its lock and the
// runtime loads; otherwise it says why and writes nothing. `embed` is the build-machine step before scripts/llm/minilm-train.mjs
// (items are {type, title}; the label is the rule classifier's); it writes vectors, never text. env: TURSO_MAIN_URL,
// TURSO_MAIN_TOKEN (shadow only). Wired into the nightly job by L4; this file is the entry (`minilmMain`).
import { readFile, writeFile } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { classifyAnnouncement } from "@/lib/agents/events";
import { getConfig } from "@/lib/config/store";
import { marketDate } from "@/lib/data/calendar";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { HOME_MARKET, HOME_TZ } from "@/lib/market/homeMarket.mjs";
import { onnxEmbedder, parseVocab, type Embedder } from "./embed";
import { readinessProblem, type Head, type MinilmLock } from "./head";
import headJson from "./head.weights.json";
import { LOCK, loadModel, sha256File } from "./model";
import { shadowNight, shadowSummary, textOf } from "./shadow";

export type MinilmCliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
  /** Test seam: replaces loading the model file (default: verify, load the runtime, read the vocabulary). */
  readonly loadEmbedder?: (modelPath: string, vocabPath: string) => Promise<Embedder | string>;
  readonly head?: Head;
  readonly lock?: MinilmLock;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1]! : null;
}

/** The real embedder: the file is verified against the lock, the vocabulary against the lock when it has a hash. */
export async function loadRealEmbedder(
  modelPath: string,
  vocabPath: string,
): Promise<Embedder | string> {
  const model = await loadModel(modelPath);
  if (!model.ok) return model.reason;
  try {
    if (LOCK.vocab.sha256 !== null && (await sha256File(vocabPath)) !== LOCK.vocab.sha256)
      return "the vocabulary file does not match its pinned fingerprint";
    const vocab = parseVocab(await readFile(vocabPath, "utf8"));
    return onnxEmbedder(model, vocab, LOCK.dim, LOCK.maxSeqLen);
  } catch {
    return "the vocabulary file cannot be read";
  }
}

async function embedMain(
  argv: readonly string[],
  deps: MinilmCliDeps,
  out: (s: string) => void,
): Promise<number> {
  const inFile = flag(argv, "--in");
  const outFile = flag(argv, "--out");
  const model = flag(argv, "--model");
  const vocab = flag(argv, "--vocab");
  if (inFile === null || outFile === null || model === null || vocab === null) {
    out("minilm embed: needs --in, --out, --model and --vocab");
    return 2;
  }
  const e = await (deps.loadEmbedder ?? loadRealEmbedder)(model, vocab);
  if (typeof e === "string") {
    out(`minilm embed: unavailable (${e})`);
    return 2;
  }
  const items = (await readFile(inFile, "utf8"))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type?: string | null; title: string; label?: string });
  const vectors = await e.embed(items.map((i) => textOf(i.type ?? null, i.title)));
  const lines = [
    JSON.stringify({ format: "praxis-minilm-emb/1", modelSha: e.modelSha, dim: e.dim }),
  ];
  items.forEach((it, i) =>
    lines.push(
      JSON.stringify({
        label: it.label ?? classifyAnnouncement(it.type ?? null, it.title).category,
        embedding: vectors[i]!.map((v) => Math.round(v * 1e6) / 1e6),
      }),
    ),
  );
  await writeFile(outFile, `${lines.join("\n")}\n`);
  out(`minilm embed: ${items.length} items written`);
  return 0;
}

export async function minilmMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: MinilmCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  if (argv.includes("--replay") || argv.includes("--recorded")) return 0;
  if (argv[0] === "embed") return embedMain(argv.slice(1), deps, out);
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("minilm-shadow: degraded (database not configured)");
    return 0;
  }
  let db: Client;
  try {
    const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
    db = open(url, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  } catch {
    out("minilm-shadow: degraded (cannot open database)");
    return 0;
  }
  const head = deps.head ?? (headJson as unknown as Head);
  const lock = deps.lock ?? LOCK;
  const d = flag(argv, "--date") ?? marketDate(new Date((deps.nowMs ?? Date.now)()), HOME_TZ);
  try {
    const enabled = (await getConfig(db, "minilm_enabled")) === "on";
    const cap = Number(await getConfig(db, "news_assess_per_run"));
    let embedder: Embedder | null = null;
    let loadFault: string | null = null;
    // the model is loaded only when the shadow could run at all (on, a trained head, a pinned lock)
    if (enabled && readinessProblem(head, lock) === null) {
      const model = flag(argv, "--model");
      const vocab = flag(argv, "--vocab");
      if (model === null || vocab === null) loadFault = "no model file given";
      else {
        const e = await (deps.loadEmbedder ?? loadRealEmbedder)(model, vocab);
        if (typeof e === "string") loadFault = e;
        else embedder = e;
      }
    }
    const r = await shadowNight(db, {
      market: HOME_MARKET,
      d,
      enabled,
      cap: Number.isFinite(cap) ? cap : 0,
      head,
      lock,
      embedder,
      now: new Date((deps.nowMs ?? Date.now)()).toISOString(),
    });
    out(
      shadowSummary(
        HOME_MARKET,
        d,
        loadFault !== null && r.status === "unavailable" ? { ...r, reason: loadFault } : r,
      ),
    );
  } catch {
    out("minilm-shadow: degraded (the stage failed; nothing was changed for the night)");
  }
  return 0;
}
