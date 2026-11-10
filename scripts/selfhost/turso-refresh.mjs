// INFRA T5 (REQinfraINFRA_REQUIREMENT.md §8.2 item 3): while the self-hosted runtime owns the
// clock, refresh the Turso copy from sqld every night, so a switch back to cloud loses at most one
// day. HIGH-RISK: this WRITES the Turso data.
//
// DESIGN (review B4 + S5, Owner rules: Turso FREE plan never exceeded, use <= 20 % of it, no OFFSET paging):
// INCREMENTAL and non-destructive (see turso-sync.mjs). Nothing is wiped; worker_state is never dropped, so the
// cloud gates keep reading clock_owner=selfhost the whole time; only new/changed rows are written, rows that only
// Turso has are deleted (except worker_state and replay's result tables). A table whose schema differs (a
// migration that ran on sqld only) is rebuilt (dropped and re-created, with the tables that reference it).
//
// QUOTA (Turso FREE plan: 500 M rows read, 10 M rows written per month; source https://turso.tech/pricing,
// read 2026-11-10). Budget for this job = 20 %: 100 M reads and 2 M writes per rolling 30 days, enforced by a
// usage meter in sqld worker_state (key turso_refresh_usage, 30 daily buckets; the run refuses/stops when the
// rolling total would pass the budget; one run never writes more than 300 000 rows).
//   Estimate per run, with ~1 M rows in the main database (price_bar alone was ~490 k in D-199; adjust with
//   the "scanned" figure of the PASS line, which is the source row count):
//     reads  = one scan of every copied table in Turso = ~1 M rows   -> ~30 M / month = 6 % of the free reads
//     writes = changed rows only: a night adds a few thousand rows (ingest, picks, run_record, job_run) -> say
//              10 k / night = 0.3 M / month = 3 % of the free writes. The first run on an empty or restored Turso
//              (or after a schema rebuild) writes every row once: ~1 M = 10 % of one month, then falls back.
//   The old design wiped and re-inserted every row every night: ~1 M writes/night = 30 M/month = 300 % of the free
//   writes (the review's "~10 M+" was for ~330 k rows). It would have cost money or been cut off.
//   Reads from sqld are local and free. Costs of DDL (DROP/CREATE of a rebuilt table) are not row counts and are
//   not metered; a rebuild is rare (a migration) and a dropped table is not read back.
//
// THE GUARD (the single-clock rule, §6): it runs only when `worker_state.clock_owner` in the SOURCE
// database (sqld main) is the JSON string "selfhost". Absent, unreadable, "cloud" or any other
// value means Turso is (or may be) the data of record and is NEVER touched. The owner is read
// before the diff and again before every write series (a switch during the run stops it).
//
// SECOND, INDEPENDENT GUARD: the TARGET Turso main database must ALSO say "selfhost" (runbook 11.3 step 2
// sets it there at cutover). Read before any write and again before every write series; absent,
// unreadable or "cloud" means REFUSED and nothing is written (a wrong key on the server cannot change the
// live cloud database).
//
// Exit codes: 0 = refreshed (or dry run ok); 1 = real error (config, schema, budget, write); 3 = standby, a
// guard refused, nothing was written (the clock treats this as a no-op, no alert).
//
// Usage: node scripts/selfhost/turso-refresh.mjs [--dry-run] [--verify] [--rebuild <table>[,<table>]]
//   --dry-run: guards + schema + diff, writes nothing in Turso (it still reads Turso once, and meters that).
//   --verify:  after the writes, re-diff every table (a second Turso read pass) and fail if anything differs.
//   --rebuild: force the named tables to be dropped and copied again (recovery from a constraint failure).
// env (names only; values live in the server's env files):
//   source (sqld):  TURSO_MAIN_URL, TURSO_MAIN_TOKEN   [TURSO_AUTH_URL, TURSO_AUTH_TOKEN: auth, if present]
//   target (Turso): TURSO_REFRESH_MAIN_URL, TURSO_REFRESH_MAIN_TOKEN
//                   [TURSO_REFRESH_AUTH_URL, TURSO_REFRESH_AUTH_TOKEN]
//   The target must differ from the source. The auth database is refreshed only when both its
//   source and its target are configured (the jobs container never holds the auth database).
// Triggers of a table being written are dropped and re-created from the source at the end (also after a
//   failure); if the process is killed in between, the next run repairs them.
// Output: statuses and counts. Never a URL, a token or row content.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { sameDatabase } from "../restore/restore.mjs";
import { ownerFrom } from "../time/ownerGate.mjs";
import { SqldError } from "./sqld.mjs";
import { BudgetError, Meter, refreshDatabase } from "./turso-sync.mjs";

export const CLOCK_OWNER_KEY = "clock_owner";
const has = (v) => typeof v === "string" && v.trim() !== "";

export class RefuseError extends SqldError {}
/** A guard refused: standby, nothing to do (exit code 3). */
export class StandbyError extends RefuseError {}
const refuse = (why) => {
  throw new RefuseError(why);
};
const standby = (why) => {
  throw new StandbyError(why);
};

/**
 * The owner named in a database, or null when it cannot be read. Never throws.
 * @param {Pick<import("@libsql/client").Client, "execute">} db
 * @returns {Promise<"cloud" | "selfhost" | null>}
 */
export async function readClockOwner(db) {
  try {
    const r = await db.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [CLOCK_OWNER_KEY],
    });
    return ownerFrom(r.rows.length ? String(r.rows[0].value_json) : null);
  } catch {
    return null;
  }
}

/**
 * The guard. Throws RefuseError unless the source database says `selfhost`.
 * @param {Pick<import("@libsql/client").Client, "execute">} sourceDb
 */
export async function assertSelfhostOwns(sourceDb) {
  const owner = await readClockOwner(sourceDb);
  if (owner === null) standby("refused: cannot read clock_owner in the source database");
  if (owner !== "selfhost") {
    standby("refused: clock_owner is not selfhost; Turso is the data of record and is left alone");
  }
}

/** The target guard: the target Turso main database must say selfhost too. */
export async function assertTargetSelfhost(targetMainDb) {
  const owner = await readClockOwner(targetMainDb);
  if (owner === null) standby("refused: cannot read clock_owner in the target database");
  if (owner !== "selfhost") {
    standby("refused: the target clock_owner is not selfhost; Turso is left alone");
  }
}

/** The databases to refresh, from env. */
export function planFromEnv(env) {
  const plan = [];
  if (!has(env.TURSO_MAIN_URL)) refuse("TURSO_MAIN_URL (the sqld source) is not set");
  if (!has(env.TURSO_REFRESH_MAIN_URL) || !has(env.TURSO_REFRESH_MAIN_TOKEN)) {
    refuse("TURSO_REFRESH_MAIN_URL / TURSO_REFRESH_MAIN_TOKEN (the Turso target) are not set");
  }
  plan.push({
    name: "main",
    source: { url: env.TURSO_MAIN_URL, token: env.TURSO_MAIN_TOKEN },
    target: { url: env.TURSO_REFRESH_MAIN_URL, token: env.TURSO_REFRESH_MAIN_TOKEN },
  });
  if (has(env.TURSO_AUTH_URL) && has(env.TURSO_REFRESH_AUTH_URL)) {
    plan.push({
      name: "auth",
      source: { url: env.TURSO_AUTH_URL, token: env.TURSO_AUTH_TOKEN },
      target: { url: env.TURSO_REFRESH_AUTH_URL, token: env.TURSO_REFRESH_AUTH_TOKEN },
    });
  }
  for (const p of plan) {
    if (sameDatabase(p.source.url, p.target.url)) refuse("the target is the source database");
    if (!/^(libsql|https|wss|file):/i.test(p.target.url.trim())) {
      refuse("the target must be a Turso (libsql:/https:) URL");
    }
    if (!/^file:/i.test(p.target.url.trim()) && !has(p.target.token)) {
      refuse("the target token is not set");
    }
  }
  return plan;
}

const defaultOpen = (url, token) =>
  createClient({
    url: url.trim(),
    authToken: has(token) ? token.trim() : undefined,
    intMode: "bigint",
  });

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ open?: (url: string, token?: string) => import("@libsql/client").Client,
 *   now?: () => number, out?: (s: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const open = deps.open ?? defaultOpen;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const opened = [];
  let meter = null;
  const track = (c) => {
    opened.push(c);
    return c;
  };
  try {
    let dry = false;
    let verify = false;
    let forceRebuild = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--dry-run") dry = true;
      else if (a === "--verify") verify = true;
      else if (a === "--rebuild" && argv[i + 1]) {
        forceRebuild = argv[++i].split(",").filter(Boolean);
      } else refuse("usage: [--dry-run] [--verify] [--rebuild <table>[,<table>]]");
    }
    const plan = planFromEnv(env);
    const main = plan[0];
    const sourceMain = track(open(main.source.url, main.source.token));
    await assertSelfhostOwns(sourceMain); // guard 1: before anything is read or written
    const targetMain = track(open(main.target.url, main.target.token));
    await assertTargetSelfhost(targetMain); // guard 1b: the target agrees
    meter = new Meter(sourceMain, now);
    await meter.load();
    const guard = async () => {
      meter.read(1);
      await assertSelfhostOwns(sourceMain); // a switch during the run stops it, before every write series
      await assertTargetSelfhost(targetMain);
    };

    const summary = [];
    for (const p of plan) {
      const source = p.name === "main" ? sourceMain : track(open(p.source.url, p.source.token));
      const target = p.name === "main" ? targetMain : track(open(p.target.url, p.target.token));
      const r = await refreshDatabase({
        name: p.name,
        source,
        target,
        meter,
        guard,
        dry,
        verify,
        forceRebuild,
      });
      summary.push(
        `${p.name}(tables=${r.tables} rows=${r.scanned} written=${r.upserted} deleted=${r.deleted} rebuilt=${r.rebuilt}${dry ? " dry-run" : ""})`,
      );
    }
    await meter.flush();
    out(
      `turso-refresh: ${dry ? "DRY RUN ok" : "PASS"} ${summary.join(" ")} turso-reads=${meter.reads} turso-writes=${meter.writes} elapsed ${Math.round((now() - started) / 1000)}s`,
    );
    return 0;
  } catch (e) {
    const msg =
      e instanceof SqldError ||
      e instanceof BudgetError ||
      /^backup stream rejected:/.test(String(e?.message))
        ? e.message
        : "unexpected error";
    const standbyRun = e instanceof StandbyError;
    out(`turso-refresh: ${standbyRun ? "REFUSED" : "FAIL"} ${msg}`);
    return standbyRun ? 3 : 1;
  } finally {
    if (meter) await meter.flush().catch(() => {});
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
