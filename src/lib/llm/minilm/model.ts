// The pinned MiniLM model file and its runtime (M22 L5, LLM-079, D-1414). The file is never committed: it is fetched into the
// runner's temp folder (production) or present in the fixtures lane, and is refused on a size or hash mismatch against
// model.lock.json. The runtime package is imported only here, only dynamically, so a missing or broken module fails closed
// (the shadow is off and the health line says it is unavailable) and nothing else in the app loads it. Node only.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import lockJson from "./model.lock.json";
import { isSha, lockProblem, type MinilmLock } from "./head";

export const LOCK: MinilmLock = lockJson as MinilmLock;

/** The one place the runtime package is named (a test keeps every other file in src free of it). */
export const RUNTIME_MODULE = "onnxruntime-node";

export type FileCheck = { ok: true; sha: string; size: number } | { ok: false; reason: string };

/** sha256 of a file by streaming (the model is tens of megabytes). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Size, then hash, against the lock. Never throws; an unpinned lock, a missing file, a size or hash mismatch all refuse. */
export async function verifyModelFile(path: string, lock: MinilmLock = LOCK): Promise<FileCheck> {
  const p = lockProblem(lock);
  if (p !== null) return { ok: false, reason: p };
  try {
    const size = (await stat(path)).size;
    if (size > lock.maxBytes) return { ok: false, reason: "the model file is above the size cap" };
    if (lock.sizeBytes !== null && size !== lock.sizeBytes)
      return { ok: false, reason: "the model file has the wrong size" };
    const sha = await sha256File(path);
    if (!isSha(sha) || sha !== lock.sha256)
      return { ok: false, reason: "the model file does not match its pinned fingerprint" };
    return { ok: true, sha, size };
  } catch {
    return { ok: false, reason: "the model file cannot be read" };
  }
}

/** The slice of the runtime this folder uses (typed here so no runtime types leak out of the folder). */
export type OrtTensorCtor = new (
  type: string,
  data: BigInt64Array,
  dims: readonly number[],
) => unknown;
export type OrtSession = {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>>;
  readonly inputNames: readonly string[];
};
export type Ort = {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: OrtTensorCtor;
};

export type LoadedModel =
  | { ok: true; session: OrtSession; Tensor: OrtTensorCtor; sha: string }
  | { ok: false; reason: string };

export type LoadDeps = {
  /** Test seam: replaces the dynamic import of the runtime. */
  readonly importRuntime?: () => Promise<unknown>;
  readonly lock?: MinilmLock;
};

const defaultImport = (): Promise<unknown> => import(/* webpackIgnore: true */ RUNTIME_MODULE);

/** Verifies the file, then loads the runtime and the model. Any failure is `{ ok: false, reason }`; nothing throws. */
export async function loadModel(modelPath: string, deps: LoadDeps = {}): Promise<LoadedModel> {
  const lock = deps.lock ?? LOCK;
  const file = await verifyModelFile(modelPath, lock);
  if (!file.ok) return file;
  try {
    const mod = (await (deps.importRuntime ?? defaultImport)()) as { default?: Ort } | Ort;
    const ort = ((mod as { default?: Ort }).default ?? mod) as Ort;
    const session = await ort.InferenceSession.create(modelPath);
    return { ok: true, session, Tensor: ort.Tensor, sha: file.sha };
  } catch {
    return { ok: false, reason: "the model runtime is not available" };
  }
}
