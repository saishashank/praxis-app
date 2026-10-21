// M4 T3: the secret-free ASIC fetch step with a fake fetch (no network). Synthetic CSV only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./asic_fetch.mjs";

const CSV =
  "Product,Product Code,Reported Short Positions,Total Product in Issue\nSYNTHETIC LTD,ZZA,100,10000\n";
const setup = (dates) => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-asic-"));
  const req = path.join(dir, "request.json");
  writeFileSync(req, JSON.stringify({ short_dates: dates }));
  return { dir, req, out: path.join(dir, "short.json") };
};
const res = (status, body = "") =>
  new Response(status === 404 ? null : body, { status, headers: { "content-type": "text/csv" } });

test("fetches the listed dates, treats 404 as absent and writes short.json", async () => {
  const s = setup(["2026-10-12", "2026-10-13"]);
  const urls = [];
  const lines = [];
  const code = await run(
    ["--request", s.req, "--output", s.out],
    {},
    {
      out: (l) => lines.push(l),
      sleep: async () => {},
      fetchImpl: async (u) => {
        urls.push(u);
        return urls.length === 1 ? res(200, CSV) : res(404);
      },
    },
  );
  assert.equal(code, 0);
  const f = JSON.parse(readFileSync(s.out, "utf8"));
  assert.equal(f.stopped, null);
  assert.equal(f.absent, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].assumed_time, true);
  assert.ok(urls.every((u) => new URL(u).hostname === "download.asic.gov.au"));
  assert.match(lines[0], /dates=2 absent=1 rows=1/);
  rmSync(s.dir, { recursive: true, force: true });
});

test("a 403 or 429 stops at once (no further request) and is recorded", async () => {
  for (const [status, why] of [
    [403, "blocked"],
    [429, "rate_limited"],
  ]) {
    const s = setup(["2026-10-12", "2026-10-13"]);
    let n = 0;
    await run(
      ["--request", s.req, "--output", s.out],
      {},
      {
        out: () => {},
        sleep: async () => {},
        fetchImpl: async () => {
          n++;
          return res(status);
        },
      },
    );
    assert.equal(n, 1);
    assert.equal(JSON.parse(readFileSync(s.out, "utf8")).stopped, why);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("an empty date list makes no request; a bad list is refused", async () => {
  const s = setup([]);
  const code = await run(
    ["--request", s.req, "--output", s.out],
    {},
    {
      out: () => {},
      fetchImpl: async () => {
        throw new Error("no request expected");
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(s.out, "utf8")).rows, []);
  writeFileSync(s.req, JSON.stringify({ short_dates: ["../x"] }));
  assert.equal(await run(["--request", s.req, "--output", s.out], {}, { out: () => {} }), 2);
  rmSync(s.dir, { recursive: true, force: true });
});
