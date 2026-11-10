// INFRA T5 (REQ\infra\INFRA_REQUIREMENT.md §8.2 item 3): while the self-hosted runtime owns the
// clock, refresh the Turso copy from sqld every night, so a switch back to cloud loses at most one
// day. HIGH-RISK: this REPLACES the Turso data.
//
// THE GUARD (the single-clock rule, §6): it runs only when `worker_state.clock_owner` in the SOURCE
// database (sqld main) is the JSON string "selfhost". Absent, unreadable, "cloud" or any other
// value means Turso is (or may be) the data of record and is NEVER touched. The owner is read
// before the dump and again right before the first write (a switch during the dump stops the run).
//
// SECOND, INDEPENDENT GUARD: the TARGET Turso main database must ALSO say "selfhost" (runbook 11.3 step 2
// sets it there at cutover). Read once before any write and again right before the first DROP; absent,
// unreadable or "cloud" means REFUSED and nothing is written (a wrong key on the server cannot empty
// the live cloud database).
//
// Exit codes: 0 = refreshed (or dry run ok); 1 = real error (config, dump, restore); 3 = standby, a
// guard refused, nothing was written (the clock treats this as a no-op, no alert).
//
// Usage: node scripts/selfhost/turso-refresh.mjs [--dry-run]
//   --dry-run: guard + dump + verify, writes nothing.
// env (names only; values live in the server's env files):
//   source (sqld):  TURSO_MAIN_URL, TURSO_MAIN_TOKEN   [TURSO_AUTH_URL, TURSO_AUTH_TOKEN: auth, if present]
//   target (Turso): TURSO_REFRESH_MAIN_URL, TURSO_REFRESH_MAIN_TOKEN
//                   [TURSO_REFRESH_AUTH_URL, TURSO_REFRESH_AUTH_TOKEN]
//   The target must differ from the source. The auth database is refreshed only when both its
//   source and its target are configured (the jobs container never holds the auth database).
// Steps per database: dump the source (one read snapshot, in memory) -> parse and verify the
//   stream -> re-check the owner -> wipe the target's tables -> restore (the same restoreDatabase
//   the restore scripts use) -> verify counts, sha256, foreign keys, no orphan rows.
//   If the restore fails after the wipe, Turso is left empty or partial; it is a stale copy by
//   definition while selfhost owns the clock, and the next run (or `praxis restore`) rebuilds it.
// Output: statuses, table and row counts. Never a URL, a token or row content.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dumpDatabase } from "../backup/core.mjs";
import { sameDatabase } from "../restore/restore.mjs";
import { ownerFrom } from "../time/ownerGate.mjs";
import { restoreVerified, SqldError, wipeDatabase } from "./sqld.mjs";

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
  const track = (c) => {
    opened.push(c);
    return c;
  };
  try {
    let dry = false;
    for (const a of argv) {
      if (a === "--dry-run") dry = true;
      else refuse("usage: [--dry-run]");
    }
    const plan = planFromEnv(env);
    const main = plan[0];
    const sourceMain = track(open(main.source.url, main.source.token));
    await assertSelfhostOwns(sourceMain); // guard 1: before anything is read or written
    const targetMain = track(open(main.target.url, main.target.token));
    await assertTargetSelfhost(targetMain); // guard 1b: the target agrees

    const summary = [];
    for (const p of plan) {
      const source = p.name === "main" ? sourceMain : track(open(p.source.url, p.source.token));
      const dump = await dumpDatabase(source, {
        name: p.name,
        createdAt: new Date(now()).toISOString(),
      });
      const tables = dump.meta.tables.length;
      const rows = Object.values(dump.counts).reduce((a, b) => a + b, 0);
      if (dry) {
        summary.push(`${p.name}(tables=${tables} rows=${rows} dry-run)`);
        continue;
      }
      await assertSelfhostOwns(sourceMain); // guard 2: a switch during the dump stops the run
      await assertTargetSelfhost(targetMain); // guard 2b: right before the first DROP
      const target = p.name === "main" ? targetMain : track(open(p.target.url, p.target.token));
      const dropped = await wipeDatabase(target);
      const r = await restoreVerified(target, dump.text, { expectDb: p.name });
      summary.push(`${p.name}(tables=${r.tables} rows=${r.rows} replaced=${dropped})`);
    }
    out(
      `turso-refresh: ${dry ? "DRY RUN ok" : "PASS"} ${summary.join(" ")} elapsed ${Math.round((now() - started) / 1000)}s`,
    );
    return 0;
  } catch (e) {
    const msg =
      e instanceof SqldError || /^backup stream rejected:/.test(String(e?.message))
        ? e.message
        : "unexpected error";
    const standbyRun = e instanceof StandbyError;
    out(`turso-refresh: ${standbyRun ? "REFUSED" : "FAIL"} ${msg}`);
    return standbyRun ? 3 : 1;
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
