// The ONE development accessor of the expert code (D-516, ARN-082). Built like the challengers stage's
// DevelopmentView (src/lib/learning/weeklyStages.ts): replay the family with the cluster's fitted parameters,
// keep only rows whose entry date lies in the development split, hand back a development sample. Validation
// and holdout rows never leave this file; nothing here reads or writes trial_ledger or any table.
import type { Family } from "@/lib/agents/schema";
import type { LedgerEntry, LedgerResult } from "@/lib/replay/ledger";
import { replayOf, type WeeklyContext } from "@/lib/learning/weeklyStages";
import { splitOf, type LineageSplitRecord } from "@/lib/stats/splits";

/** One closed development row: float net return and (when a matched C2 control exists) excess over controls. */
export type DevRow = {
  readonly entryD: string;
  /** Entry-session index inside the development window (bootstrap layout). */
  readonly session: number;
  readonly net: number;
  readonly excess: number | null;
};

export type DevelopmentSample = {
  readonly split: "development";
  readonly rows: readonly DevRow[];
  /** Populated blocks of `blockSessions` development sessions. */
  readonly blocks: number;
  /** Sessions of the development window. */
  readonly sessionCount: number;
  readonly blockSessions: number;
};

export type ExpertDevView = {
  readonly family: Family;
  readonly splitVersion: number;
  evaluate(params: Readonly<Record<string, unknown>>, label: string): DevelopmentSample;
};

/** Replays one family at one parameter set under a version label (default: the weekly run's memoised replay). */
export type ReplayFn = (
  family: Family,
  versionLabel: string,
  params: Readonly<Record<string, unknown>>,
) => LedgerResult;

const num = (r: { readonly num: bigint; readonly den: bigint }): number =>
  Number(r.num) / Number(r.den); // money-float-ok: bootstrap inputs are float64 (as weeklyStages.ratNumber)

export function makeExpertDevView(
  c: Pick<WeeklyContext, "world"> & Partial<WeeklyContext>,
  family: Family,
  split: LineageSplitRecord,
  deps: { readonly replay?: ReplayFn } = {},
): ExpertDevView {
  const replay: ReplayFn =
    deps.replay ?? ((f, label, p) => replayOf(c as WeeklyContext, f, label, p));
  const devSessions = c.world.sessions.filter((d) => splitOf(split, d) === "development");
  const index = new Map(devSessions.map((d, i) => [d, i]));
  const keep = (e: LedgerEntry): boolean =>
    e.family === family &&
    e.variant === family &&
    e.net !== null &&
    splitOf(split, e.row.entry_d) === "development" &&
    index.has(e.row.entry_d);
  return {
    family,
    splitVersion: split.version,
    evaluate(params, label) {
      const res = replay(family, label, params);
      const rows: DevRow[] = [];
      for (const e of res.entries) {
        if (!keep(e)) continue;
        rows.push({
          entryD: e.row.entry_d,
          session: index.get(e.row.entry_d)!,
          net: num(e.net!),
          excess: e.excess === null ? null : num(e.excess),
        });
      }
      const blocks = new Set(rows.map((r) => Math.floor(r.session / split.block_sessions)));
      return {
        split: "development",
        rows,
        blocks: blocks.size,
        sessionCount: devSessions.length,
        blockSessions: split.block_sessions,
      };
    },
  };
}
