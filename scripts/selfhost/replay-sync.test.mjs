// INFRA replay bridge: replay results are pulled from Turso into sqld. Local libSQL files stand in for both.
// The point: only the owner=selfhost runtime writes, only replay's seven tables, idempotently, parent first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPLAY_TABLES, run } from "./replay-sync.mjs";
import { seededDb, setOwner, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
let n = 0;

async function world(owner) {
  const id = ++n;
  const sqld = await seededDb(t, `sqld-${id}.db`, "main");
  const turso = await seededDb(t, `turso-${id}.db`, "main");
  await setOwner(sqld, owner);
  const env = {
    TURSO_MAIN_URL: t.url(`sqld-${id}.db`),
    TURSO_REFRESH_MAIN_URL: "libsql://praxis-main-x.turso.io",
    TURSO_REFRESH_MAIN_TOKEN: "t1",
  };
  const files = {
    [env.TURSO_MAIN_URL]: `sqld-${id}.db`,
    [env.TURSO_REFRESH_MAIN_URL]: `turso-${id}.db`,
  };
  const opened = [];
  const open = (url) => {
    opened.push(url);
    return t.open(files[url]);
  };
  const lines = [];
  return { sqld, turso, env, open, opened, lines, out: (s) => lines.push(s) };
}

/** One replay result set: a lineage, its split, a run, a stat, a validation result, a label, a trial. */
async function addReplay(db, tag) {
  const L = `AU:fam-${tag}`;
  await db.batch(
    [
      {
        sql: "INSERT INTO lineage (id, created_d, parent) VALUES (?, '2026-01-01', NULL)",
        args: [L],
      },
      {
        sql: "INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len, purge, data_end_d, deferred_until_d, reason) VALUES (?, 1, 5, 20, 20, 2, '2026-01-01', '2027-01-01', 'create')",
        args: [L],
      },
      {
        sql: "INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version, files_json, minutes) VALUES (?, 'light', 'AU', 's', 'c', 'p', 1, 'v24', '[]', 1.5)",
        args: [`run-${tag}`],
      },
      {
        sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, 'all', 'm', '2026-01-02', '1')",
        args: [`run-${tag}`],
      },
      {
        sql: "INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, d) VALUES (?, 'AU', ?, 1, 'new_lineage', '2026-01-02')",
        args: [`trial-${tag}`, L],
      },
      {
        sql: "INSERT INTO validation_result (id, run_id, lineage_id, rule_version, variant, split_version, test, level, B, n, blocks, L_used, m_used, outcome) VALUES (?, ?, ?, 'r1', 'v', 1, 'i', 0.05, 10, 10, 2, 1, 1, 'ok')",
        args: [`val-${tag}`, `run-${tag}`, L],
      },
      {
        sql: "INSERT INTO label (id, execution_id, rule_version, variant, label, n, d) VALUES (?, 'e', 'r1', 'v', 'UNVALIDATED', 3, '2026-01-02')",
        args: [`label-${tag}`],
      },
    ],
    "write",
  );
}
const counts = async (db) => {
  const o = {};
  for (const { name } of REPLAY_TABLES) {
    o[name] = Number((await db.execute(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
  }
  return o;
};

test("owner selfhost: replay rows that Turso has and sqld lacks are copied; a repeat is a no-op", async () => {
  const w = await world("selfhost");
  await addReplay(w.sqld, "old"); // already in both
  await addReplay(w.turso, "old");
  await addReplay(w.turso, "new"); // written by replay on GitHub after the refresh
  const code = await run([], w.env, { open: w.open, out: w.out });
  assert.equal(code, 0, w.lines.join("\n"));
  const c = await counts(w.sqld);
  for (const { name } of REPLAY_TABLES) assert.equal(c[name], 2, name);
  assert.match(w.lines.at(-1), /PASS lineage\(\+1\) lineage_split\(\+1\)/);
  const again = await run([], w.env, { open: w.open, out: w.out });
  assert.equal(again, 0);
  assert.match(w.lines.at(-1), /lineage\(\+0\).*replay_stat\(\+0\)/);
  assert.deepEqual(await counts(w.sqld), c);
});

test("pages by primary key: more rows than one page, composite keys included", async () => {
  const w = await world("selfhost");
  await addReplay(w.turso, "x");
  const stmts = [];
  for (let i = 0; i < 1203; i++) {
    stmts.push({
      sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('run-x', 'all', ?, '2026-01-02', '1')",
      args: [`m${String(i).padStart(5, "0")}`],
    });
  }
  await w.turso.batch(stmts, "write");
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
  assert.equal((await counts(w.sqld)).replay_stat, 1204);
});

test("owner cloud or missing: exit 3, Turso is not even opened, nothing is written", async () => {
  for (const owner of ["cloud", null]) {
    const w = await world(owner);
    await addReplay(w.turso, "new");
    const code = await run([], w.env, { open: w.open, out: w.out });
    assert.equal(code, 3, String(owner));
    assert.match(w.lines.at(-1), /REFUSED/);
    assert.equal(w.opened.length, 1, "only sqld was opened");
    assert.equal((await counts(w.sqld)).replay_run, 0);
  }
});

test("only replay's own tables are touched; other tables in Turso are never copied", async () => {
  const w = await world("selfhost");
  await w.turso.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2026-02-02T00:00:00.000Z', 'info', 'x', 'turso only')",
  );
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0);
  const r = await w.sqld.execute("SELECT count(*) AS n FROM app_log WHERE source = 'x'");
  assert.equal(Number(r.rows[0].n), 0);
});

test("config errors fail with exit 1 and never print a URL or a token", async () => {
  const w = await world("selfhost");
  for (const env of [
    { ...w.env, TURSO_REFRESH_MAIN_URL: undefined },
    { ...w.env, TURSO_REFRESH_MAIN_URL: w.env.TURSO_MAIN_URL },
  ]) {
    w.lines.length = 0;
    assert.equal(await run([], env, { open: w.open, out: w.out }), 1);
    assert.doesNotMatch(w.lines.join("\n"), /libsql:|file:|t1/);
  }
});

test("the script never writes with REPLACE and writes only with ON CONFLICT DO NOTHING", () => {
  const src = readFileSync(new URL("./replay-sync.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /OR\s+REPLACE|REPLACE\s+INTO/i);
  assert.match(src, /ON CONFLICT DO NOTHING/);
});
