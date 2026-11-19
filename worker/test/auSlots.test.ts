// M19 integration step 0 (D-1007, CXA-001, A-20, MKT-110 a): the Worker's AU slot table is snapshotted
// BEFORE the clock is made per-market (C1). Every slot (id, local time, minute, recurrence, runner, route,
// workflow, flags, priority, catch-up, recheck prefix and windows, fixed inputs, annual and monthly rules)
// is recorded in worker/test/fixtures/au-slots.snapshot.json and must be reproduced to the byte by the
// table `slotsFor(auRow)` builds later. "Any difference is a defect, not a tuning." The snapshot was
// written once from the pre-refactor table (JSON.stringify of `current()` below, commit fdc9e00) and is
// never rewritten in M19.
import { describe, expect, it } from "vitest";
import snapshotText from "./fixtures/au-slots.snapshot.json?raw";
import { DEFAULT_CATCH_UP_MIN, DISPATCHABLE_WORKFLOWS, slotsFor } from "../src/schedule";
import { AU_ROW } from "./auRow";

type Snapshot = ReturnType<typeof current>;

/** The slot table as plain data, in table order (the order is part of the contract). */
const current = () => ({
  catchUpMin: DEFAULT_CATCH_UP_MIN,
  dispatchable: [...DISPATCHABLE_WORKFLOWS],
  slots: slotsFor(AU_ROW).map((s) => JSON.parse(JSON.stringify(s)) as Record<string, any>),
});

describe("AU slot snapshot (D-1007)", () => {
  it("the AU slot table equals the snapshot: id, minute, prefix, recurrence, flags, windows", () => {
    const snap = JSON.parse(snapshotText) as Snapshot;
    const now = current();
    expect(now.slots.length).toBe(snap.slots.length);
    expect(now.slots.map((s) => [s.id, s.time, s.minute])).toEqual(
      snap.slots.map((s) => [s.id, s.time, s.minute]),
    );
    expect(now.slots).toEqual(snap.slots);
    expect(now.catchUpMin).toBe(snap.catchUpMin);
    expect(now.dispatchable).toEqual(snap.dispatchable);
    // the recheck prefix of the 2a slot is part of the contract (run-record keys must not move)
    expect(snap.slots.some((s) => s.recheck?.keyPrefix === "arena-2a:AU:")).toBe(true);
  });
});
