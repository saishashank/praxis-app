// INFRA T5: the Turso refresh and its owner guard. Local libSQL files stand in for sqld (source)
// and Turso (target). The guard is the point: Turso is never touched unless the SOURCE says
// worker_state.clock_owner = "selfhost".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dumpDatabase } from "../backup/core.mjs";
import { assertSelfhostOwns, planFromEnv, readClockOwner, run } from "./turso-refresh.mjs";
import { seededDb, setOwner, tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
const NOW = "2026-01-02T03:04:05.678Z";
let n = 0;

/** A source (main + auth) with the given owner, and a target (main + auth) holding OLD data. */
async function world(owner, targetOwner = "selfhost") {
  const id = ++n;
  const src = await seededDb(t, `src-${id}-main.db`, "main");
  const srcAuth = await seededDb(t, `src-${id}-auth.db`, "auth");
  await setOwner(src, owner);
  await src.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2026-02-02T00:00:00.000Z', 'info', 'new', 'only in the source')",
  );
  const tgt = await seededDb(t, `tgt-${id}-main.db`, "main");
  await tgt.execute(
    "INSERT INTO app_log (at, level, source, message) VALUES ('2025-01-01T00:00:00.000Z', 'info', 'old', 'only in turso')",
  );
  await setOwner(tgt, targetOwner);
  const tgtAuth = await seededDb(t, `tgt-${id}-auth.db`, "auth");
  const env = {
    TURSO_MAIN_URL: t.url(`src-${id}-main.db`),
    TURSO_AUTH_URL: t.url(`src-${id}-auth.db`),
    TURSO_REFRESH_MAIN_URL: "libsql://praxis-main-x.turso.io",
    TURSO_REFRESH_MAIN_TOKEN: "t1",
    TURSO_REFRESH_AUTH_URL: "libsql://praxis-auth-x.turso.io",
    TURSO_REFRESH_AUTH_TOKEN: "t2",
  };
  // open() maps the URLs to local files; the "Turso" URLs go to the target files.
  const files = {
    [env.TURSO_MAIN_URL]: `src-${id}-main.db`,
    [env.TURSO_AUTH_URL]: `src-${id}-auth.db`,
    [env.TURSO_REFRESH_MAIN_URL]: `tgt-${id}-main.db`,
    [env.TURSO_REFRESH_AUTH_URL]: `tgt-${id}-auth.db`,
  };
  const opened = [];
  const open = (url) => {
    opened.push(url);
    return t.open(files[url]);
  };
  const lines = [];
  return { src, srcAuth, tgt, tgtAuth, env, open, opened, lines, out: (s) => lines.push(s) };
}
const logRows = async (db) =>
  (await db.execute("SELECT source FROM app_log ORDER BY id")).rows.map((r) => String(r.source));

test("owner is selfhost: Turso is replaced by the source (main and auth), verified", async () => {
  const w = await world("selfhost");
  const code = await run([], w.env, { open: w.open, out: w.out });
  assert.equal(code, 0, w.lines.join("\n"));
  assert.match(
    w.lines.join("\n"),
    /^turso-refresh: PASS main\(tables=\d+ rows=\d+ replaced=\d+\) auth\(/,
  );
  assert.deepEqual(await logRows(w.tgt), await logRows(w.src)); // 'old' is gone, 'new' is there
  assert.ok((await logRows(w.tgt)).includes("new"));
  assert.equal((await logRows(w.tgt)).includes("old"), false);
  const a = await dumpDatabase(w.src, { name: "main", createdAt: NOW });
  const b = await dumpDatabase(w.tgt, { name: "main", createdAt: NOW });
  assert.deepEqual(b.sha256, a.sha256);
  assert.equal(await readClockOwner(w.tgt), "selfhost"); // the copy carries the owner
  assert.equal(/libsql:|file:|t1|t2/.test(w.lines.join("\n")), false); // no URL or token in the output
});

for (const [label, owner] of [
  ["owner is cloud", "cloud"],
  ["owner key is absent", null],
  ["owner is some other value", "mars"],
]) {
  test(`GUARD: ${label} -> refused, Turso is not touched`, async () => {
    const w = await world(owner);
    const before = await logRows(w.tgt);
    const code = await run([], w.env, { open: w.open, out: w.out });
    assert.equal(code, 3);
    assert.match(w.lines[0], /^turso-refresh: REFUSED refused: clock_owner is not selfhost/);
    assert.deepEqual(await logRows(w.tgt), before);
    assert.equal(w.opened.includes(w.env.TURSO_REFRESH_MAIN_URL), false); // never even connected
  });
}

test("GUARD: an unreadable owner (no worker_state table) -> refused", async () => {
  const w = await world("selfhost");
  await w.src.execute("DROP TABLE worker_state");
  const before = await logRows(w.tgt);
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 3);
  assert.match(w.lines[0], /cannot read clock_owner/);
  assert.deepEqual(await logRows(w.tgt), before);
});

test("GUARD: the owner is checked again right before the write (a switch during the dump stops the run)", async () => {
  const w = await world("selfhost");
  const before = await logRows(w.tgt);
  let ownerReads = 0;
  const open = (url) => {
    const real = w.open(url);
    if (url !== w.env.TURSO_MAIN_URL) return real;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "execute") {
          return async (q, ...rest) => {
            const sql = typeof q === "string" ? q : q.sql;
            if (/clock_owner|worker_state WHERE key/.test(sql) && ++ownerReads === 2) {
              await setOwner(real, "cloud"); // the operator switched back while the dump ran
            }
            return target.execute(q, ...rest);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  assert.equal(await run([], w.env, { open, out: w.out }), 3);
  assert.match(w.lines[0], /REFUSED refused: clock_owner is not selfhost/);
  assert.deepEqual(await logRows(w.tgt), before);
  assert.ok(ownerReads >= 2);
});

test("--dry-run: guard and dump only, nothing written", async () => {
  const w = await world("selfhost");
  const before = await logRows(w.tgt);
  assert.equal(await run(["--dry-run"], w.env, { open: w.open, out: w.out }), 0);
  assert.match(w.lines[0], /DRY RUN ok main\(tables=\d+ rows=\d+ dry-run\)/);
  assert.deepEqual(await logRows(w.tgt), before);
  const w2 = await world("cloud"); // a dry run is guarded too
  assert.equal(await run(["--dry-run"], w2.env, { open: w2.open, out: w2.out }), 3);
});

test("configuration: target equal to source, missing target, unknown flag", async () => {
  assert.throws(
    () => planFromEnv({ TURSO_MAIN_URL: "http://main.sqld:8080" }),
    /TURSO_REFRESH_MAIN_URL/,
  );
  assert.throws(
    () =>
      planFromEnv({
        TURSO_MAIN_URL: "libsql://same.turso.io",
        TURSO_REFRESH_MAIN_URL: "https://same.turso.io/",
        TURSO_REFRESH_MAIN_TOKEN: "x",
      }),
    /target is the source/,
  );
  assert.throws(
    () =>
      planFromEnv({
        TURSO_MAIN_URL: "http://main.sqld:8080",
        TURSO_REFRESH_MAIN_URL: "http://other.sqld:8080",
        TURSO_REFRESH_MAIN_TOKEN: "x",
      }),
    /must be a Turso/,
  );
  const plan = planFromEnv({
    TURSO_MAIN_URL: "http://main.sqld:8080",
    TURSO_REFRESH_MAIN_URL: "libsql://x.turso.io",
    TURSO_REFRESH_MAIN_TOKEN: "x",
  });
  assert.equal(plan.length, 1); // auth only when both ends are configured
  const lines = [];
  assert.equal(await run(["--bogus"], {}, { out: (s) => lines.push(s) }), 1);
});

test("assertSelfhostOwns on stand-in clients", async () => {
  const mk = (v) => ({
    execute: async () => ({ rows: v === undefined ? [] : [{ value_json: JSON.stringify(v) }] }),
  });
  await assertSelfhostOwns(mk("selfhost"));
  await assert.rejects(assertSelfhostOwns(mk("cloud")), /not selfhost/);
  await assert.rejects(assertSelfhostOwns(mk(undefined)), /not selfhost/);
  await assert.rejects(
    assertSelfhostOwns({
      execute: async () => {
        throw new Error("down");
      },
    }),
    /cannot read/,
  );
});

// Second guard: the TARGET Turso main must also say selfhost.
for (const [label, targetOwner] of [
  ["target says cloud", "cloud"],
  ["target owner key is absent", null],
]) {
  test(`TARGET GUARD: ${label} -> refused (exit 3), nothing dropped`, async () => {
    const w = await world("selfhost", targetOwner);
    const before = await logRows(w.tgt);
    const tablesBefore = (await w.tgt.execute("SELECT COUNT(*) AS c FROM sqlite_master")).rows[0].c;
    const code = await run([], w.env, { open: w.open, out: w.out });
    assert.equal(code, 3, w.lines.join("\n"));
    assert.match(
      w.lines[0],
      /^turso-refresh: REFUSED refused: (the target clock_owner is not selfhost|cannot read clock_owner in the target)/,
    );
    assert.deepEqual(await logRows(w.tgt), before);
    assert.equal(
      (await w.tgt.execute("SELECT COUNT(*) AS c FROM sqlite_master")).rows[0].c,
      tablesBefore,
    );
  });
}

test("TARGET GUARD: both selfhost -> proceeds (exit 0)", async () => {
  const w = await world("selfhost", "selfhost");
  assert.equal(await run([], w.env, { open: w.open, out: w.out }), 0, w.lines.join("\n"));
});

test("TARGET GUARD: the target flips to cloud before the drop -> refused, nothing dropped", async () => {
  const w = await world("selfhost", "selfhost");
  const before = await logRows(w.tgt);
  let reads = 0;
  const open = (url) => {
    const real = w.open(url);
    if (url !== w.env.TURSO_REFRESH_MAIN_URL) return real;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "execute") {
          return async (q, ...rest) => {
            const sql = typeof q === "string" ? q : q.sql;
            const res = await target.execute(q, ...rest);
            if (/worker_state WHERE key/.test(sql) && ++reads === 1) {
              await setOwner(real, "cloud"); // cloud takes over after the first read
            }
            return res;
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  assert.equal(await run([], w.env, { open, out: w.out }), 3);
  assert.match(w.lines[0], /REFUSED refused: the target clock_owner is not selfhost/);
  assert.deepEqual(await logRows(w.tgt), before);
});

test("a real error (bad flag) exits 1, not 3", async () => {
  assert.equal(await run(["--bogus"], {}, { out() {} }), 1);
});
