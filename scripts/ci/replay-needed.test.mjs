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

test("D-917: migrationTables reads the tables a migration touches, not SQL words", async () => {
  const { migrationTables } = await import("./replay-needed.mjs");
  const patch = [
    "@@ -0,0 +1,9 @@",
    "+-- +up",
    "+CREATE TABLE pick_portfolio_day (d TEXT) STRICT;",
    "+CREATE INDEX pp_idx ON pick_portfolio_day (d);",
    "+CREATE TRIGGER pp_no_update BEFORE UPDATE ON pick_portfolio_day BEGIN SELECT 1; END;",
    "+INSERT INTO quote_latest (code) VALUES ('x') ON CONFLICT DO NOTHING;",
    "+ALTER TABLE cortex_decision ADD COLUMN x TEXT; -- ALTER TABLE price_bar in a comment",
    "+-- +down",
    "+DROP TABLE IF EXISTS pick_portfolio_day;",
    " CREATE TABLE unchanged_context (x TEXT);",
  ].join("\n");
  assert.deepEqual(migrationTables(patch).sort(), [
    "cortex_decision",
    "pick_portfolio_day",
    "quote_latest",
  ]);
  assert.deepEqual(migrationTables("@@ -1 +1 @@\n+-- only a comment"), []);
});

test("D-917: a migration counts only when the replay code names one of its tables", () => {
  const used = (t) => t === "price_bar" || t === "cortex_decision";
  const mig = (patch) => ({ filename: "db/migrations/main/0030_x.sql", patch });
  // display tables only: no replay
  assert.equal(needsReplay([mig("+CREATE TABLE pick_portfolio_day (d TEXT);")], used), false);
  // a table the replay reads: replay
  assert.equal(needsReplay([mig("+ALTER TABLE price_bar ADD COLUMN y INTEGER;")], used), true);
  // unknown: no patch, or no table recognised
  assert.equal(needsReplay([mig(null)], used), true);
  assert.equal(needsReplay([mig("+-- nothing")], used), true);
  assert.equal(needsReplay(["db/migrations/main/0030_x.sql"], used), true); // a bare name
  // a code file under the replay paths always counts
  assert.equal(needsReplay([{ filename: "src/lib/agents/x.ts", patch: "+x" }], used), true);
});

test("D-917: the real replay code names price_bar but not the portfolio or quote cache tables", async () => {
  const { replayCodeText, usedIn } = await import("./replay-needed.mjs");
  const has = usedIn(replayCodeText());
  assert.equal(has("price_bar"), true);
  assert.equal(has("pick_portfolio_trade"), false);
  assert.equal(has("quote_latest"), false);
});

test("D-917: a deploy whose only replay-path change is a display-table migration skips the replay", async () => {
  const { f } = fake(
    [
      [A, "success"],
      [B, "success"],
    ],
    {
      status: "ahead",
      files: [
        { filename: "src/app/page.tsx", patch: "+x" },
        {
          filename: "db/migrations/main/0029_pick_portfolio.sql",
          patch: "+CREATE TABLE pick_portfolio_trade (x TEXT);",
        },
      ],
    },
  );
  assert.equal((await runWith(ENV, f)).out, "run=false\n");
});
