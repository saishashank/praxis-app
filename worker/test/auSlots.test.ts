// M19 integration step 0 (D-1007, CXA-001, A-20, MKT-110 a): the Worker's AU slot table is snapshotted
// BEFORE the clock is made per-market (C1). Every slot (id, local time, minute, recurrence, runner, route,
// workflow, flags, priority, catch-up, recheck prefix and windows, fixed inputs, annual and monthly rules)
// is recorded in worker/test/fixtures/au-slots.snapshot.json and must be reproduced to the byte by the
// table `slotsFor(auRow)` builds later. "Any difference is a defect, not a tuning."
// Record (pre-refactor tree only): RECORD_AU_SLOTS=1 npx vitest run test/auSlots.test.ts (from worker/).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AU_SLOTS, DEFAULT_CATCH_UP_MIN, DISPATCHABLE_WORKFLOWS } from "../src/schedule";

const SNAPSHOT_PATH = join(__dirname, "fixtures", "au-slots.snapshot.json");
const RECORD = process.env.RECORD_AU_SLOTS === "1";

/** The slot table as plain data, in table order (the order is part of the contract). */
const current = () => ({
  catchUpMin: DEFAULT_CATCH_UP_MIN,
  dispatchable: [...DISPATCHABLE_WORKFLOWS],
  slots: AU_SLOTS.map((s) => JSON.parse(JSON.stringify(s))),
});

describe("AU slot snapshot (D-1007)", () => {
  it("records the snapshot when asked (pre-refactor tree only)", () => {
    if (!RECORD) return;
    const out = {
      note: "M19 step 0 (D-1007): the Worker AU slot table recorded on the pre-refactor build tree (fdc9e00); never rewritten in M19.",
      recordedOnCommit: "fdc9e00",
      ...current(),
    };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(out, null, 2) + "\n");
  });

  it("the AU slot table equals the snapshot: id, minute, prefix, recurrence, flags, windows", () => {
    if (RECORD) return;
    const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ReturnType<typeof current>;
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
