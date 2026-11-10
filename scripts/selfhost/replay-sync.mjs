// INFRA replay bridge (REQ\infra\INFRA_REQUIREMENT.md §9 "Replay stays on GitHub Actions"). Design choice:
// replay keeps running on GitHub against TURSO (no public database route, R6). While self-hosted owns the
// clock, the nightly turso-refresh (23:25 Sydney, before the 00:15 replay slot) makes Turso fresh, and THIS
// script pulls replay's results back into sqld after replay has finished.
//
// What replay writes (src/lib/replay/cli.ts `inserts`, all `INSERT OR IGNORE`, so rows are write-once):
//   lineage, lineage_split, trial_ledger, replay_run, replay_stat, validation_result, label
// (mode seed-recent also writes price_bar and run_record; it is manual only and is NOT synced here: it
// copies history files into the window the nightly would otherwise ingest, and the refresh carries it.)
// Only those seven tables are ever touched, in parent-first order (lineage_split's trigger needs its lineage).
//
// "Newer than the last sync" without a watermark: the tables are append-only and WITHOUT ROWID, and the
// refresh makes Turso identical to sqld before each replay, so the rows to copy are exactly those Turso has
// and sqld does not. A table is scanned only when Turso holds MORE rows than sqld (one count each), in
// primary-key pages (no OFFSET), and each row is written with INSERT ... ON CONFLICT DO NOTHING (never a
// REPLACE), so a repeat is a no-op and a partial run is simply finished by the next one.
//
// THE GUARD (single-clock rule, §6): runs only when `worker_state.clock_owner` in sqld is "selfhost"
// (ownerFrom of scripts/time/ownerGate.mjs: anything else is cloud). Otherwise exit 3 = standby, nothing is
// read from Turso or written. Turso is only READ here, never written.
//
// Exit codes: 0 = synced (or nothing to do); 1 = error; 3 = standby (the clock treats it as a no-op).
// env (names only): TURSO_MAIN_URL, TURSO_MAIN_TOKEN (sqld, the destination, as for every job);
//   TURSO_REFRESH_MAIN_URL, TURSO_REFRESH_MAIN_TOKEN (the Turso main database, the source: the same names
//   turso-refresh already uses, so no new secret).
// Output: statuses, table names and row counts. Never a URL, a token or row content.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { sameDatabase } from "../restore/restore.mjs";
import { ownerFrom } from "../time/ownerGate.mjs";

export const CLOCK_OWNER_KEY = "clock_owner";
export const PAGE = 500;

/** Replay's result tables, parent first, with their primary-key columns (see the migrations 0008). */
export const REPLAY_TABLES = [
  { name: "lineage", pk: ["id"] },
  { name: "lineage_split", pk: ["lineage_id", "version"] },
  { name: "trial_ledger", pk: ["id"] },
  { name: "replay_run", pk: ["id"] },
  { name: "validation_result", pk: ["id"] },
  { name: "label", pk: ["id"] },
  { name: "replay_stat", pk: ["run_id", "scope", "metric"] },
];

const has = (v) => typeof v === "string" && v.trim() !== "";
class Fail extends Error {}
class Standby extends Fail {}
const fail = (why) => {
  throw new Fail(why);
};

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readOwner(db) {
  try {
    const r = await db.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [CLOCK_OWNER_KEY],
    });
    return r.rows.length ? ownerFrom(String(r.rows[0].value_json)) : null;
  } catch {
    return null;
  }
}

const countOf = async (db, table) =>
  Number((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

/** Copies the rows of one table that Turso has and sqld lacks. Returns { scanned, inserted }. */
export async function copyTable(source, dest, { name, pk }) {
  const cols = (await dest.execute(`PRAGMA table_info(${name})`)).rows.map((r) => String(r.name));
  if (cols.length === 0) fail(`${name}: missing in sqld`);
  const srcCols = (await source.execute(`PRAGMA table_info(${name})`)).rows.map((r) =>
    String(r.name),
  );
  if (srcCols.length === 0) return { scanned: 0, inserted: 0, skipped: "missing in Turso" };
  const common = cols.filter((c) => srcCols.includes(c));
  if (!pk.every((k) => common.includes(k))) fail(`${name}: primary key columns differ`);
  const insert = `INSERT INTO ${name} (${common.join(", ")}) VALUES (${common.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
  const order = pk.join(", ");
  const after = pk.length === 1 ? `${pk[0]} > ?` : `(${order}) > (${pk.map(() => "?").join(", ")})`;
  let last = null;
  let scanned = 0;
  let inserted = 0;
  for (;;) {
    const page = await source.execute({
      sql: `SELECT ${common.join(", ")} FROM ${name}${last ? ` WHERE ${after}` : ""} ORDER BY ${order} LIMIT ${PAGE}`,
      args: last ?? [],
    });
    if (page.rows.length === 0) break;
    const res = await dest.batch(
      page.rows.map((r) => ({ sql: insert, args: common.map((c) => r[c]) })),
      "write",
    );
    for (const x of res) inserted += x.rowsAffected;
    scanned += page.rows.length;
    const lastRow = page.rows[page.rows.length - 1];
    last = pk.map((k) => lastRow[k]);
    if (page.rows.length < PAGE) break;
  }
  return { scanned, inserted };
}

/** Sync all replay tables. `source` and `dest` are libSQL clients. */
export async function syncReplay(source, dest, log = () => {}) {
  const parts = [];
  for (const t of REPLAY_TABLES) {
    const [have, want] = [
      await countOf(dest, t.name),
      await countOf(source, t.name).catch(() => 0),
    ];
    if (want <= have) {
      parts.push(`${t.name}(+0)`);
      continue;
    }
    // re-check the owner before every write series: a switch during the run stops it
    if ((await readOwner(dest)) !== "selfhost") throw new Standby("owner changed during the run");
    const r = await copyTable(source, dest, t);
    log(`replay-sync: ${t.name} scanned ${r.scanned}`);
    parts.push(`${t.name}(+${r.inserted})`);
  }
  return parts;
}

const defaultOpen = (url, token) =>
  createClient({
    url: url.trim(),
    authToken: has(token) ? token.trim() : undefined,
    intMode: "bigint",
  });

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ open?: (url: string, token?: string) => import("@libsql/client").Client, out?: (s: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const open = deps.open ?? defaultOpen;
  const opened = [];
  try {
    if (argv.length > 0) fail("usage: (no arguments)");
    if (!has(env.TURSO_MAIN_URL)) fail("TURSO_MAIN_URL (the sqld destination) is not set");
    if (!has(env.TURSO_REFRESH_MAIN_URL) || !has(env.TURSO_REFRESH_MAIN_TOKEN)) {
      fail("TURSO_REFRESH_MAIN_URL / TURSO_REFRESH_MAIN_TOKEN (the Turso source) are not set");
    }
    if (sameDatabase(env.TURSO_MAIN_URL, env.TURSO_REFRESH_MAIN_URL)) {
      fail("the source is the destination database");
    }
    const dest = open(env.TURSO_MAIN_URL, env.TURSO_MAIN_TOKEN);
    opened.push(dest);
    const owner = await readOwner(dest);
    if (owner !== "selfhost") {
      throw new Standby(
        owner === null
          ? "refused: cannot read clock_owner in sqld"
          : "refused: clock_owner is not selfhost; replay results stay in Turso",
      );
    }
    const source = open(env.TURSO_REFRESH_MAIN_URL, env.TURSO_REFRESH_MAIN_TOKEN);
    opened.push(source);
    const parts = await syncReplay(source, dest, out);
    out(`replay-sync: PASS ${parts.join(" ")}`);
    return 0;
  } catch (e) {
    const standby = e instanceof Standby;
    out(
      `replay-sync: ${standby ? "REFUSED" : "FAIL"} ${e instanceof Fail ? e.message : "unexpected error"}`,
    );
    return standby ? 3 : 1;
  } finally {
    for (const c of opened) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
