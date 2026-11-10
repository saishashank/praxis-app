// @vitest-environment node
// INFRA T3 (REQ\infra\INFRA_REQUIREMENT.md §5.1): the fetch shim of the clock. A GitHub workflow dispatch
// becomes a local job (204 like GitHub), except replay.yml which goes to the real API; the https stand-in
// origins of the Worker runners are mapped to the real http origins; everything else passes through.
import { describe, expect, it } from "vitest";
import { dispatchWorkflow } from "../../worker/src/dispatch";
import { makeClockFetch, originMapped, type Dispatch } from "../../clock/shim";

const GH = "https://api.github.com/repos/saishashank/praxis-app/actions/workflows";

function setup(enqueueResult: "queued" | "duplicate" | "unknown-job" = "queued") {
  const real: { url: string; init?: RequestInit }[] = [];
  const dispatches: Dispatch[] = [];
  const logs: string[] = [];
  const f = makeClockFetch({
    realFetch: (async (u: string | URL | Request, init?: RequestInit) => {
      real.push({ url: String(u), init });
      return new Response("real", { status: 200 });
    }) as typeof fetch,
    enqueue: (d) => {
      dispatches.push(d);
      return enqueueResult;
    },
    passthrough: ["replay.yml"],
    origins: {
      "https://web:3000": "http://web:3000",
      "https://main.sqld:8080": "http://main.sqld:8080",
    },
    log: (l) => logs.push(l),
  });
  return { f, real, dispatches, logs };
}

const post = (f: typeof fetch, wf: string, body: unknown) =>
  f(`${GH}/${wf}/dispatches`, {
    method: "POST",
    headers: { Authorization: "Bearer gh-secret-token-123" },
    body: JSON.stringify(body),
  });

describe("workflow dispatch becomes a local job", () => {
  it("answers 204, queues the job with its inputs and the ref, and never reaches the network", async () => {
    const { f, real, dispatches } = setup();
    const res = await post(f, "maintenance.yml", { ref: "release" });
    expect(res.status).toBe(204);
    expect(dispatches).toEqual([{ workflow: "maintenance.yml", ref: "release", inputs: {} }]);
    const res2 = await post(f, "watchdog.yml", { ref: "release", inputs: { slot: "2040", n: 5 } });
    expect(res2.status).toBe(204);
    expect(dispatches[1]).toEqual({
      workflow: "watchdog.yml",
      ref: "release",
      inputs: { slot: "2040", n: "5" },
    });
    expect(real).toEqual([]);
  });

  it("a duplicate is still a 204 (GitHub also accepts a second dispatch)", async () => {
    const { f } = setup("duplicate");
    expect((await post(f, "backup.yml", { ref: "release" })).status).toBe(204);
  });

  it("a workflow that has no manifest job answers 404 like an unknown workflow", async () => {
    const { f, real } = setup("unknown-job");
    expect((await post(f, "ci.yml", { ref: "release" })).status).toBe(404);
    expect(real).toEqual([]);
  });

  it("a body that is not JSON answers 400 and queues nothing", async () => {
    const { f, dispatches } = setup();
    const res = await f(`${GH}/backup.yml/dispatches`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect(dispatches).toEqual([]);
  });

  it("works through the Worker's own dispatchWorkflow, and logs no token", async () => {
    const { f, dispatches, logs } = setup();
    const r = await dispatchWorkflow(
      { PRAXIS_ENV: "production", GITHUB_DISPATCH_TOKEN: "gh-secret-token-123" },
      "arena-close.yml",
      f,
    );
    expect(r).toEqual({ ok: true, detail: "HTTP 204" });
    expect(dispatches).toEqual([{ workflow: "arena-close.yml", ref: "release", inputs: {} }]);
    expect(logs.join("\n")).not.toContain("gh-secret-token-123");
  });
});

describe("replay.yml passes through to the real GitHub API", () => {
  it("sends the same request (URL, method, headers, body) to the real fetch and queues nothing", async () => {
    const { f, real, dispatches } = setup();
    const res = await post(f, "replay.yml", { ref: "release", inputs: { mode: "full" } });
    expect(res.status).toBe(200); // the real fetch's answer
    expect(dispatches).toEqual([]);
    expect(real).toHaveLength(1);
    expect(real[0]!.url).toBe(`${GH}/replay.yml/dispatches`);
    expect(real[0]!.init?.method).toBe("POST");
    expect((real[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer gh-secret-token-123",
    );
    expect(JSON.parse(String(real[0]!.init?.body))).toEqual({
      ref: "release",
      inputs: { mode: "full" },
    });
  });

  it("a GET of the dispatches URL is not a dispatch and passes through", async () => {
    const { f, real, dispatches } = setup();
    await f(`${GH}/maintenance.yml/dispatches`, { method: "GET" });
    expect(dispatches).toEqual([]);
    expect(real).toHaveLength(1);
  });
});

describe("origins and other calls", () => {
  it("maps a stand-in https origin to the real http origin; keeps path, query, headers and body", async () => {
    const { f, real } = setup();
    await f("https://web:3000/api/internal/morning?x=1", {
      method: "POST",
      headers: { "X-Sig": "abc" },
      body: "{}",
    });
    await f("https://main.sqld:8080/v2/pipeline", { method: "POST", body: "{}" });
    expect(real.map((r) => r.url)).toEqual([
      "http://web:3000/api/internal/morning?x=1",
      "http://main.sqld:8080/v2/pipeline",
    ]);
    expect((real[0]!.init?.headers as Record<string, string>)["X-Sig"]).toBe("abc");
  });

  it("any other URL passes through untouched", async () => {
    const { f, real } = setup();
    await f("https://api.resend.com/emails", { method: "POST", body: "{}" });
    await f("https://api.github.com/repos/saishashank/praxis-app/actions/workflows", {});
    expect(real.map((r) => r.url)).toEqual([
      "https://api.resend.com/emails",
      "https://api.github.com/repos/saishashank/praxis-app/actions/workflows",
    ]);
  });

  it("originMapped: unmapped and invalid URLs give null; a trailing slash on the target is fine", () => {
    expect(originMapped("https://other:1/x", { "https://web:3000": "http://web:3000" })).toBeNull();
    expect(originMapped("not a url", {})).toBeNull();
    expect(originMapped("https://web:3000/a?b=c", { "https://web:3000": "http://web:3000/" })).toBe(
      "http://web:3000/a?b=c",
    );
  });
});
