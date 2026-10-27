// ASX store step (D-194): the commit half of the GitHub ASX fetch. Reads what scripts/asx/fetch.mjs
// wrote (no secret was involved in fetching) and stores it with the app's own code paths:
//   feed.json / history-NNN.json -> ingestFeed (first-seen announcements, then the Sentinel queue)
//   companies.csv            -> importUniverse (once per trading day; a repeat is "already applied")
// and records the poll in `sentinel_poll_day` with the Worker's own statement, so System Health
// sees the Sentinel polling. Bundled and run by scripts/asx/ingest.mjs. Output: counts only, never
// a row, a URL or a driver error.
//   asx-ingest --dir <dir>
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { importUniverse } from "@/lib/data/universe/import";
import { ingestFeed } from "@/lib/sentinel/ingest";

const MARKET = "AU";

export type AsxIngestDeps = {
  readonly openDb?: (url: string, token: string | undefined) => Client;
  readonly nowMs?: () => number;
  readonly out?: (line: string) => void;
};

const has = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The Worker's sentinel_poll_day upsert (worker/src/asx/sentinel.ts pollDayStmt), app side. */
export function pollDayStatement(nowIso: string, date: string, ok: boolean) {
  return {
    sql:
      "INSERT INTO sentinel_poll_day (market, source, d, scheduled, ok, not_modified, failed, blocked, max_gap_s, last_ok_at) " +
      "VALUES (?, ?, ?, 1, ?, 0, ?, 0, 0, ?) " +
      "ON CONFLICT (market, source, d) DO UPDATE SET " +
      "scheduled = scheduled + 1, ok = ok + excluded.ok, failed = failed + excluded.failed, " +
      "max_gap_s = CASE WHEN excluded.last_ok_at IS NOT NULL AND sentinel_poll_day.last_ok_at IS NOT NULL " +
      "THEN MAX(max_gap_s, CAST(ROUND((julianday(excluded.last_ok_at) - julianday(sentinel_poll_day.last_ok_at)) * 86400) AS INTEGER)) " +
      "ELSE max_gap_s END, " +
      "last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at)",
    args: [MARKET, ASX_SOURCE, date, ok ? 1 : 0, ok ? 0 : 1, ok ? nowIso : null],
  };
}

export async function asxIngestMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: AsxIngestDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const nowMs = deps.nowMs ?? Date.now;
  const i = argv.indexOf("--dir");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!has(dir)) {
    out("asx-ingest: failed (usage: --dir <dir>)");
    return 2;
  }
  if (!has(env.TURSO_MAIN_URL)) {
    out("asx-ingest: failed (database not configured)");
    return 1;
  }
  const open = deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t }));
  const db = open(env.TURSO_MAIN_URL, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  const now = new Date(nowMs()).toISOString();
  const today = sydneyDate(nowMs());
  const read = (name: string): string | null => {
    const p = path.join(dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  let exit = 0;
  try {
    const cap = await getConfig(db, "sentinel_max_items_per_run").catch(() => undefined);
    let feedOk = false;
    const history = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => /^history-\d{3}\.json$/.test(n))
          .sort()
      : [];
    for (const name of ["feed.json", ...history]) {
      const body = read(name);
      if (body === null) continue;
      const sha = createHash("sha256").update(body).digest("hex");
      const r = await ingestFeed({
        db,
        feed: body,
        sha,
        today,
        now,
        maxItems: typeof cap === "number" ? cap : undefined,
      });
      if (r.ok) {
        if (name === "feed.json") feedOk = true;
        out(`asx-ingest ${name}: ok seen=${r.seen} new=${r.new} assessed=${r.assessed}`);
      } else {
        out(`asx-ingest ${name}: failed (${r.error})`);
        exit = 1;
      }
    }
    await db.execute(pollDayStatement(now, today, feedOk));
    const csv = read("companies.csv");
    if (csv !== null) {
      const u = await importUniverse({ db, csv, today, now: () => now, env });
      out(`asx-ingest companies: ${u.ok ? u.status : `failed (${u.error})`}`);
      if (!u.ok) exit = 1;
    }
  } catch (e) {
    out(`asx-ingest: failed (unexpected error ${e instanceof Error ? e.name : "unknown"})`);
    exit = 1;
  } finally {
    db.close();
  }
  return exit;
}
