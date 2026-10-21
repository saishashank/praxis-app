// Batch 1 stage 6 ("macro_and_other"), M4 T3: the agents' extra inputs. Index bars (S&P/ASX 200,
// decision 12) for the date being processed, and, once per run on the live target date, the ASIC
// short positions fetched by the no-secrets step (decision 13). Both are first-seen inserts, so a
// re-run writes nothing. A problem here is recorded in the stage summary and never fails the bars
// (the bars are the primary product of the date). Counts and statuses only, no rows.
import { INDEX_CODE, INDEX_MARKET, writeIndexBars } from "./indexBars.mjs";
import { shortModeAllowsFetch, shortSourceMode, writeShortInterest } from "../shortInterest.mjs";

/**
 * @param {{ db: import("@libsql/client").Client, market: string, d: string, io: {read:number, written:number},
 *   now: string, isTarget: boolean, universe: string[],
 *   inputs?: { index: any, short: any } }} ctx
 */
export async function inputsStage(ctx) {
  const { db, d, io } = ctx;
  const inputs = ctx.inputs;
  /** @type {Record<string, unknown>} */
  const out = {};

  // (a) index bars. The Yahoo source gate was applied by the plan (a source that is off or not
  // accepted skips the whole run and its record says so), so reaching here means it is on.
  try {
    const ix = inputs?.index;
    if (!ix || ix.status === "no_file") out.index = "no_file";
    else if (ix.status === "invalid") out.index = "file_invalid";
    else {
      const todays = ix.rows.filter((r) => r.index_code === INDEX_CODE && r.d === d);
      if (todays.length === 0) out.index = "no_row_for_date";
      else {
        const n = await writeIndexBars(db, {
          market: INDEX_MARKET,
          rows: todays,
          ingestedAt: ctx.now,
        });
        io.written += n;
        out.index = { rows: todays.length, inserted: n, already_stored: todays.length - n };
      }
    }
  } catch {
    out.index = "write_failed";
  }

  // (b) ASIC short positions: the file covers several as_of dates, so it is written once, on the
  // live target date.
  try {
    const sh = inputs?.short;
    if (!ctx.isTarget) out.short_interest = "not_target_date";
    else if (!sh || sh.status === "no_file") out.short_interest = "no_file";
    else {
      const mode = await shortSourceMode(db);
      io.read += 1;
      if (!shortModeAllowsFetch(mode)) out.short_interest = "source_off";
      else if (sh.status === "invalid") out.short_interest = "file_invalid";
      else {
        const set = new Set(ctx.universe);
        const rows = sh.rows.filter((r) => set.has(r.code));
        const n = await writeShortInterest(db, { rows, ingestedAt: ctx.now });
        io.written += n;
        out.short_interest = {
          rows: rows.length,
          inserted: n,
          already_stored: rows.length - n,
          not_in_universe: sh.rows.length - rows.length,
          rejected: sh.rejected,
          assumed_time: true,
          ...(sh.stopped ? { stopped: sh.stopped } : {}),
        };
      }
    }
  } catch {
    out.short_interest = "write_failed";
  }
  return out;
}
