// OPS-110 / D-941: why a night published no picks, in plain words (never a silent zero).
// A pick needs, besides the signal itself, the three cases from enough similar past trades, a
// stop-loss below the price, a holding time and an aim above the price (generate.ts `eligible`).
// This module counts, per candidate, the first of those that is missing; the nightly stores the
// counts and the sentence with the night's run record, and Home and the Evening Review show it.
import type { Client } from "@libsql/client";
import { recordSuccessOnce } from "@/lib/runs/runRecord";
import type { PickInput } from "./types";

export type BlockReason = "no_history" | "no_stop" | "no_hold" | "no_aim" | "profile_rules";
export type BlockCounts = Readonly<Partial<Record<BlockReason, number>>>;

/** The first thing that stops a candidate from becoming a pick, or null when none of the basics does. */
export function firstBlock(inp: PickInput): BlockReason | null {
  if (inp.scenario === null) return "no_history";
  if (inp.stopMicro === null || inp.stopMicro <= 0n || inp.stopMicro >= inp.referenceMicro) {
    return "no_stop";
  }
  if (inp.holdMedianSessions === null || inp.holdMedianSessions < 1) return "no_hold";
  if (inp.scenario.goodPpm <= 0) return "no_aim";
  return null;
}

/** Counts of the first blocking reason over the night's candidates; "profile_rules" = passed the basics. */
export function countBlocks(inputs: readonly PickInput[]): BlockCounts {
  const out: Partial<Record<BlockReason, number>> = {};
  for (const inp of inputs) {
    const r = firstBlock(inp) ?? "profile_rules";
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The plain-words line for a night with no picks. `signals` = strategy candidates, `shortlist` =
 * shortlist candidates (-1 = the shortlist could not be read). Never names a stock or a run time.
 */
export function noPicksSentence(o: {
  signals: number;
  shortlist: number;
  blocked: BlockCounts;
}): string {
  const b = o.blocked;
  const lead = "No picks tonight:";
  const parts: string[] = [];
  if (o.signals === 0) {
    parts.push("no strategy gave a buy signal");
  } else {
    const n = o.signals;
    const why: string[] = [];
    if ((b.no_history ?? 0) > 0)
      why.push("not enough similar past trades yet to show what it could gain or lose");
    if ((b.no_stop ?? 0) > 0) why.push("no safe stop-loss level");
    if ((b.no_hold ?? 0) > 0 || (b.no_aim ?? 0) > 0) why.push("no usable holding time or aim");
    if ((b.profile_rules ?? 0) > 0) why.push("it did not fit any profile's rules");
    parts.push(
      `${n} strategy ${plural(n, "signal", "signals")} fired, but ${why.join("; ") || "none could be turned into a pick"}`,
    );
  }
  if (o.shortlist === 0) parts.push("and no stock passed the shortlist's trend rule");
  else if (o.shortlist < 0) parts.push("and the shortlist could not be read");
  else parts.push("and none of the shortlist stocks fit any profile's rules");
  return `${lead} ${parts.join(", ")}.`;
}

export const PICKS_JOB = "arena-picks";
export const picksRunKey = (market: string, d: string): string => `${PICKS_JOB}:${market}:${d}`;

type Exec = {
  execute: (q: { sql: string; args: (string | number)[] }) => Promise<{ rows: unknown[] }>;
};

/** Store the night's picks outcome with its reason (one row per night; a re-run keeps the first). */
export async function recordPicksNight(
  db: Pick<Client, "execute">,
  o: {
    market: string;
    d: string;
    now: string;
    published: number;
    candidates: number;
    shortlist: number;
    blocked: BlockCounts;
    line: string | null;
  },
): Promise<void> {
  // The write goes through the shared run-record module: picks only write their own tables.
  await recordSuccessOnce(db, {
    job: PICKS_JOB,
    market: o.market,
    concurrencyKey: picksRunKey(o.market, o.d),
    scheduledFor: o.d,
    now: o.now,
    itemsProcessed: o.published,
    details: {
      published: o.published,
      candidates: o.candidates,
      shortlist: o.shortlist,
      blocked: o.blocked,
      line: o.line,
    },
  });
}

/** The stored "No picks tonight: …" line for night d, or for the latest night when d is null. */
export async function readNoPicksLine(
  db: Exec,
  market: string,
  d: string | null,
): Promise<string | null> {
  const r =
    d === null
      ? await db.execute({
          sql: `SELECT details_json FROM run_record WHERE job = ? AND market = ?
                ORDER BY scheduled_for DESC, id DESC LIMIT 1`,
          args: [PICKS_JOB, market],
        })
      : await db.execute({
          sql: "SELECT details_json FROM run_record WHERE concurrency_key = ? ORDER BY id DESC LIMIT 1",
          args: [picksRunKey(market, d)],
        });
  const row = r.rows[0] as { details_json?: unknown } | undefined;
  if (row === undefined || typeof row.details_json !== "string") return null;
  try {
    const v = JSON.parse(row.details_json) as { line?: unknown };
    return typeof v.line === "string" && v.line !== "" ? v.line : null;
  } catch {
    return null;
  }
}
