// Command-line entry points of the daily orchestrator (M3 T10). Bundled and run by
// scripts/arena/close-books.mjs (the GitHub Actions job `arena-close.yml`) and
// scripts/arena/replay.mjs (a replay into a local file); this module holds all the logic so the
// tests can call it directly.
//
//   close-books [--date YYYY-MM-DD] [--wait-minutes N] [--max-sessions N] [--replay]
//   replay --db file:<path> --from YYYY-MM-DD --to YYYY-MM-DD [--market AU]
//
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional).
// Output: statuses and counts only. Never a row, a code, a URL, a token or a driver error.
// Exit codes: 0 success / expected skip, 1 failed (or Batch 1 still missing after the wait),
// 2 usage.
//
// Batch 2a runs as soon as Batch 1 has written D's completion marker (design 4.1). If Batch 1 is
// late the job waits (`--wait-minutes`, default 20) and then fails visibly; it never closes the
// books on a stale ledger. A missed earlier session is caught up first, oldest first.
import { appendFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { addDays, marketDate, sessionsBetween } from "@/lib/data/calendar";
import { ARENA_JOB, closeBooksDay, loadCalendar, type CloseBooksResult } from "./closeBooks";
import { replaySessions } from "./replay";

const MARKET = "AU";
const MARKET_TZ = "Australia/Sydney";
const DEFAULT_WAIT_MINUTES = 20;
const POLL_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 10;

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

export type CliDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly out?: (line: string) => void;
};

function defaults(deps: CliDeps) {
  return {
    openDb:
      deps.openDb ??
      ((url: string, authToken: string | undefined) =>
        createClient({ url, authToken, intMode: "bigint" })),
    nowMs: deps.nowMs ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    out: deps.out ?? ((line: string) => console.log(line)),
  };
}

function summary(r: CloseBooksResult): string {
  const why = r.reason === null ? "" : ` (${r.reason})`;
  return (
    `arena-2a ${r.market} ${r.d}: ${r.status}${why} cohorts=${r.closed.length}` +
    ` failed=${r.failed.length} frozen=${r.frozen.length} terminal=${r.terminal.length}` +
    ` fills=${r.stats.fills} navDays=${r.stats.navDays}`
  );
}

async function hasMarker(db: Client, d: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM completion_marker WHERE market = ? AND d = ? AND kind = 'data'",
    args: [MARKET, d],
  });
  return rs.rows.length > 0;
}

/** Last session with a successful batch 2a (the record's scheduled_for), or null. */
async function lastClosed(db: Client): Promise<string | null> {
  const rs = await db.execute({
    sql: `SELECT MAX(scheduled_for) AS d FROM run_record
          WHERE job = ? AND market = ? AND status = 'success'`,
    args: [ARENA_JOB, MARKET],
  });
  const d = rs.rows.length === 0 ? null : rs.rows[0].d;
  return d === null || d === undefined ? null : String(d);
}

export async function closeBooksMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<number> {
  const { openDb, nowMs, sleep, out } = defaults(deps);
  const replay = argv.includes("--replay");
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !url.startsWith("file:"))) {
    out("arena-2a: failed (database not configured)");
    return 1;
  }
  // D-066 / BLD-024: a replay writes arena tables of a data_only market, so it may only ever
  // run against a local file, never a remote (production) database.
  if (replay && !url.startsWith("file:")) {
    out("arena-2a: refused (--replay needs a local file: database)");
    return 2;
  }
  const waitMinutes = Number.parseInt(flag(argv, "--wait-minutes") ?? "", 10);
  const maxSessions = Number.parseInt(flag(argv, "--max-sessions") ?? "", 10);
  const wait =
    Number.isInteger(waitMinutes) && waitMinutes >= 0 ? waitMinutes : DEFAULT_WAIT_MINUTES;
  const cap =
    Number.isInteger(maxSessions) && maxSessions >= 1 ? maxSessions : DEFAULT_MAX_SESSIONS;
  const date = flag(argv, "--date");
  let db: Client;
  try {
    db = openDb(url, has(token) ? token : undefined);
  } catch {
    out("arena-2a: failed (cannot open database)");
    return 1;
  }
  let exit = 0;
  const lines: string[] = [];
  try {
    const target = date ?? marketDate(new Date(nowMs()), MARKET_TZ);
    const calendar = await loadCalendar(db, MARKET);
    const done = await lastClosed(db);
    let sessions =
      done === null || done >= target
        ? [target]
        : sessionsBetween(addDays(done, 1), target, calendar);
    if (sessions.length === 0) sessions = [target];
    if (sessions.length > cap) sessions = sessions.slice(sessions.length - cap);
    const mode = await db.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [MARKET],
    });
    const writes = mode.rows.length > 0 && (String(mode.rows[0].mode) === "full" || replay);
    for (const d of sessions) {
      const isTarget = d === target;
      // Batch 1 late: wait for the target's marker only when this run could actually write
      if (writes && isTarget) {
        const deadline = nowMs() + wait * 60_000;
        while (!(await hasMarker(db, d)) && nowMs() < deadline) await sleep(POLL_MS);
      }
      const result = await closeBooksDay(db, {
        market: MARKET,
        d,
        replay,
        calendar,
        now: () => new Date(nowMs()).toISOString(),
        commitSha: has(env.COMMIT_SHA) ? env.COMMIT_SHA : undefined,
      });
      out(summary(result));
      lines.push(`status=${result.status}`);
      if (result.status === "failed") {
        exit = 1;
        break;
      }
      if (result.status === "skipped" && result.reason === "no_completion_marker") {
        // an older session without Batch 1 data blocks the later ones (the ledger closes in order)
        exit = 1;
        break;
      }
    }
  } catch (error) {
    // Never print a driver error message: it can carry the database URL. The class name is safe.
    out(`arena-2a: failed (unexpected error ${error instanceof Error ? error.name : "unknown"})`);
    exit = 1;
  } finally {
    db.close();
  }
  if (has(env.GITHUB_OUTPUT) && lines.length > 0) {
    appendFileSync(env.GITHUB_OUTPUT, `${lines[lines.length - 1]}\n`);
  }
  return exit;
}

export async function replayMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<number> {
  const { openDb, nowMs, out } = defaults(deps);
  const url = flag(argv, "--db") ?? env.TURSO_MAIN_URL;
  const from = flag(argv, "--from");
  const to = flag(argv, "--to");
  if (!has(url) || from === null || to === null) {
    out("arena-replay: failed (usage: --db file:<path> --from YYYY-MM-DD --to YYYY-MM-DD)");
    return 2;
  }
  if (!url.startsWith("file:")) {
    out("arena-replay: refused (a replay runs against a local file: database only)");
    return 2;
  }
  const market = flag(argv, "--market") ?? MARKET;
  const db = openDb(url, undefined);
  try {
    const results = await replaySessions(db, {
      market,
      from,
      to,
      now: () => new Date(nowMs()).toISOString(),
    });
    const by: Record<string, number> = {};
    for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
    out(
      `arena-replay ${market} ${from}..${to}: sessions=${results.length} ` +
        Object.entries(by)
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );
    return results.some((r) => r.status === "failed") ? 1 : 0;
  } catch (error) {
    out(
      `arena-replay: failed (unexpected error ${error instanceof Error ? error.name : "unknown"})`,
    );
    return 1;
  } finally {
    db.close();
  }
}
