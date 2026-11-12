// ASX store step (D-194): the commit half of the GitHub ASX fetch. Reads what scripts/asx/fetch.mjs
// wrote (no secret was involved in fetching) and stores it with the app's own code paths:
//   feed.json / history-NNN.json -> ingestFeed (first-seen announcements, then the Sentinel queue)
//   companies.csv            -> importUniverse (once per trading day; a repeat is "already applied")
// and records the poll in `sentinel_poll_day` with the Worker's own statement, so System Health
// sees the Sentinel polling. Bundled and run by scripts/asx/ingest.mjs. Output: counts only, never
// a row, a URL or a driver error.
//   asx-ingest --dir <dir>
//   asx-ingest --write-state <file>   read-only: the delisted codes, the list-failure counter and
//                                     whether the Wikidata fallback row is enabled (D-972, D-974)
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { scriptDb } from "@/lib/db/scriptClient.mjs";
import { getConfig } from "@/lib/config/store";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { HOME_CUTOFF, HOME_MARKET } from "@/lib/market/homeMarket.mjs";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { cutoffPollStatement } from "@/lib/sentinel/cutoffPoll";
import { importUniverse } from "@/lib/data/universe/import";
import { parseListedCompanies } from "@/lib/data/universe/parse.mjs";
import { applyFetchStatus, parseFetchStatus, readFetchState } from "@/lib/data/codeHistory";
import { loadEffectiveCap } from "@/lib/sentinel/cap";
import { ingestFeed } from "@/lib/sentinel/ingest";

/** The market of the ASX feed this module ingests: the home market (M19 C2, D-1051). */
const MARKET = HOME_MARKET;

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
  const w = argv.indexOf("--write-state");
  const stateFile = w >= 0 ? argv[w + 1] : undefined;
  if (w >= 0 ? !has(stateFile) : !has(dir)) {
    out("asx-ingest: failed (usage: --dir <dir> | --write-state <file>)");
    return 2;
  }
  if (!has(env.TURSO_MAIN_URL)) {
    out("asx-ingest: failed (database not configured)");
    return 1;
  }
  const open = deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t }));
  const db = open(env.TURSO_MAIN_URL, has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined);
  if (w >= 0 && has(stateFile)) {
    try {
      const s = await readFetchState(db);
      writeFileSync(stateFile, JSON.stringify(s));
      out(
        `asx-ingest state: delisted=${s.delisted.length} list_failures=${s.consecutiveFailures} fallback_row=${s.wikidataEnabled ? "enabled" : "off"}`,
      );
      return 0;
    } catch {
      // the fetch then runs without a skip list and without the fallback: never a reason to stop
      out("asx-ingest state: unreadable (the fetch runs without a skip list)");
      return 0;
    } finally {
      db.close();
    }
  }
  if (!has(dir)) return 2;
  const now = new Date(nowMs()).toISOString();
  const today = sydneyDate(nowMs());
  const read = (name: string): string | null => {
    const p = path.join(dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  let exit = 0;
  try {
    // DAT-251 b (D-954): the key, bounded by the LLM headroom and, near the Turso line, by 40.
    const cap = await loadEffectiveCap(db, new Date(nowMs())).catch(() => undefined);
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
        maxItems: cap?.cap,
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
    // GL-05: the first poll that was fetched at or after the cut-off and fully stored is the marker
    // batch 2b waits for. The fetch step wrote feed.json just before this step, so its mtime is the
    // fetch time; the marker instant is the time the store finished (never before an ingested_at).
    if (feedOk) {
      try {
        const cutoffHm = await getConfig(db, "decision_cutoff").catch(() => undefined);
        const cutoffMs = Date.parse(
          decisionCutoffUtc(today, typeof cutoffHm === "string" ? cutoffHm : HOME_CUTOFF),
        );
        const fetchedMs = statSync(path.join(dir, "feed.json")).mtimeMs;
        if (fetchedMs >= cutoffMs) {
          const s = cutoffPollStatement(MARKET, today, new Date(nowMs()).toISOString());
          await db.execute(s);
        }
      } catch {
        // the marker is best effort: batch 2b falls back to cut-off + 4 minutes
      }
    }
    const asxCsv = read("companies.csv");
    // D-974: the Wikidata CSV is taken only when the ASX file did not arrive (fetch.mjs wrote it only
    // after three failed runs with the register row enabled).
    const csv = asxCsv ?? read("companies-wikidata.csv");
    const fromWikidata = asxCsv === null && csv !== null;
    if (csv !== null) {
      const u = await importUniverse({
        db,
        csv,
        today,
        now: () => now,
        env,
        source: fromWikidata ? "wikidata" : undefined,
      });
      out(
        `asx-ingest companies${fromWikidata ? " (wikidata fallback)" : ""}: ${u.ok ? u.status : `failed (${u.error})`}`,
      );
      if (!u.ok) exit = 1;
    }
    // D-972 / D-974: what the fetch learned (causes, not_found codes, the list-failure counter).
    const status = parseFetchStatus(read("fetch-status.json"));
    if (status !== null) {
      try {
        const parsed = asxCsv !== null ? parseListedCompanies(asxCsv) : null;
        const fileCodes =
          parsed !== null && parsed.ok ? new Set(parsed.rows.map((r) => r.code)) : null;
        const a = await applyFetchStatus(db, status, fileCodes, today, now);
        out(
          `asx-ingest history: list_failures=${a.consecutiveFailures} delisted=${a.delisted.length} reappeared=${a.reappeared.length}`,
        );
      } catch {
        out("asx-ingest history: failed (could not store the fetch status)");
        exit = 1;
      }
    }
  } catch (e) {
    out(`asx-ingest: failed (unexpected error ${e instanceof Error ? e.name : "unknown"})`);
    exit = 1;
  } finally {
    db.close();
  }
  return exit;
}
