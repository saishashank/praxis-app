// Applies a listed-companies file to the `instrument` table (M2 T11, D-067). HIGH-RISK: every
// pipeline reads the table this writes. Opus reviews every line.
//
// Flow: already imported for this Sydney date? -> parse (parse.mjs) -> read the AU instruments ->
// plan (apply.mjs, pure) -> ONE write transaction holding every instrument change and the
// `universe-import` run record's move to `success`. The unique success index on the run record's
// concurrency key (`universe-import:AU:<date>`, PLT-076) makes the date idempotent even under a
// race: the second writer's transaction fails as a whole and changes nothing, so the missing-day
// counters can never be counted twice.
//
// Rejections (`unrecognised_format`, `suspicious_shrink`) change no instrument and no counter; they
// leave a failed run record with a fixed word, and a shrink also opens an S2 `universe_shrink`
// incident (once while open). Nothing from the file is ever written to a record, log or incident
// beyond counts. Delisted instruments are never deleted (the table refuses DELETE, DAT-130).
import type { Client, InStatement } from "@libsql/client";
import { openS2Once } from "@/lib/heartbeat/incidents";
import { finishRun, hasSuccess, startRun } from "@/lib/runs/runRecord";
import { DELIST_REASON, planUniverse, REUSE_SUSPECTED, type UniverseCounts } from "./apply.mjs";
import { parseListedCompanies, type ParseStats } from "./parse.mjs";

export const UNIVERSE_JOB = "universe-import";
export const UNIVERSE_MARKET = "AU";
export const UNIVERSE_INCIDENT = "universe_shrink";
/** V1-S7: a delisted code came back looking like a different company; it stays delisted until the Owner decides. */
export const CODE_REUSE_INCIDENT = "code_reuse_suspected";

export const universeKey = (date: string): string => `${UNIVERSE_JOB}:${UNIVERSE_MARKET}:${date}`;

export type ImportError = "unrecognised_format" | "suspicious_shrink" | "unavailable";
export type ImportResult =
  | { ok: true; status: "applied"; counts: UniverseCounts; parsed: ParseStats }
  | { ok: true; status: "already_applied" }
  | { ok: false; error: ImportError };

export type ImportInput = {
  db: Client;
  csv: string;
  /** Sydney date YYYY-MM-DD the import counts for. */
  today: string;
  /** ISO timestamp source (injected so tests are deterministic). */
  now: () => string;
  commit?: string;
  /** Where the file came from: the Worker (default) or the Owner's upload on Configuration (DAT-236). */
  source?: "worker" | "manual";
  /** Email environment: present = the shrink incident is also emailed (M5 T11). */
  env?: Record<string, string | undefined>;
};

/** Records a rejected import: failed run record, plus the S2 incident for a shrink. */
async function reject(
  i: ImportInput,
  error: "unrecognised_format" | "suspicious_shrink",
  details: Record<string, unknown>,
): Promise<ImportResult> {
  const id = await startRun(i.db, {
    job: UNIVERSE_JOB,
    market: UNIVERSE_MARKET,
    concurrencyKey: universeKey(i.today),
    scheduledFor: i.today,
    commitSha: i.commit,
    now: i.now(),
  });
  await finishRun(i.db, id, {
    status: "failed",
    errorSummary: error,
    details: { error, ...details },
    now: i.now(),
  });
  if (error === "suspicious_shrink") {
    await openS2Once(
      i.db,
      UNIVERSE_INCIDENT,
      { rule: "universe_shrink", ...details },
      i.now(),
      i.env ? { env: i.env } : undefined,
      "The listed-companies import was rejected as a suspicious shrink",
    );
  }
  return { ok: false, error };
}

async function hasSectorColumn(db: Client): Promise<boolean> {
  const rs = await db.execute("PRAGMA table_info(instrument)");
  return rs.rows.some((r) => String(r.name) === "sector");
}

export async function importUniverse(i: ImportInput): Promise<ImportResult> {
  try {
    const key = universeKey(i.today);
    if (await hasSuccess(i.db, key)) return { ok: true, status: "already_applied" };

    const parsed = parseListedCompanies(i.csv);
    if (!parsed.ok) return await reject(i, "unrecognised_format", {});

    const res = await i.db.execute({
      sql: "SELECT code, name, industry, delisted_on, delist_reason, missing_count FROM instrument WHERE market = ?",
      args: [UNIVERSE_MARKET],
    });
    const existing = res.rows.map((r) => ({
      code: String(r.code),
      name: String(r.name),
      industry: r.industry === null ? null : String(r.industry),
      delistedOn: r.delisted_on === null ? null : String(r.delisted_on),
      delistReason: r.delist_reason === null ? null : String(r.delist_reason),
      missingCount: Number(r.missing_count),
    }));

    const plan = planUniverse({ existing, file: parsed.rows, today: i.today });
    if (!plan.ok) {
      return await reject(i, "suspicious_shrink", {
        prevActive: plan.prevActive,
        fileCount: plan.fileCount,
      });
    }

    const stmts: InStatement[] = [];
    for (const r of plan.inserts) {
      stmts.push({
        sql:
          "INSERT INTO instrument (market, code, name, listed_on, industry, missing_count) " +
          "VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (market, code) DO NOTHING",
        args: [UNIVERSE_MARKET, r.code, r.name, i.today, r.industry],
      });
    }
    for (const r of plan.updates) {
      stmts.push({
        sql:
          "UPDATE instrument SET name = ?, industry = ? " +
          "WHERE market = ? AND code = ? AND delisted_on IS NULL",
        args: [r.name, r.industry, UNIVERSE_MARKET, r.code],
      });
    }
    for (const r of plan.reactivations) {
      stmts.push({
        sql:
          "UPDATE instrument SET name = ?, industry = ?, missing_count = 0, delisted_on = NULL, " +
          "delist_reason = NULL WHERE market = ? AND code = ? AND delisted_on IS NOT NULL",
        args: [r.name, r.industry, UNIVERSE_MARKET, r.code],
      });
    }
    for (const q of plan.quarantined) {
      // status column only; the old reason is kept inside the new one (DAT-130: delisted, with reason)
      if ((q.priorReason ?? "").startsWith(REUSE_SUSPECTED)) continue; // already recorded
      stmts.push({
        sql:
          "UPDATE instrument SET delist_reason = ? " +
          "WHERE market = ? AND code = ? AND delisted_on IS NOT NULL",
        args: [`${REUSE_SUSPECTED}:${q.priorReason ?? "none"}`, UNIVERSE_MARKET, q.code],
      });
    }
    for (const code of plan.seenAgain) {
      stmts.push({
        sql: "UPDATE instrument SET missing_count = 0 WHERE market = ? AND code = ?",
        args: [UNIVERSE_MARKET, code],
      });
    }
    for (const m of plan.missing) {
      stmts.push({
        sql: "UPDATE instrument SET missing_count = ? WHERE market = ? AND code = ?",
        args: [m.missingCount, UNIVERSE_MARKET, m.code],
      });
    }
    for (const code of plan.delists) {
      stmts.push({
        sql:
          "UPDATE instrument SET delisted_on = ?, delist_reason = ?, missing_count = missing_count + 1 " +
          "WHERE market = ? AND code = ? AND delisted_on IS NULL",
        args: [i.today, DELIST_REASON, UNIVERSE_MARKET, code],
      });
    }

    // M7 T4 (decision 53): the sector is the CSV industry group. Written only when the column exists
    // (main 0011 adds instrument.sector); one statement keeps new, changed and older rows in step.
    // The sector statement is a column sync, not a counted row write: rows_written stays the apply-rule writes.
    const rowsWritten = stmts.length;
    if (await hasSectorColumn(i.db)) {
      stmts.push({
        sql:
          "UPDATE instrument SET sector = industry " +
          "WHERE market = ? AND delisted_on IS NULL AND sector IS NOT industry",
        args: [UNIVERSE_MARKET],
      });
    }

    const startedAt = i.now();
    const id = await startRun(i.db, {
      job: UNIVERSE_JOB,
      market: UNIVERSE_MARKET,
      concurrencyKey: key,
      scheduledFor: i.today,
      commitSha: i.commit,
      now: startedAt,
    });
    const endedAt = i.now();
    stmts.push({
      sql:
        "UPDATE run_record SET status = 'success', ended_at = ?, duration_ms = ?, " +
        "items_processed = ?, rows_read = ?, rows_written = ?, details_json = ? WHERE id = ?",
      args: [
        endedAt,
        Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        plan.counts.file,
        existing.length,
        rowsWritten,
        JSON.stringify({
          counts: plan.counts,
          quarantined: plan.quarantined.length,
          parsed: parsed.stats,
          source: i.source ?? "worker",
        }),
        id,
      ],
    });
    try {
      await i.db.batch(stmts, "write");
    } catch (e) {
      // A lost race (unique success key) or a database fault: nothing was written. Best effort.
      try {
        await finishRun(i.db, id, { status: "failed", errorSummary: "db_error", now: i.now() });
      } catch {
        // the run stays `running`; the next import for the date is unaffected
      }
      throw e;
    }
    if (plan.quarantined.length > 0) {
      // Short facts only (codes and a reason word, never file text beyond the code and the two names).
      try {
        await openS2Once(
          i.db,
          CODE_REUSE_INCIDENT,
          {
            rule: "code_reuse_suspected",
            codes: plan.quarantined.slice(0, 10).map((q) => ({ code: q.code, why: q.why })),
            count: plan.quarantined.length,
          },
          i.now(),
          i.env ? { env: i.env } : undefined,
          "A delisted code is listed again and looks like a different company; it stays out of the universe",
        );
      } catch {
        // the quarantine itself is already stored; the incident is best effort
      }
    }
    return { ok: true, status: "applied", counts: plan.counts, parsed: parsed.stats };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
