// INFRA T5, review B4 + S5: the incremental Turso refresh. A second local libSQL file stands in for Turso
// (never a turso.io URL). Proves: worker_state is never dropped/deleted/rewritten in the target and the owner
// reads "selfhost" at every statement; unchanged data writes nothing; one changed row writes one row; no OFFSET;
// schema drift rebuilds only the changed table; triggers come back; the rolling usage budget refuses/stops.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readClockOwner, run } from "./turso-refresh.mjs";
import { seededDb, setOwner, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
let n = 0;

async function world() {
  const id = ++n;
  const src = await seededDb(t, `s${id}.db`, "main");
  await setOwner(src, "selfhost");
  await src.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2026-02-02T00:00:00.000Z', 'info', 'new', 'only in the source')",
  );
  const tgt = await seededDb(t, `t${id}.db`, "main");
  await tgt.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2025-01-01T00:00:00.000Z', 'info', 'old', 'only in turso')",
  );
  await setOwner(tgt, "selfhost");
  const env = {
    TURSO_MAIN_URL: t.url(`s${id}.db`),
    TURSO_REFRESH_MAIN_URL: "libsql://praxis-main-x.turso.io",
    TURSO_REFRESH_MAIN_TOKEN: "t1",
  };
  const files = { [env.TURSO_MAIN_URL]: `s${id}.db`, [env.TURSO_REFRESH_MAIN_URL]: `t${id}.db` };
  const lines = [];
  return {
    src,
    tgt,
    env,
    lines,
    out: (s) => lines.push(s),
    open: (url) => t.open(files[url]),
    targetUrl: env.TURSO_REFRESH_MAIN_URL,
  };
}

/** Wraps a client: records every statement and calls onStmt(sql) before it runs. */
function spy(real, log, onStmt = async () => {}) {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "execute") {
        return async (q, ...rest) => {
          const sql = typeof q === "string" ? q : q.sql;
          log.push(sql);
          await onStmt(sql);
          return target.execute(q, ...rest);
        };
      }
      if (prop === "batch") {
        return async (stmts, ...rest) => {
          for (const x of stmts) {
            const sql = typeof x === "string" ? x : x.sql;
            log.push(sql);
            await onStmt(sql);
          }
          return target.batch(stmts, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
const isWrite = (s) => /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE)\b/i.test(s);
const withSpy = (w, log, onStmt) => (url) => {
  const real = w.open(url);
  return url === w.targetUrl ? spy(real, log, onStmt) : real;
};
const logRows = async (db) =>
  (await db.execute("SELECT source FROM app_log ORDER BY id")).rows.map((r) => String(r.source));
const triggerCount = async (db) =>
  Number(
    (await db.execute("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'")).rows[0].n,
  );

test("B4: worker_state is never dropped or deleted in Turso and the owner reads selfhost at every statement", async () => {
  const w = await world();
  await w.src.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('k_new', '1', '2026-02-02T00:00:00.000Z')",
  );
  const log = [];
  const owners = [];
  const open = withSpy(w, log, async () => {
    owners.push(await readClockOwner(w.tgt));
  });
  assert.equal(await run(["--verify"], w.env, { open, out: w.out }), 0, w.lines.join("\n"));
  assert.ok(log.length > 10);
  assert.equal(
    log.some((s) => /DROP\s+TABLE[^;]*worker_state/i.test(s)),
    false,
  );
  assert.equal(
    log.some((s) => /DELETE\s+FROM\s+"?worker_state/i.test(s)),
    false,
  );
  assert.ok(owners.length > 5 && owners.every((o) => o === "selfhost"));
  assert.equal(
    (await w.tgt.execute("SELECT key FROM worker_state WHERE key = 'k_new'")).rows.length,
    1,
  );
  // the usage meter lives in sqld and is never copied to Turso
  const has = (db) =>
    db
      .execute("SELECT 1 FROM worker_state WHERE key = 'turso_refresh_usage'")
      .then((r) => r.rows.length);
  assert.equal(await has(w.src), 1);
  assert.equal(await has(w.tgt), 0);
  assert.deepEqual(await logRows(w.tgt), await logRows(w.src));
});

test("S5: nothing changed writes no row; one changed row writes one row; no OFFSET", async () => {
  const w = await world();
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  const log = [];
  assert.equal(await run([], w.env, { open: withSpy(w, log), out: w.out }), 0, w.lines.join("\n"));
  assert.deepEqual(
    log.filter((s) => isWrite(s)),
    [],
  );
  assert.match(w.lines.at(-1), /written=0 deleted=0 rebuilt=0/);
  await w.src.execute("UPDATE app_log SET message = 'edited' WHERE source = 'new'");
  const log2 = [];
  assert.equal(await run([], w.env, { open: withSpy(w, log2), out: w.out }), 0);
  assert.equal(log2.filter((s) => /^INSERT INTO "app_log"/.test(s)).length, 1);
  assert.equal(log2.filter((s) => /^(DELETE|DROP TABLE)/i.test(s)).length, 0);
  assert.equal(
    (await w.tgt.execute("SELECT message FROM app_log WHERE source = 'new'")).rows[0].message,
    "edited",
  );
  assert.equal(
    [...log, ...log2].some((s) => /\bOFFSET\b/i.test(s)),
    false,
  );
});

test("a Turso-only row is deleted, except in worker_state and replay's result tables", async () => {
  const w = await world();
  await w.tgt.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('turso_only', '1', 'x')",
  );
  await w.tgt.execute(
    "INSERT INTO app_log (id, at, level, source, message) VALUES (50, '2025-01-01T00:00:00.000Z', 'info', 'orphan', 'x')",
  );
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  assert.equal((await logRows(w.tgt)).includes("old"), false);
  assert.equal((await logRows(w.tgt)).includes("orphan"), false);
  assert.match(w.lines.at(-1), /deleted=1 /);
  assert.equal(
    (await w.tgt.execute("SELECT 1 FROM worker_state WHERE key = 'turso_only'")).rows.length,
    1,
  );
});

test("a schema change on sqld rebuilds that table in Turso, and only that one", async () => {
  const w = await world();
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  await w.src.execute("ALTER TABLE app_log ADD COLUMN extra TEXT");
  await w.src.execute("UPDATE app_log SET extra = 'x'");
  const log = [];
  assert.equal(
    await run(["--verify"], w.env, { open: withSpy(w, log), out: w.out }),
    0,
    w.lines.join("\n"),
  );
  assert.match(w.lines.at(-1), /rebuilt=1/);
  assert.equal(log.filter((s) => /^DROP TABLE/i.test(s)).length, 1);
  assert.ok(
    (await w.tgt.execute("PRAGMA table_info(app_log)")).rows.some((r) => r.name === "extra"),
  );
  assert.equal(await readClockOwner(w.tgt), "selfhost");
});

test("a missing table in Turso is created and filled", async () => {
  const w = await world();
  await w.tgt.execute("DROP TABLE app_log");
  assert.equal(await run(["--verify"], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  assert.deepEqual(await logRows(w.tgt), await logRows(w.src));
});

test("triggers are back after a run, also when a write fails", async () => {
  const w = await world();
  const before = await triggerCount(w.tgt);
  assert.ok(before > 0);
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  assert.equal(await triggerCount(w.tgt), before);
  await w.src.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2026-03-03T00:00:00.000Z', 'info', 'x', 'y')",
  );
  let blocked = false;
  const open = withSpy(w, [], async (sql) => {
    if (!blocked && /^INSERT INTO "app_log"/.test(sql)) {
      blocked = true;
      await w.tgt.execute("CREATE TABLE zz_block (a INTEGER)");
      await w.tgt.execute("DROP TABLE app_log"); // the batch will fail: no such table
    }
  });
  assert.equal(await run([], w.env, { open, out: w.out }), 1, w.lines.join("\n"));
  assert.match(w.lines.at(-1), /FAIL target write failed/);
  assert.equal(await triggerCount(w.tgt), before - (await appLogTriggers(w.src)));
});
async function appLogTriggers(db) {
  return Number(
    (
      await db.execute(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'app_log'",
      )
    ).rows[0].n,
  );
}

test("usage meter: recorded in sqld; refuses when the rolling budget is used up; old buckets do not count", async () => {
  const w = await world();
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0);
  const u = JSON.parse(
    String(
      (await w.src.execute("SELECT value_json FROM worker_state WHERE key = 'turso_refresh_usage'"))
        .rows[0].value_json,
    ),
  );
  const day = Object.values(u.days)[0];
  assert.ok(day.r > 0 && day.w > 0);
  const today = new Date().toISOString().slice(0, 10);
  const setUsage = (v) =>
    w.src.execute({
      sql: "UPDATE worker_state SET value_json = ? WHERE key = 'turso_refresh_usage'",
      args: [JSON.stringify(v)],
    });
  await setUsage({ days: { [today]: { r: 100_000_000, w: 0 } } });
  const log = [];
  assert.equal(await run([], w.env, { open: withSpy(w, log), out: w.out }), 1);
  assert.match(w.lines.at(-1), /FAIL budget: /);
  assert.deepEqual(
    log.filter((s) => isWrite(s)),
    [],
  );
  await setUsage({ days: { [today]: { r: 0, w: 2_000_000 } } });
  await w.src.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2026-04-04T00:00:00.000Z', 'info', 'late', 'z')",
  );
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 1);
  assert.match(w.lines.at(-1), /FAIL budget: stopped at the Turso write budget/);
  assert.equal((await logRows(w.tgt)).includes("late"), false);
  await setUsage({ days: { "2020-01-01": { r: 999_999_999, w: 999_999_999 } } });
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  assert.equal((await logRows(w.tgt)).includes("late"), true);
});

test("worker_state schema drift is refused, never dropped", async () => {
  const w = await world();
  await w.src.execute("ALTER TABLE worker_state ADD COLUMN extra TEXT");
  const log = [];
  assert.equal(await run([], w.env, { open: withSpy(w, log), out: w.out }), 1);
  assert.match(w.lines.at(-1), /worker_state schema differs/);
  assert.deepEqual(
    log.filter((s) => isWrite(s)),
    [],
  );
});
