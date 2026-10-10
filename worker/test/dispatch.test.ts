import { describe, expect, it } from "vitest";
import {
  CODE_REPO,
  DISPATCH_TIMEOUT_MS,
  dispatchWorkflow,
  isDispatchable,
  refFor,
} from "../src/dispatch";

const TOKEN = "ghp_TOPSECRET_dispatch_value";
type Seen = { url: string; init: RequestInit };

function fetcher(status: number | "throw" | "abort", seen: Seen[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (status === "throw") throw new Error(`boom ${TOKEN}`);
    if (status === "abort") {
      const e = new Error(`aborted ${TOKEN}`);
      e.name = "TimeoutError";
      throw e;
    }
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

describe("dispatchWorkflow (PLT-071, SEC-017 b / b-s)", () => {
  it("POSTs {ref: release} for production with the documented headers and expects 204", async () => {
    const seen: Seen[] = [];
    const r = await dispatchWorkflow(
      { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: TOKEN },
      "backup.yml",
      fetcher(204, seen),
    );
    expect(r).toEqual({ ok: true, detail: "HTTP 204" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      `https://api.github.com/repos/${CODE_REPO}/actions/workflows/backup.yml/dispatches`,
    );
    const init = seen[0].init;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "release" });
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "praxis-sentinel-clock",
    });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DISPATCH_TIMEOUT_MS).toBe(10_000);
  });

  it("staging dispatches ref main; an unknown environment dispatches nothing", async () => {
    const seen: Seen[] = [];
    await dispatchWorkflow(
      { PRAXIS_ENV: "staging", GITHUB_DISPATCH_TOKEN: TOKEN },
      "maintenance.yml",
      fetcher(204, seen),
    );
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ ref: "main" });
    expect(refFor("production")).toBe("release");
    expect(refFor("staging")).toBe("main");
    for (const e of ["", "Production", "preview", "development", "release"]) {
      expect(refFor(e)).toBeNull();
    }
    const n: Seen[] = [];
    const r = await dispatchWorkflow(
      { PRAXIS_ENV: "preview", GITHUB_DISPATCH_TOKEN: TOKEN },
      "backup.yml",
      fetcher(204, n),
    );
    expect(r).toEqual({ ok: false, detail: "unknown-environment" });
    expect(n).toHaveLength(0);
  });

  it("refuses everything outside the allow-list, including path tricks", async () => {
    const seen: Seen[] = [];
    for (const w of [
      "",
      "deploy-production.yml",
      "ingest-batch1.yml",
      "../backup.yml",
      "backup.yml/../x.yml",
      "backup.yml?x=1",
      "BACKUP.yml",
      "backup.yaml",
      " backup.yml",
      "backup.yml\n",
      "backup",
    ]) {
      const r = await dispatchWorkflow(
        { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: TOKEN },
        w,
        fetcher(204, seen),
      );
      expect(r, JSON.stringify(w)).toEqual({ ok: false, detail: "workflow-not-allowed" });
    }
    expect(seen).toHaveLength(0);
    expect(isDispatchable("backup.yml")).toBe(true);
    expect(isDispatchable("maintenance.yml")).toBe(true);
  });

  it("a missing or blank token fails without a request", async () => {
    const seen: Seen[] = [];
    for (const t of [undefined, "", "   "]) {
      const r = await dispatchWorkflow(
        { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: t },
        "backup.yml",
        fetcher(204, seen),
      );
      expect(r).toEqual({ ok: false, detail: "token-missing" });
    }
    expect(seen).toHaveLength(0);
  });

  it("only 204 is success; every other status and any exception is a failure without the token", async () => {
    for (const s of [200, 201, 202, 301, 401, 403, 404, 422, 429, 500, 503]) {
      const r = await dispatchWorkflow(
        { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: TOKEN },
        "backup.yml",
        fetcher(s),
      );
      expect(r).toEqual({ ok: false, detail: `HTTP ${s}` });
    }
    for (const how of ["throw", "abort"] as const) {
      const r = await dispatchWorkflow(
        { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: TOKEN },
        "backup.yml",
        fetcher(how),
      );
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("TOPSECRET");
    }
    const r = await dispatchWorkflow(
      { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: TOKEN },
      "backup.yml",
      fetcher("abort"),
    );
    expect(r).toEqual({ ok: false, detail: "TimeoutError" });
  });
});
