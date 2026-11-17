// M23 night step "lookSync" (docs/M23_design.md, D-1607): imports the looks recorded in the committed offline ledger
// (docs/research/registry.json) for the enabled market, through the registry gate (`preregister`, then `takeLook` with a
// computation that returns the recorded result). Rows come from the committed file only. A new entry is imported once; an entry
// already in the database is compared and never looked at again; a mismatch, an unreadable frozen file or a database look of an
// offline test that the ledger does not hold raises one plain Owner line. It runs per enabled market, writes only research_prereg,
// holdout_look, research_result, holdout_look_refusal and app_log (all through the registry gate and one log line), and never
// throws past `runResearchNight`, which logs a failure and goes on.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { ResearchNightOptions, ResearchStep } from "../night";
import { LEDGER_PATH, frozenTextFor, hasLook, parseLedger, type LedgerEntry } from "../ledgerFile";
import { lineageName, offlineLineages } from "../names";
import { preregister, sha256Hex, takeLook } from "../registry";
import { displayVerdict } from "../verdict";

/** Where committed files are read from (a test passes its own). */
export type LedgerIo = { read(relPath: string): string | null };

const LOG_MAX = 500; // threshold-ok: an app_log line is cut at 500 characters
const LOOK_READ_LIMIT = 500; // threshold-ok: the looks of one market, a bounded read of a primary-key prefix

/** The committed files of the repo the night runs from; anything outside the repo's docs folder is not read. */
export const diskIo: LedgerIo = {
  read(relPath) {
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) return null;
    try {
      return readFileSync(path.join(process.cwd(), relPath), "utf8");
    } catch {
      return null;
    }
  },
};

async function ownerLine(db: Client, now: string, message: string): Promise<void> {
  // rows-ok: one Owner-visible warning line per problem found
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
    args: [now, "research", message.slice(0, LOG_MAX)],
  });
}

export type SyncResult = {
  readonly imported: number;
  readonly present: number;
  readonly problems: number;
};

/** Imports the ledger entries of one market. Never reads anything but the committed ledger and the files it names. */
export async function syncLedger(
  db: Client,
  o: { market: string; now: string },
  io: LedgerIo = diskIo,
): Promise<SyncResult> {
  const text = io.read(LEDGER_PATH);
  if (text === null) return { imported: 0, present: 0, problems: 0 };
  let problems = 0;
  let entries: readonly LedgerEntry[];
  try {
    entries = parseLedger(text).entries;
  } catch {
    await ownerLine(
      db,
      o.now,
      "The record of tests run elsewhere could not be read and was not imported.",
    );
    return { imported: 0, present: 0, problems: 1 };
  }
  // rows-ok: holdout_look primary key prefix (lineage, market), one market's looks, LIMIT 500
  const have = await db.execute({
    sql: `SELECT lineage, prereg_sha, verdict FROM holdout_look WHERE market = ? ORDER BY lineage LIMIT ?`,
    args: [o.market, LOOK_READ_LIMIT],
  });
  const inDb = new Map(
    have.rows.map((r) => [
      String(r.lineage),
      { sha: String(r.prereg_sha), verdict: displayVerdict(String(r.verdict)) },
    ]),
  );
  let imported = 0;
  let present = 0;
  const inLedger = new Set<string>();
  for (const e of entries) {
    if (e.market !== o.market) continue;
    if (hasLook(e)) inLedger.add(e.lineage);
    const name = lineageName(e.lineage);
    let frozen: string | null;
    try {
      frozen = frozenTextFor(e.preregPath, (p) => io.read(p));
    } catch {
      frozen = null;
    }
    if (frozen === null || sha256Hex(frozen) !== e.sha) {
      problems += 1;
      await ownerLine(
        db,
        o.now,
        `A recorded test (${name}) does not match its frozen plan and was not imported.`,
      );
      continue;
    }
    const plan = await preregister(db, {
      lineage: e.lineage,
      market: e.market,
      item: e.item,
      frozen,
      now: e.lookedAt ?? o.now,
    });
    if (plan.status === "refused") {
      problems += 1;
      continue;
    }
    if (!hasLook(e)) continue;
    const there = inDb.get(e.lineage);
    if (there !== undefined) {
      present += 1;
      if (there.sha !== e.sha || there.verdict !== e.verdict) {
        problems += 1;
        await ownerLine(
          db,
          o.now,
          `A recorded test (${name}) differs between the record and the database; neither was changed.`,
        );
      }
      continue;
    }
    const r = await takeLook(db, {
      lineage: e.lineage,
      market: e.market,
      sha: plan.sha,
      caller: "ledger",
      now: e.lookedAt!,
      compute: () => ({
        verdict: e.verdict!,
        nSetups: e.nSetups!,
        nBlocks: e.nBlocks!,
        stats: e.stats ?? {},
      }),
    });
    if (r.status === "looked") imported += 1;
  }
  for (const lineage of offlineLineages()) {
    if (inDb.has(lineage) && !inLedger.has(lineage)) {
      problems += 1;
      await ownerLine(
        db,
        o.now,
        `A look at a test run elsewhere (${lineageName(lineage)}) is in the database but not in the committed record.`,
      );
    }
  }
  return { imported, present, problems };
}

export const lookSyncStep: ResearchStep = {
  name: "lookSync",
  plain: "importing the recorded results of tests run elsewhere",
  async run(db: Client, o: ResearchNightOptions) {
    await syncLedger(db, { market: o.market, now: o.now });
  },
};
