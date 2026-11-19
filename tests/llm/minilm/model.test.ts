// @vitest-environment node
// M22 L5 (LLM-079, D-1414): the model file is verified against the lock and every fault fails closed; the runtime is imported
// dynamically and its absence is a reason, not a throw. No model file is needed: a small stand-in file is hashed.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCK, loadModel, verifyModelFile } from "@/lib/llm/minilm/model";
import { lockOf } from "./helpers";

const dir = mkdtempSync(path.join(tmpdir(), "minilm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "zz.bin");
writeFileSync(file, "zz stand-in model bytes");
const sha = createHash("sha256").update("zz stand-in model bytes").digest("hex");

describe("committed lock", () => {
  it("is not pinned yet, so nothing can load (D-1500)", async () => {
    expect(LOCK.sha256).toBeNull();
    expect((await verifyModelFile(file)).ok).toBe(false);
    expect((await loadModel(file)).ok).toBe(false);
  });
});

describe("verifyModelFile", () => {
  it("accepts the pinned bytes", async () => {
    expect(await verifyModelFile(file, lockOf(sha))).toEqual({ ok: true, sha, size: 23 });
  });
  it("refuses a hash mismatch, a wrong size, an oversize file and a missing file", async () => {
    expect((await verifyModelFile(file, lockOf("d".repeat(64)))).ok).toBe(false);
    expect((await verifyModelFile(file, { ...lockOf(sha), sizeBytes: 5 })).ok).toBe(false);
    expect((await verifyModelFile(file, { ...lockOf(sha), maxBytes: 5 })).ok).toBe(false);
    expect((await verifyModelFile(path.join(dir, "none"), lockOf(sha))).ok).toBe(false);
  });
});

describe("loadModel", () => {
  it("a missing runtime fails closed with a reason", async () => {
    const r = await loadModel(file, {
      lock: lockOf(sha),
      importRuntime: () => Promise.reject(new Error("Cannot find module")),
    });
    expect(r).toEqual({ ok: false, reason: "the model runtime is not available" });
  });
  it("a hash mismatch never reaches the runtime", async () => {
    let imported = false;
    const r = await loadModel(file, {
      lock: lockOf("e".repeat(64)),
      importRuntime: () => {
        imported = true;
        return Promise.resolve({});
      },
    });
    expect(r.ok).toBe(false);
    expect(imported).toBe(false);
  });
  it("loads through a fake runtime", async () => {
    class T {}
    const session = { inputNames: [], run: () => Promise.resolve({}) };
    const r = await loadModel(file, {
      lock: lockOf(sha),
      importRuntime: () =>
        Promise.resolve({
          default: { InferenceSession: { create: () => Promise.resolve(session) }, Tensor: T },
        }),
    });
    expect(r.ok).toBe(true);
  });
});
