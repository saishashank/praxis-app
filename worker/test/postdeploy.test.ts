// D-195: the first tick of a newly deployed commit dispatches the post-deploy fill once (ASX fetch
// with history, full replay); inert elsewhere; a failed dispatch is retried at most three times.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPostDeploy, resetPostDeploy, postDeployKey, MAX_ATTEMPTS } from "../src/postdeploy";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const COMMIT = "a".repeat(40);
const ENV = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  BUILD_COMMIT: COMMIT,
};

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
const deps = () => ({ fetch: net.f, nowMs: () => Date.parse("2026-10-27T01:00:00Z") });
const enable = () =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
    )
    .run();
const state = () =>
  rows(db, "SELECT value_json FROM worker_state WHERE key = ?", postDeployKey(COMMIT)) as {
    value_json: string;
  }[];

beforeEach(() => {
  resetPostDeploy();
  db = makeDb();
  net = makeNet(db);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("runPostDeploy", () => {
  it("dispatches the ASX history fill and the full replay once for a new commit", async () => {
    enable();
    expect(await runPostDeploy(ENV, deps())).toBe("dispatched");
    expect(net.github.map((c) => c.url.split("/workflows/")[1])).toEqual([
      "asx-fetch.yml/dispatches",
      "replay.yml/dispatches",
    ]);
    expect(net.github.map((c) => JSON.parse(c.body))).toEqual([
      { ref: "release", inputs: { history: "true" } },
      { ref: "release", inputs: { mode: "full" } },
    ]);
    expect(JSON.parse(state()[0]!.value_json)).toMatchObject({ s: "dispatched", n: 1 });
    // the same isolate: no request at all
    const before = net.calls.length;
    expect(await runPostDeploy(ENV, deps())).toBe("done");
    expect(net.calls.length).toBe(before);
    // a fresh isolate reads the record and does nothing
    resetPostDeploy();
    expect(await runPostDeploy(ENV, deps())).toBe("done");
    expect(net.github).toHaveLength(2);
  });

  it("is inert outside production, without a commit or a database, and waits for the dispatch switch", async () => {
    expect(await runPostDeploy({ ...ENV, PRAXIS_ENV: "staging" }, deps())).toBe("inert");
    expect(await runPostDeploy({ ...ENV, BUILD_COMMIT: "dev" }, deps())).toBe("inert");
    expect(await runPostDeploy({ ...ENV, TURSO_MAIN_URL: undefined }, deps())).toBe("inert");
    expect(net.calls).toHaveLength(0);
    expect(await runPostDeploy(ENV, deps())).toBe("not-enabled");
    expect(net.github).toHaveLength(0);
  });

  it("retries a failed dispatch on later ticks, at most three times, and never prints the token", async () => {
    enable();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void logs.push(s));
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      net.githubPlan.push(500, 204);
      resetPostDeploy();
      expect(await runPostDeploy(ENV, deps())).toBe("failed");
      expect(JSON.parse(state()[0]!.value_json)).toMatchObject({ s: "failed", n: i });
    }
    resetPostDeploy();
    expect(await runPostDeploy(ENV, deps())).toBe("done");
    expect(net.github).toHaveLength(2 * MAX_ATTEMPTS);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
