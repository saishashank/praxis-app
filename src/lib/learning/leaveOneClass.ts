// ARN-076 in the weekly learning run (M6 T12; D-110 #24): the marginal contribution of an evidence class,
// by re-running the family with one class disabled. F6: classes (a)-(d) through `f6DisabledClasses` (the
// M4 `leaveOneClassOut`, block bootstrap interval); F4: with and without the "no negative event" filter
// (`f4EventFilterOff`); every other family has one evidence class and reads "n/a - one evidence class".
// Descriptive only: nothing here changes a rule, a lesson or a promotion. Pure over the loaded world;
// deterministic (seeded scopes); development and validation are not separated here because nothing is
// tested, only described.
import type { AgentParams } from "@/lib/agents/params";
import { FAMILIES } from "@/lib/agents/schema";
import { replayLedger, type LedgerResult, type LedgerSource } from "@/lib/replay/ledger";
import {
  leaveOneClassOut,
  type ClassContribution,
  type LeaveOneOut,
} from "@/lib/replay/scorecards";

export const SINGLE_CLASS_TEXT = "n/a — one evidence class";

export type EventFilterContribution = {
  readonly withFilter: LeaveOneOut;
  readonly withoutFilter: LeaveOneOut;
  /** Mean paired excess with the filter minus without it; null when either side has no excess. */
  readonly contribution: number | null;
};

export type LeaveOneClassReport = {
  readonly f6: { readonly all: LeaveOneOut; readonly classes: readonly ClassContribution[] };
  readonly f4: EventFilterContribution;
  readonly notApplicable: readonly { readonly family: string; readonly text: string }[];
};

const num = (r: { readonly num: bigint; readonly den: bigint }): number =>
  Number(r.num) / Number(r.den); // money-float-ok: descriptive mean

function summary(result: LedgerResult, disabled: string | null): LeaveOneOut {
  const rows = result.entries.filter((e) => e.family === "F4" && e.net !== null);
  const ex = rows.filter((e) => e.excess !== null).map((e) => num(e.excess!));
  const nets = rows.map((e) => num(e.net!));
  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  return { disabled, rows: rows.length, meanExcess: mean(ex), meanNet: mean(nets) };
}

/** F6 per class and F4 with/without the event filter, over the whole loaded world. */
export function weeklyLeaveOneClass(
  world: LedgerSource,
  sessions: readonly string[],
  params: AgentParams,
  market: string,
): LeaveOneClassReport {
  const f6 = leaveOneClassOut(
    (off) =>
      replayLedger(world, {
        params,
        familyOptions: { families: ["F6"], f6DisabledClasses: off === null ? [] : [off] },
      }),
    sessions,
    params,
    `${market}:F6`,
  );
  const run = (off: boolean): LedgerResult =>
    replayLedger(world, {
      params,
      familyOptions: { families: ["F4"], f4EventFilterOff: off },
    });
  const withFilter = summary(run(false), null);
  const withoutFilter = summary(run(true), "event_filter");
  return {
    f6,
    f4: {
      withFilter,
      withoutFilter,
      contribution:
        withFilter.meanExcess !== null && withoutFilter.meanExcess !== null
          ? withFilter.meanExcess - withoutFilter.meanExcess
          : null,
    },
    notApplicable: FAMILIES.filter((f) => f !== "F4" && f !== "F6").map((family) => ({
      family,
      text: SINGLE_CLASS_TEXT,
    })),
  };
}
