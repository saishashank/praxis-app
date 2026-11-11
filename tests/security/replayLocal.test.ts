// M18 OPS-107 / D-965: the nonce store serves a local file: database only on the recorded day.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TursoNonceStore } from "@/lib/security/replay";

const dirs: string[] = [];
async function localDb(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-nonce-"));
  dirs.push(dir);
  const url = pathToFileURL(path.join(dir, "main.db")).href;
  const db = createClient({ url });
  await db.execute(
    "CREATE TABLE request_nonce (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  );
  db.close();
  return url;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a just-closed libSQL file can stay locked on Windows; the run temp folder is removed anyway */
    }
  }
});

describe("TursoNonceStore on a local file (recorded day only)", () => {
  it("claims a nonce once, refuses the replay, and prunes expired nonces", async () => {
    vi.stubEnv("PRAXIS_ENV", "recorded");
    const url = await localDb();
    const store = new TursoNonceStore(url, undefined, fetch, () => 1_000);
    expect(await store.claim("n1", 2_000)).toBe(true);
    expect(await store.claim("n1", 2_000)).toBe(false);
    expect(await store.claim("n2", 2_000)).toBe(true);
    // an expired nonce is pruned by a later claim, so its id can be used again
    const later = new TursoNonceStore(url, undefined, fetch, () => 5_000);
    expect(await later.claim("n1", 9_000)).toBe(true);
  });

  it("a file: URL is NOT honoured outside the recorded environment (fails closed, no HTTP call)", async () => {
    const url = await localDb();
    const fetchImpl = vi.fn();
    for (const env of [undefined, "production", "staging"]) {
      vi.stubEnv("PRAXIS_ENV", env as string);
      const store = new TursoNonceStore(url, "t", fetchImpl as unknown as typeof fetch);
      await expect(store.claim("n1", 2_000)).rejects.toThrow("store misconfigured");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
