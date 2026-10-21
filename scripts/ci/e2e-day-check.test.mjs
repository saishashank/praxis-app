// M8 T12: the staging E2E-day CLI (scripts/e2e-day/check.mjs) with a stub library and database: no
// network, no secret. Covers the exit codes, the date default and that nothing but step names and
// times (no URL, token or driver message) reaches the output or the summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, melbourneDate, parseArgs } from "../e2e-day/check.mjs";

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
  assert.deepEqual(parseArgs([]), { date: null });
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
