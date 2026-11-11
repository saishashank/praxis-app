// M8 T12: the staging E2E-day CLI (scripts/e2e-day/check.mjs) with a stub library and database: no
// network, no secret. Covers the exit codes, the date default and that nothing but step names and
// times (no URL, token or driver message) reaches the output or the summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDbUrl, main, melbourneDate, parseArgs } from "../e2e-day/check.mjs";

const rows = (statuses) =>
  statuses.map((status, i) => ({
    id: `s${i}`,
    label: `Step ${i}`,
    start: "17:30",
    deadline: "18:10",
    startedAt: "17:31",
    finishedAt: "17:50",
    status,
    reason: "finished 17:50",
  }));
const calls = [];
const lib = (statuses) => ({
  checkDay: async (_db, date, _now, env) => {
    calls.push({ date, env });
    return rows(statuses);
  },
  dayPasses: (r) => r.every((x) => x.status === "on_time" || x.status === "not_due"),
  renderTable: (r) => r.map((x) => `| ${x.label} | ${x.status} |`).join("\n"),
});
const ENV = { TURSO_MAIN_URL: "libsql://secret-host.example", TURSO_MAIN_TOKEN: "tok-123" };
const NOW = () => new Date("2026-10-05T11:00:00.000Z"); // 22:00 AEDT, 5 October

async function run(argv, env, deps) {
  const lines = [];
  const summary = [];
  const code = await main(argv, env, {
    out: (s) => lines.push(s),
    summary: (s) => summary.push(s),
    openDb: async () => ({ close() {} }),
    now: NOW,
    ...deps,
  });
  return { code, text: lines.join("\n"), summary: summary.join("\n") };
}

test("exit 0 and a PASS summary when every step is on time or not due", async () => {
  const r = await run([], ENV, { lib: lib(["on_time", "not_due"]) });
  assert.equal(r.code, 0);
  assert.match(r.text, /Day timeline check for 2026-10-05: PASS/);
  assert.match(r.summary, /^### Day timeline check/);
});

test("exit 1 when a step is late or missing, and the count is shown", async () => {
  const r = await run([], ENV, { lib: lib(["on_time", "late", "missing"]) });
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL \(2 steps late or missing\)/);
});

test("the date defaults to today in Melbourne and --date overrides it", async () => {
  calls.length = 0;
  await run([], ENV, { lib: lib(["on_time"]) });
  await run(["--date", "2026-04-07"], ENV, { lib: lib(["on_time"]) });
  assert.deepEqual(
    calls.map((c) => c.date),
    ["2026-10-05", "2026-04-07"],
  );
  assert.equal(calls[0].env, "staging");
  assert.equal(melbourneDate(new Date("2026-10-04T14:30:00.000Z")), "2026-10-05"); // 01:30 AEDT
  assert.equal(melbourneDate(new Date("2026-04-04T13:30:00.000Z")), "2026-04-05"); // 00:30 AEDT
});

test("usage errors and missing configuration exit 2", async () => {
  assert.equal((await run(["--date", "tomorrow"], ENV, { lib: lib([]) })).code, 2);
  assert.equal((await run(["--bogus"], ENV, { lib: lib([]) })).code, 2);
  assert.equal((await run([], {}, { lib: lib([]) })).code, 2);
  assert.deepEqual(parseArgs([]), { date: null, db: null, now: null, except: [] });
});

test("a database error prints a fixed sentence, never the driver message", async () => {
  const bad = {
    ...lib([]),
    checkDay: async () => {
      throw new Error("connect libsql://secret-host.example tok-123");
    },
  };
  const r = await run([], ENV, { lib: bad });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.text + r.summary, /secret-host|tok-123|libsql/);
});

test("output and summary never contain the database URL or token", async () => {
  const r = await run([], ENV, { lib: lib(["on_time", "late"]) });
  assert.doesNotMatch(r.text + r.summary, /secret-host|tok-123|https?:/);
});

// M18 OPS-107 / D-965: --db checks a local file (the CI recorded day) and --now judges the simulated clock.
test("--db: a local file needs no TURSO_* and no token; the env label defaults to development, the recorded-day app's email env", async () => {
  calls.length = 0;
  const opened = [];
  const r = await run(
    ["--db", "/tmp/run/main.db", "--date", "2026-11-12"],
    {},
    {
      lib: lib(["on_time", "not_due"]),
      openDb: async () => {
        opened.push("db");
        return { close() {} };
      },
    },
  );
  assert.equal(r.code, 0);
  assert.deepEqual(opened, ["db"]);
  assert.equal(calls[0].env, "development");
  assert.match(r.text, /PASS/);
  // PRAXIS_ENV=recorded still maps to "development"; another explicit value wins
  calls.length = 0;
  await run(["--db", "main.db"], { PRAXIS_ENV: "recorded" }, { lib: lib(["on_time"]) });
  assert.equal(calls[0].env, "development");
  calls.length = 0;
  await run(["--db", "main.db"], { PRAXIS_ENV: "staging" }, { lib: lib(["on_time"]) });
  assert.equal(calls[0].env, "staging");
});

test("--db: a file: URL is kept, a plain path becomes one, a remote URL is refused (exit 2)", async () => {
  assert.equal(localDbUrl("file:///tmp/a.db"), "file:///tmp/a.db");
  assert.match(localDbUrl("data/main.db"), /^file:\/\/\/.*data\/main\.db$/);
  assert.equal(localDbUrl("libsql://secret-host.example"), null);
  assert.equal(localDbUrl("https://secret-host.example/db"), null);
  const r = await run(["--db", "libsql://secret-host.example"], ENV, { lib: lib([]) });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.text, /secret-host/);
});

test("--now: the day is judged at that instant (the date defaults to its Melbourne date)", async () => {
  calls.length = 0;
  const seen = [];
  const l = {
    ...lib(["on_time"]),
    checkDay: async (_db, date, now) => {
      seen.push([date, now.toISOString()]);
      return rows(["on_time"]);
    },
  };
  const r = await run(["--db", "main.db", "--now", "2026-11-12T09:30:00Z"], {}, { lib: l });
  assert.equal(r.code, 0);
  assert.deepEqual(seen, [["2026-11-12", "2026-11-12T09:30:00.000Z"]]);
  assert.equal((await run(["--now", "yesterday"], ENV, { lib: l })).code, 2);
  assert.equal((await run(["--now", "2026-11-12"], ENV, { lib: l })).code, 2);
});

test("--db: a read error prints the fixed local-database sentence", async () => {
  const bad = {
    ...lib([]),
    checkDay: async () => {
      throw new Error("no such table: /secret/path/main.db");
    },
  };
  const r = await run(["--db", "main.db"], {}, { lib: bad });
  assert.equal(r.code, 2);
  assert.match(r.text, /could not read the local database/);
  assert.doesNotMatch(r.text, /secret|table/);
});

test("--except: a listed step is shown as not due, other late steps still fail", async () => {
  const l = {
    ...lib([]),
    checkDay: async () => [
      { id: "late_sweep", label: "Late sweep", status: "missing", reason: "no record" },
      { id: "email", label: "Email", status: "on_time", reason: "ok" },
    ],
  };
  const pass = await run(["--db", "main.db", "--except", "late_sweep"], {}, { lib: l });
  assert.equal(pass.code, 0);
  assert.match(pass.text, /not_due/);
  const l2 = {
    ...l,
    checkDay: async () => [
      { id: "late_sweep", label: "Late sweep", status: "missing", reason: "no record" },
      { id: "email", label: "Email", status: "late", reason: "20:50" },
    ],
  };
  assert.equal((await run(["--db", "main.db", "--except", "late_sweep"], {}, { lib: l2 })).code, 1);
  assert.equal((await run(["--db", "main.db"], {}, { lib: l })).code, 1); // without the flag: missing fails
  assert.deepEqual(parseArgs(["--except", "a,b"]).except, ["a", "b"]);
});
