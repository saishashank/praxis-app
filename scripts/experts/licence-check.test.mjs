// Tests of the first licence check script (M22 E1; D-1431): node --test, no network (an injected fetch), a
// synthetic seed on example.test in a temp folder outside the repository.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expertsOf, FORMAT, insideRepo, OUT_FILE, run } from "./licence-check.mjs";

const reply = (status, text = "") => ({
  status,
  headers: { get: () => null },
  text: async () => text,
});
const fixture = (table) => {
  const asked = [];
  return {
    asked,
    fetch: async (url) => {
      asked.push(url);
      return table[url] ?? reply(404);
    },
  };
};
const seed = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "licence-seed-"));
  writeFileSync(
    path.join(dir, "experts.json"),
    JSON.stringify({
      experts: [
        {
          id: "X-ZZ1",
          status: "tracked",
          handles: { x: "zz1" },
          home_urls: ["https://zz1.example.test/home"],
        },
        { id: "X-ZZ2", status: "tracked", home_urls: ["https://zz2.example.test/"] },
        { id: "X-ZZ3", status: "tracked", no_feed: true, home_urls: ["https://zz3.example.test/"] },
        { id: "X-ZZ4", status: "retired", home_urls: ["https://zz4.example.test/"] },
        { id: "X-ZZ5", status: "tracked", home_urls: ["https://zz5.example.test/"] },
        { nope: true },
      ],
    }),
  );
  return dir;
};
const quiet = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
};

test("writes licence-check.json beside the seed, prints counts only, never fetches a manual platform", async () => {
  const dir = seed();
  try {
    const f = fixture({
      "https://zz1.example.test/robots.txt": reply(200, "User-agent: *\nDisallow:\n"),
      "https://zz1.example.test/terms": reply(200, "<p>You may summarise our posts.</p>"),
      "https://zz2.example.test/robots.txt": reply(200, "User-agent: *\nDisallow: /\n"),
      "https://zz5.example.test/robots.txt": reply(503),
    });
    const q = quiet();
    const code = await run(
      ["--seed", dir],
      {},
      {
        out: q.out,
        fetch: f.fetch,
        sleep: async () => undefined,
        now: () => new Date("2030-03-02T01:00:00.000Z"),
        allowInsideRepo: true,
      },
    );
    assert.equal(code, 0);
    const body = JSON.parse(readFileSync(path.join(dir, OUT_FILE), "utf8"));
    assert.equal(body.format, FORMAT);
    assert.equal(body.checked_at, "2030-03-02T01:00:00.000Z");
    assert.deepEqual(
      body.results.map((r) => [r.expert_id, r.source_key, r.robots, r.summarisation, r.status]),
      [
        ["X-ZZ1", "https://zz1.example.test", "allows", "yes", "enabled"],
        ["X-ZZ2", "https://zz2.example.test", "disallows", "unknown", "no"],
        ["X-ZZ5", "https://zz5.example.test", "unreachable", "unknown", "unchecked"],
      ],
    );
    assert.ok(!body.results.some((r) => r.status === "owner-accepted-risk"));
    // a reference author, a retired expert and the manual-only handle were never fetched
    assert.ok(!f.asked.some((u) => /zz3|zz4/.test(u)));
    assert.equal(f.asked.filter((u) => u.includes("x.com")).length, 0);
    // on screen: counts, no name, handle or URL
    assert.equal(q.lines.length, 1);
    assert.match(q.lines[0], /4 sources, 3 checked/);
    assert.doesNotMatch(q.lines[0], /zz\d|example|X-ZZ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a seed folder inside the repository, a missing folder and a missing flag", async () => {
  const q = quiet();
  assert.equal(await run(["--seed", "tests"], {}, { out: q.out }), 1);
  assert.match(q.lines.at(-1), /outside the repository/);
  const dir = mkdtempSync(path.join(tmpdir(), "licence-empty-"));
  try {
    assert.equal(await run(["--seed", dir], {}, { out: q.out }), 1);
    assert.match(q.lines.at(-1), /experts\.json not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(await run([], {}, { out: q.out }), 1);
  assert.match(q.lines.at(-1), /usage/);
});

test("expertsOf keeps candidate and tracked experts and skips malformed rows", () => {
  assert.deepEqual(expertsOf(null), []);
  const got = expertsOf({
    experts: [{ id: "a", status: "tracked", handles: { x: 1, y: "h" } }, 5, { id: 3 }],
  });
  assert.deepEqual(got, [
    { id: "a", platforms: [], handles: { y: "h" }, homeUrls: [], noFeed: false },
  ]);
});

test("insideRepo", () => {
  assert.equal(insideRepo("."), true);
  assert.equal(insideRepo(tmpdir()), false);
});
