// @vitest-environment node
// Private data repo client (M2 T9; PLT-022a, DAT-140, D-048-style host pinning). A fake `fetch`
// stands in for GitHub: no real network, no real token.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HistoryConflict,
  HistoryError,
  MAX_FILE_BYTES,
  createHistoryStore,
} from "@/lib/data/backfill/dataRepo.mjs";

const TOKEN = "ghp_SYNTHETIC-token-never-printed";
const REPO = "synthetic-owner/praxis-app-data";
const LOC = {
  tag: "history-asic_short_interest-2026",
  asset: "asic_short_interest-2026-09.jsonl.gz",
};
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

type Call = { url: string; method: string; headers: Record<string, string>; init: RequestInit };
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function harness(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      init,
    });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, store: createHistoryStore({ repo: REPO, token: TOKEN, fetchImpl }) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const release = (assets: unknown[] = []) => ({ id: 7, tag_name: LOC.tag, assets });

describe("configuration", () => {
  it("accepts only <owner>/<name>-data and a non-empty token", () => {
    const f = (async () => json(200, {})) as unknown as typeof fetch;
    expect(() =>
      createHistoryStore({ repo: "o/praxis-app", token: TOKEN, fetchImpl: f }),
    ).toThrow();
    expect(() => createHistoryStore({ repo: "o/x-data/y", token: TOKEN, fetchImpl: f })).toThrow();
    expect(() => createHistoryStore({ repo: REPO, token: "", fetchImpl: f })).toThrow();
    expect(() => createHistoryStore({ repo: REPO, token: TOKEN, fetchImpl: f })).not.toThrow();
  });

  it("refuses unexpected locations and sizes before any request", async () => {
    const { store, calls } = harness(() => json(500, {}));
    await expect(store.put({ tag: "../evil", asset: LOC.asset }, BYTES)).rejects.toThrow();
    await expect(store.put({ tag: LOC.tag, asset: "../x.gz" }, BYTES)).rejects.toThrow();
    await expect(store.put(LOC, new Uint8Array(0))).rejects.toThrow();
    await expect(store.put(LOC, new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("put", () => {
  it("creates the release, uploads once, and pins hosts and options", async () => {
    const { store, calls } = harness((url, init) => {
      if (url.includes("/releases/tags/")) return json(404, {});
      if (url.endsWith("/releases") && init.method === "POST") return json(201, { id: 7 });
      if (url.includes("/assets?name=")) return json(201, {});
      return json(500, {});
    });
    await expect(store.put(LOC, BYTES)).resolves.toEqual({ result: "uploaded", sha256: SHA });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).hostname}`)).toEqual([
      "GET api.github.com",
      "POST api.github.com",
      "POST uploads.github.com",
    ]);
    for (const c of calls) {
      expect(c.url.startsWith("https://")).toBe(true);
      expect(c.url).toContain(`/repos/${REPO}/`);
      expect(c.init.redirect).toBe("error");
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      // the token travels only in the Authorization header
      expect(c.url).not.toContain(TOKEN);
      expect(String(c.init.body ?? "")).not.toContain(TOKEN);
    }
    const create = JSON.parse(String(calls[1].init.body));
    expect(create).toMatchObject({ tag_name: LOC.tag, draft: false, prerelease: false });
    expect(calls[2].url).toContain(`name=${LOC.asset}`);
  });

  it("skips a file that is already there with the same SHA-256 (idempotent)", async () => {
    const { store, calls } = harness(() =>
      json(
        200,
        release([{ name: LOC.asset, size: 5, digest: `sha256:${SHA}`, state: "uploaded" }]),
      ),
    );
    await expect(store.put(LOC, BYTES)).resolves.toEqual({ result: "skipped", sha256: SHA });
    expect(calls).toHaveLength(1);
  });

  it("falls back to the size when GitHub gives no digest", async () => {
    const same = harness(() => json(200, release([{ name: LOC.asset, size: 5 }])));
    await expect(same.store.put(LOC, BYTES)).resolves.toMatchObject({ result: "skipped" });
    const other = harness(() => json(200, release([{ name: LOC.asset, size: 6 }])));
    await expect(other.store.put(LOC, BYTES)).rejects.toBeInstanceOf(HistoryConflict);
  });

  it("never overwrites: different content, or an unfinished upload, is a conflict", async () => {
    const diff = harness(() =>
      json(
        200,
        release([
          { name: LOC.asset, size: 5, digest: `sha256:${"0".repeat(64)}`, state: "uploaded" },
        ]),
      ),
    );
    await expect(diff.store.put(LOC, BYTES)).rejects.toBeInstanceOf(HistoryConflict);
    expect(diff.calls).toHaveLength(1); // no upload, no delete
    const half = harness(() =>
      json(200, release([{ name: LOC.asset, size: 5, digest: `sha256:${SHA}`, state: "starter" }])),
    );
    await expect(half.store.put(LOC, BYTES)).rejects.toBeInstanceOf(HistoryConflict);
    expect([...diff.calls, ...half.calls].every((c) => c.method === "GET")).toBe(true);
  });

  it("uploads next to other months already in the release", async () => {
    const { store, calls } = harness((url) =>
      url.includes("/assets?name=")
        ? json(201, {})
        : json(200, release([{ name: "asic_short_interest-2026-08.jsonl.gz", size: 9 }])),
    );
    await expect(store.put(LOC, BYTES)).resolves.toMatchObject({ result: "uploaded" });
    expect(calls).toHaveLength(2);
  });

  it("a lost race when creating the release reads it back", async () => {
    let gets = 0;
    const { store } = harness((url, init) => {
      if (url.includes("/releases/tags/"))
        return ++gets === 1 ? json(404, {}) : json(200, release());
      if (init.method === "POST" && url.endsWith("/releases")) return json(422, {});
      return json(201, {});
    });
    await expect(store.put(LOC, BYTES)).resolves.toMatchObject({ result: "uploaded" });
  });
});

describe("errors never carry a URL, a token or a body", () => {
  const cases: [string, Handler][] = [
    ["get_release 500", () => json(500, { message: TOKEN })],
    ["bad release json", () => new Response("not json", { status: 200 })],
    ["wrong release", () => json(200, { id: "x", tag_name: "other" })],
    [
      "create_release 403",
      (url, init) => (init.method === "POST" ? json(403, { message: TOKEN }) : json(404, {})),
    ],
    [
      "upload 500",
      (url) =>
        url.includes("/assets?name=") ? json(500, { message: TOKEN }) : json(200, release()),
    ],
    [
      "create 422 then still missing",
      (url, init) => (init.method === "POST" ? json(422, {}) : json(404, {})),
    ],
    [
      "network failure",
      () => {
        throw new Error(`connect ECONNREFUSED https://api.github.com/?${TOKEN}`);
      },
    ],
  ];
  it.each(cases)("%s", async (_name, handler) => {
    const { store } = harness(handler);
    const err = await store.put(LOC, BYTES).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HistoryError);
    const text = String((err as Error).message) + JSON.stringify(err);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("github.com");
    expect(text).not.toContain("http");
  });
});
