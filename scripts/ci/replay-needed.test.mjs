// D-905: the post-deploy replay runs only when the deploy changed replay inputs; unknown means run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { needsReplay, run } from "./replay-needed.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ENV = { GITHUB_TOKEN: "tok", GITHUB_REPOSITORY: "o/praxis-app", CURRENT_SHA: A };

/** A fake GitHub: deployments newest first (sha, state), and the compare answer. */
function fake(deploys, compare) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = new URL(String(url));
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.pathname.endsWith("/deployments")) {
      return json(
        deploys.map((d, i) => ({ sha: d[0], statuses_url: `https://api.github.com/s/${i}` })),
      );
    }
    if (u.pathname.startsWith("/s/"))
      return json([{ state: deploys[Number(u.pathname.slice(3))][1] }]);
    if (u.pathname.includes("/compare/"))
      return compare === "error" ? json({}, 500) : json(compare);
    return json({}, 404);
  };
  return { f, calls };
}

async function runWith(env, f) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-rn-"));
  try {
    const file = path.join(dir, "out");
    const lines = [];
    const code = await run({ ...env, GITHUB_OUTPUT: file }, f, (l) => lines.push(l));
    return { code, out: readFileSync(file, "utf8"), lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("needsReplay: strategy, data shaping, statistics and schema paths count; UI and docs do not", () => {
  assert.equal(needsReplay(["src/lib/agents/families/exits.ts"]), true);
  assert.equal(needsReplay(["db/migrations/main/0029_x.sql"]), true);
  assert.equal(needsReplay(["src/lib/data/calendar.ts"]), true);
  assert.equal(needsReplay(["scripts/replay/run.mjs"]), true);
  assert.equal(
    needsReplay(["src/app/(app)/home/HomeContent.tsx", "docs/M17_design.md", "src/lib/ui/x.ts"]),
    false,
  );
  assert.equal(needsReplay(["src/lib/data/calendarSeed.ts"]), false);
  assert.equal(needsReplay([]), false);
  assert.equal(needsReplay(null), true);
});

test("a UI-only deploy skips the replay; the compare is against the approved deploy before", async () => {
  const { f, calls } = fake(
    [
      [A, "success"],
      [B, "success"],
    ],
    { status: "ahead", files: [{ filename: "src/app/page.tsx" }] },
  );
  const r = await runWith(ENV, f);
  assert.equal(r.code, 0);
  assert.equal(r.out, "run=false\n");
  assert.ok(calls.some((c) => c.url.endsWith(`/compare/${B}...${A}`)));
  for (const c of calls) assert.equal(c.auth, "Bearer tok");
});

test("a strategy change runs it; a failed deploy in between is skipped over", async () => {
  const { f } = fake(
    [
      [A, "success"],
      ["c".repeat(40), "failure"],
      [B, "success"],
    ],
    { status: "ahead", files: [{ filename: "src/lib/cortex/run.ts" }] },
  );
  assert.equal((await runWith(ENV, f)).out, "run=true\n");
});

test("unknown means run: first deploy, a cut list, an API error, a bad commit", async () => {
  assert.equal((await runWith(ENV, fake([[A, "success"]], {}).f)).out, "run=true\n");
  const many = { status: "ahead", files: Array.from({ length: 300 }, () => ({ filename: "x" })) };
  assert.equal(
    (
      await runWith(
        ENV,
        fake(
          [
            [A, "success"],
            [B, "success"],
          ],
          many,
        ).f,
      )
    ).out,
    "run=true\n",
  );
  assert.equal(
    (
      await runWith(
        ENV,
        fake(
          [
            [A, "success"],
            [B, "success"],
          ],
          "error",
        ).f,
      )
    ).out,
    "run=true\n",
  );
  assert.equal((await runWith({ ...ENV, CURRENT_SHA: "nope" }, fake([], {}).f)).out, "run=true\n");
});
