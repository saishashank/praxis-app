// @vitest-environment node
// SEC-108 d, AT-05b: the check logic table. The shared GitHub lookup is also covered by
// scripts/ci/approved-commit.test.mjs (unchanged).
import { describe, expect, it } from "vitest";
import { checkApprovedCommit } from "@/lib/watchdog/approvedCommit";
import { A, B, githubMock, TOKEN } from "./helpers";

const base = { repo: "o/r", token: TOKEN };

describe("checkApprovedCommit", () => {
  it("ok when the deployed commit is the latest approved deployment", async () => {
    const { fetchImpl } = githubMock([{ id: 2, sha: A, state: "success" }]);
    expect(await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: A })).toMatchObject({
      status: "ok",
      approvedSha: A,
      deployedSha: A,
    });
  });

  it("a newer pending deployment is ignored; the newest success decides", async () => {
    const { fetchImpl } = githubMock([
      { id: 3, sha: B, state: "pending" },
      { id: 2, sha: A, state: "success" },
    ]);
    expect((await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: A })).status).toBe(
      "ok",
    );
  });

  it("tolerates case and whitespace in APP_COMMIT", async () => {
    const { fetchImpl } = githubMock([{ id: 1, sha: A, state: "success" }]);
    const r = await checkApprovedCommit({
      ...base,
      fetchImpl,
      deployedCommit: ` ${A.toUpperCase()}\n`,
    });
    expect(r.status).toBe("ok");
  });

  it("awaiting_first_approval when no deployment is approved (even with APP_COMMIT missing)", async () => {
    const { fetchImpl } = githubMock([{ id: 1, sha: A, state: "pending" }]);
    expect(await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: B })).toMatchObject({
      status: "awaiting_first_approval",
      deployedSha: B,
    });
    const none = githubMock([]);
    const r = await checkApprovedCommit({
      ...base,
      fetchImpl: none.fetchImpl,
      deployedCommit: undefined,
    });
    expect(r.status).toBe("awaiting_first_approval");
    expect(r.deployedSha).toBeUndefined();
  });

  it("mismatch when the deployed commit differs", async () => {
    const { fetchImpl } = githubMock([{ id: 1, sha: A, state: "success" }]);
    expect(await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: B })).toMatchObject({
      status: "mismatch",
      approvedSha: A,
      deployedSha: B,
    });
  });

  it.each([undefined, "", "   ", "abc123", "z".repeat(40), `${A}0`])(
    "unknown (never ok) when APP_COMMIT is %j",
    async (deployedCommit) => {
      const { fetchImpl } = githubMock([{ id: 1, sha: A, state: "success" }]);
      const r = await checkApprovedCommit({ ...base, fetchImpl, deployedCommit });
      expect(r.status).toBe("unknown");
      expect(r.approvedSha).toBe(A);
    },
  );

  it.each([undefined, "", "  "])(
    "unknown without a network call when the token is %j",
    async (token) => {
      const { fetchImpl, calls } = githubMock([{ id: 1, sha: A, state: "success" }]);
      const r = await checkApprovedCommit({ repo: "o/r", token, fetchImpl, deployedCommit: A });
      expect(r.status).toBe("unknown");
      expect(calls).toHaveLength(0);
    },
  );

  it("unknown for an invalid repo name", async () => {
    const { fetchImpl, calls } = githubMock([]);
    const r = await checkApprovedCommit({
      ...base,
      repo: "no-slash",
      fetchImpl,
      deployedCommit: A,
    });
    expect(r.status).toBe("unknown");
    expect(calls).toHaveLength(0);
  });

  it.each([401, 403, 404, 503])(
    "unknown on GitHub HTTP %i, with only the status in detail",
    async (code) => {
      const { fetchImpl } = githubMock([], code);
      const r = await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: A });
      expect(r).toMatchObject({ status: "unknown", detail: `GitHub API returned HTTP ${code}` });
    },
  );

  it("unknown when fetch throws (the message, which may hold the token, is not copied)", async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: A });
    expect(r.status).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("unknown on a malformed approved SHA from GitHub", async () => {
    const { fetchImpl } = githubMock([{ id: 1, sha: "nope", state: "success" }]);
    expect((await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: A })).status).toBe(
      "unknown",
    );
  });

  it("sends the token only to api.github.com and never returns it", async () => {
    const { fetchImpl, calls } = githubMock([{ id: 1, sha: A, state: "success" }]);
    const r = await checkApprovedCommit({ ...base, fetchImpl, deployedCommit: B });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe("https://api.github.com");
      expect(c.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
