// @vitest-environment node
// Lineage splits, deferral dates, trial ledger and budget (M4 T13; ARN-082, ARN-085; decisions 23, 26).
import { describe, expect, it } from "vitest";
import {
  addWeekdays,
  appendTrial,
  createLineage,
  createLineageSplit,
  holdoutUsed,
  layoutWindows,
  lineageId,
  maxHoldingUpperBound,
  measureBlock,
  purgeSessions,
  rolledBudgetAtRoll,
  sessionsNeeded,
  sharedValidationSessions,
  splitOf,
  trialBudget,
  trialCounts,
  trialLedgerRow,
  type SplitCreateInput,
} from "../../src/lib/stats/splits";
import { LINEAGE, PARAMS, weekdayCalendar } from "../fixtures/stats/t13";

const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;

function rowsWithHold(calendar: readonly string[], hold: number, count: number, step: number) {
  const out: { entryD: string; exitD: string | null }[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = i * step;
    if (a + hold >= calendar.length) break;
    out.push({ entryD: calendar[a]!, exitD: calendar[a + hold]! });
  }
  return out;
}

function input(calendar: readonly string[], hold = 3, extra: Partial<SplitCreateInput> = {}) {
  return {
    market: "ASX",
    family: "F1",
    calendar,
    maxHoldingUpper: maxHoldingUpperBound("F1"),
    primaryRows: rowsWithHold(calendar, hold, 200, 3),
    params: PARAMS,
    ...extra,
  } satisfies SplitCreateInput;
}

describe("lineage and purge", () => {
  it("lineage = <market>:<family> and the record is insert-only data", () => {
    expect(lineageId("ASX", "F4")).toBe("ASX:F4");
    expect(createLineage("ASX", "F4", "2026-10-19")).toEqual({
      id: "ASX:F4",
      created_d: "2026-10-19",
      parent: null,
    });
  });

  it("purge = upper bound of the max-holding parameter + 20 (F1 140 ... F6 60)", () => {
    const purge = FAMILIES.map((f) => purgeSessions(maxHoldingUpperBound(f), PARAMS));
    expect(purge).toEqual([140, 110, 60, 40, 65, 60]);
  });
});

describe("split creation", () => {
  const calendar = weekdayCalendar(2000);

  it("default layout 378/504 with purge 140 when the measured block is small", () => {
    const s = createLineageSplit(input(calendar, 3));
    expect(s.block_sessions).toBe(5); // p75 hold 3 -> floor of 5
    expect(s.holdout_len).toBe(378);
    expect(s.validation_len).toBe(504);
    expect(s.purge).toBe(140);
    expect(s.deferred_until_d).toBeNull();
    const lay = layoutWindows(2000, 378, 504, 140, 140);
    expect(lay.holdoutEnd).toBe(1859);
    expect(s.holdout_end_d).toBe(calendar[1859]);
    expect(s.holdout_start_d).toBe(calendar[1482]);
    expect(s.validation_end_d).toBe(calendar[1341]);
    expect(s.validation_start_d).toBe(calendar[838]);
    expect(s.dev_end_d).toBe(calendar[697]);
    expect(s.data_end_d).toBe(calendar[1999]);
    expect(s.version).toBe(1);
    expect(s.reason).toBe("create");
  });

  it("holdout ends one completion window (= purge) before the data end", () => {
    const s = createLineageSplit(input(calendar));
    const endIdx = calendar.indexOf(s.holdout_end_d!);
    expect(1999 - endIdx).toBe(s.purge);
  });

  it("block = max(5, p75 of realised holds) and lengths = max(378/504, 15 x block)", () => {
    const s = createLineageSplit(input(calendar, 40));
    expect(s.block_sessions).toBe(40);
    expect(s.holdout_len).toBe(600);
    expect(s.validation_len).toBe(600);
    // 15 x 30 = 450: holdout lifted above 378, validation stays at 504.
    const t = createLineageSplit(input(calendar, 30));
    expect(t.holdout_len).toBe(450);
    expect(t.validation_len).toBe(504);
  });

  it("block is measured only on rows entering before (default validation start - purge)", () => {
    const early = rowsWithHold(calendar, 10, 100, 3); // entries 0..297, hold 10
    const late = [{ entryD: calendar[1900]!, exitD: calendar[1990]! }]; // hold 90, after the cutoff
    const b = measureBlock(input(calendar, 3, { primaryRows: [...early, ...late] }));
    expect(b).toBe(10);
  });

  it("open rows and unknown dates are ignored when measuring", () => {
    const b = measureBlock(
      input(calendar, 3, {
        primaryRows: [
          { entryD: calendar[10]!, exitD: null },
          { entryD: "1999-01-01", exitD: calendar[20]! },
        ],
      }),
    );
    expect(b).toBe(PARAMS.bootstrapBlockMinSessions);
  });

  it("is deterministic", () => {
    const a = JSON.stringify(createLineageSplit(input(calendar, 12)));
    const b = JSON.stringify(createLineageSplit(input(calendar, 12)));
    expect(a).toBe(b);
  });
});

describe("deferral (development < 252 sessions)", () => {
  it("exactly 252 development sessions is not deferred; one fewer defers", () => {
    const need = sessionsNeeded(252, 378, 504, 140, 140);
    expect(need).toBe(1554);
    const ok = createLineageSplit(input(weekdayCalendar(need)));
    expect(ok.deferred_until_d).toBeNull();
    expect(ok.dev_end_d).toBe(weekdayCalendar(need)[251]);
    const short = createLineageSplit(input(weekdayCalendar(need - 1)));
    expect(short.deferred_until_d).not.toBeNull();
  });

  it("a deferred split has no window dates and a deferral date after the data end", () => {
    const cal = weekdayCalendar(800);
    const s = createLineageSplit(input(cal));
    expect(s.holdout_start_d).toBeNull();
    expect(s.holdout_end_d).toBeNull();
    expect(s.validation_start_d).toBeNull();
    expect(s.validation_end_d).toBeNull();
    expect(s.dev_end_d).toBeNull();
    expect(s.deferred_until_d).toBe(addWeekdays(cal[799]!, 1554 - 800));
    expect(s.deferred_until_d! > s.data_end_d).toBe(true);
    expect(splitOf(s, cal[10]!)).toBeNull();
  });

  it("the deferral date moves with a longer measured block", () => {
    const cal = weekdayCalendar(1500);
    const a = createLineageSplit(input(cal, 3));
    const b = createLineageSplit(input(cal, 40));
    expect(b.deferred_until_d! > a.deferred_until_d!).toBe(true);
  });

  it("addWeekdays skips weekends", () => {
    expect(addWeekdays("2026-10-16", 1)).toBe("2026-10-19"); // Friday -> Monday
    expect(addWeekdays("2026-10-19", 5)).toBe("2026-10-26");
    expect(addWeekdays("2026-10-19", 0)).toBe("2026-10-19");
  });
});

describe("splitOf (by entry date, with purge gaps)", () => {
  const calendar = weekdayCalendar(2000);
  const s = createLineageSplit(input(calendar));
  it("classifies development, purge, validation, holdout and completion", () => {
    expect(splitOf(s, calendar[0]!)).toBe("development");
    expect(splitOf(s, calendar[697]!)).toBe("development");
    expect(splitOf(s, calendar[698]!)).toBe("purge");
    expect(splitOf(s, calendar[837]!)).toBe("purge");
    expect(splitOf(s, calendar[838]!)).toBe("validation");
    expect(splitOf(s, calendar[1341]!)).toBe("validation");
    expect(splitOf(s, calendar[1342]!)).toBe("purge");
    expect(splitOf(s, calendar[1481]!)).toBe("purge");
    expect(splitOf(s, calendar[1482]!)).toBe("holdout");
    expect(splitOf(s, calendar[1859]!)).toBe("holdout");
    expect(splitOf(s, calendar[1860]!)).toBe("completion");
    expect(splitOf(s, calendar[1999]!)).toBe("completion");
  });
  it("the purge between splits is the lineage purge", () => {
    const dev = calendar.indexOf(s.dev_end_d!);
    const val = calendar.indexOf(s.validation_start_d!);
    expect(val - dev - 1).toBe(s.purge);
  });
});

describe("trial ledger", () => {
  const calendar = weekdayCalendar(2000);
  const split = createLineageSplit(input(calendar));
  const row = (kind: Parameters<typeof trialLedgerRow>[0]["kind"], run: string, rv = "1") =>
    trialLedgerRow({
      market: "ASX",
      lineage_id: LINEAGE,
      split_version: 1,
      kind,
      rule_version: rv,
      variant: "primary",
      run_id: run,
      d: "2026-10-19",
    });

  it("ids are deterministic and an append is idempotent", () => {
    const a = row("validation_access", "r1");
    expect(a.id).toBe(row("validation_access", "r1").id);
    let ledger = appendTrial([], a);
    ledger = appendTrial(ledger, a);
    expect(ledger).toHaveLength(1);
    ledger = appendTrial(ledger, row("validation_access", "r2"));
    expect(ledger).toHaveLength(2);
  });

  it("counts every kind toward the cumulative budget of the frozen split", () => {
    let ledger = appendTrial([], row("validation_access", "r1"));
    ledger = appendTrial(ledger, row("holdout_access", "r2"));
    ledger = appendTrial(ledger, row("pattern_test", "r3"));
    ledger = appendTrial(ledger, row("challenger", "r4"));
    ledger = appendTrial(ledger, row("new_lineage", "r5"));
    const c = trialCounts(ledger, LINEAGE, 1);
    expect(c.total).toBe(5);
    expect(c.validationAccesses).toBe(1);
    expect(c.holdoutAccesses).toBe(1);
    expect(trialCounts(ledger, LINEAGE, 2).total).toBe(0);
    expect(trialCounts(ledger, "ASX:F2", 1).total).toBe(0);
  });

  it("budget = m - trials used; exhausted at zero and never negative", () => {
    let ledger: ReturnType<typeof appendTrial> = [];
    for (let i = 0; i < PARAMS.trialBudgetPerLineage - 1; i += 1) {
      ledger = appendTrial(ledger, row("validation_access", `r${i}`));
    }
    const b = trialBudget(ledger, LINEAGE, 1, PARAMS.trialBudgetPerLineage);
    expect(b).toEqual({ total: 20, used: 19, remaining: 1, exhausted: false });
    ledger = appendTrial(ledger, row("validation_access", "last"));
    expect(trialBudget(ledger, LINEAGE, 1, 20).exhausted).toBe(true);
    ledger = appendTrial(ledger, row("validation_access", "over"));
    expect(trialBudget(ledger, LINEAGE, 1, 20).remaining).toBe(0);
  });

  it("the holdout is used once per rule version", () => {
    const ledger = appendTrial([], row("holdout_access", "r1", "1"));
    expect(holdoutUsed(ledger, LINEAGE, 1, "1")).toBe(true);
    expect(holdoutUsed(ledger, LINEAGE, 1, "2")).toBe(false);
    expect(holdoutUsed(ledger, LINEAGE, 2, "1")).toBe(false);
  });

  it("roll: new budget = m - ceil(old accesses x overlap) (decision 26)", () => {
    // New data 126 sessions later: validation windows shift by 126, so 378 of 504 sessions are shared.
    const longer = weekdayCalendar(2000 + 126);
    const oldSplit = createLineageSplit(input(longer.slice(0, 2000)));
    const newSplit = createLineageSplit(input(longer, 3, { version: 2, reason: "roll" }));
    expect(sharedValidationSessions(oldSplit, newSplit, longer)).toBe(378);
    let ledger: ReturnType<typeof appendTrial> = [];
    for (let i = 0; i < 8; i += 1) ledger = appendTrial(ledger, row("validation_access", `v${i}`));
    for (let i = 0; i < 2; i += 1) ledger = appendTrial(ledger, row("holdout_access", `h${i}`));
    ledger = appendTrial(ledger, row("pattern_test", "p")); // not an "access": excluded from the carry
    // 10 accesses x 378/504 = 7.5 -> 8; 20 - 8 = 12.
    expect(rolledBudgetAtRoll(ledger, oldSplit, newSplit, longer, 20)).toBe(12);
    expect(newSplit.version).toBe(2);
    expect(newSplit.reason).toBe("roll");
  });

  it("a roll with no overlap restores the full budget", () => {
    const long = weekdayCalendar(2000 + 1100);
    const oldSplit = createLineageSplit(input(long.slice(0, 2000)));
    const newSplit = createLineageSplit(input(long, 3, { version: 2, reason: "roll" }));
    expect(sharedValidationSessions(oldSplit, newSplit, long)).toBe(0);
    const ledger = appendTrial([], row("validation_access", "v0"));
    expect(rolledBudgetAtRoll(ledger, oldSplit, newSplit, long, 20)).toBe(20);
  });

  it("unused: split fixture is well formed", () => {
    expect(split.lineage_id).toBe(LINEAGE);
  });
});
