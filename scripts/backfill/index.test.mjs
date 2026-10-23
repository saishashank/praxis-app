// D-175: index-history backfill script (request + first-seen commit), with a fake database.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ANCHOR_CODE, buildRequest, run, sydneyToday } from "./index.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "praxis-index-"));
const NOW = Date.parse("2026-10-23T09:00:00.000Z");
const FETCHED = "2026-10-23T09:00:00.000Z";
const row = (date, close, extra = {}) => ({
  code: "AXJO",
  date,
  open: close,
  high: close + 10,
  low: close - 10,
  close,
  source: "yahoo",
  published_at: null,
  fetched_at: FETCHED,
  ...extra,
});

/** A database that keeps (index_code, d) keys and skips repeats, like ON CONFLICT DO NOTHING. */
function fakeDb() {
  const keys = new Set();
  const db = {
    closed: false,
    async batch(stmts) {
      return stmts.map((s) => {
        let n = 0;
        for (let i = 0; i < s.args.length; i += 10) {
          const k = `${s.args[i + 1]}|${s.args[i + 2]}`;
          if (!keys.has(k)) {
            keys.add(k);
            n += 1;
          }
        }
        return { rowsAffected: n };
      });
    },
    close() {
      db.closed = true;
    },
  };
  return { db, keys };
}

const capture = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
};

test("request: one anchor code plus ^AXJO for the window, today in Sydney by default", async () => {
  assert.deepEqual(buildRequest("2020-10-01", "2026-10-23"), {
    codes: [ANCHOR_CODE],
    start: "2020-10-01",
    end: "2026-10-23",
    indices: ["^AXJO"],
  });
  assert.equal(sydneyToday(NOW), "2026-10-23");
  const file = path.join(dir, "request.json");
  const c = capture();
  const code = await run(
    ["request", "--from", "2020-10-01", "--out", file],
    {},
    {
      out: c.out,
      nowMs: () => NOW,
    },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).end, "2026-10-23");
  assert.deepEqual(c.lines, ["index backfill request: 2020-10-01..2026-10-23"]);
});

test("commit: valid rows are written first-seen, bad ones counted, a re-run writes 0", async () => {
  const file = path.join(dir, "index.json");
  writeFileSync(
    file,
    JSON.stringify([
      row("2026-10-21", 8900),
      row("2026-10-22", 8950),
      row("2019-01-02", 6000), // before --from
      row("2026-10-22", 8950), // duplicate key
      { ...row("2026-10-20", 8800), code: "XJO" }, // unknown index
    ]),
  );
  const { db, keys } = fakeDb();
  const env = { TURSO_MAIN_URL: "libsql://db.example", TURSO_MAIN_TOKEN: "t" };
  const c = capture();
  const args = ["commit", "--index", file, "--from", "2020-10-01", "--to", "2026-10-23"];
  assert.equal(await run(args, env, { out: c.out, openDb: () => db, nowMs: () => NOW }), 0);
  assert.equal(c.lines[0], "index backfill commit: ok rows=2 written=2 rejected=3");
  assert.equal(keys.size, 2);
  assert.equal(db.closed, true);
  const again = capture();
  assert.equal(await run(args, env, { out: again.out, openDb: () => db, nowMs: () => NOW }), 0);
  assert.equal(again.lines[0], "index backfill commit: ok rows=2 written=0 rejected=3");
});

test("fails visibly on bad usage, a missing or invalid file, or no database", async () => {
  const c = capture();
  assert.equal(await run(["commit", "--from", "nope"], {}, { out: c.out }), 1);
  assert.equal(await run(["other", "--from", "2020-10-01"], {}, { out: c.out }), 1);
  assert.equal(await run(["request", "--from", "2020-10-01"], {}, { out: c.out }), 1);
  const missing = path.join(dir, "absent.json");
  assert.equal(
    await run(["commit", "--index", missing, "--from", "2020-10-01"], {}, { out: c.out }),
    1,
  );
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.equal(
    await run(["commit", "--index", bad, "--from", "2020-10-01"], {}, { out: c.out }),
    1,
  );
  const good = path.join(dir, "good.json");
  writeFileSync(good, JSON.stringify([row("2026-10-21", 8900)]));
  assert.equal(
    await run(["commit", "--index", good, "--from", "2020-10-01"], {}, { out: c.out }),
    1,
  );
  assert.deepEqual(c.lines, [
    "index backfill: failed (usage: request|commit --from YYYY-MM-DD [--to YYYY-MM-DD])",
    "index backfill: failed (usage: request|commit --from YYYY-MM-DD [--to YYYY-MM-DD])",
    "index backfill: failed (usage: request --out <file>)",
    "index backfill commit: failed (index file missing)",
    "index backfill commit: failed (index file invalid)",
    "index backfill commit: failed (database not configured)",
  ]);
});

test("a database error prints only its class, never the driver message", async () => {
  const file = path.join(dir, "one.json");
  writeFileSync(file, JSON.stringify([row("2026-10-21", 8900)]));
  const db = {
    async batch() {
      throw new TypeError("libsql://secret-host failed");
    },
    close() {},
  };
  const c = capture();
  const env = { TURSO_MAIN_URL: "libsql://db.example", TURSO_MAIN_TOKEN: "t" };
  const code = await run(["commit", "--index", file, "--from", "2020-10-01"], env, {
    out: c.out,
    openDb: () => db,
    nowMs: () => NOW,
  });
  assert.equal(code, 1);
  assert.deepEqual(c.lines, ["index backfill commit: failed (TypeError)"]);
});
