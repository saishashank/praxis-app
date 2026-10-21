// M8 T12: the Owner-only "Day timeline check" card on System Health (PLT-073, decision 45).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepRow } from "@/lib/runs/deadlines";

const checkDay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/runs/deadlines", async (orig) => ({
  ...(await orig<typeof import("@/lib/runs/deadlines")>()),
  checkDay,
}));

import { DayTimelineCheck, DayTimelineView } from "@/app/(app)/health/DayTimelineCheck";

afterEach(() => {
  cleanup();
  checkDay.mockReset();
});

const row = (over: Partial<StepRow>): StepRow => ({
  id: "batch1",
  label: "Batch 1 (prices, actions, universe)",
  start: "17:30",
  deadline: "18:10",
  startedAt: "17:31",
  finishedAt: "17:55",
  status: "on_time",
  reason: "finished 17:55",
  ...over,
});

describe("DayTimelineView", () => {
  it("shows one row per step with the result and the note", () => {
    render(
      <DayTimelineView
        date="2026-10-05"
        rows={[
          row({}),
          row({ id: "batch2", label: "Batch 2", status: "late", reason: "finished 18:41" }),
          row({ id: "email", label: "Evening Review email", status: "missing", finishedAt: null }),
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "Deadline check for 2026-10-05" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("LATE")).toBeTruthy();
    expect(within(table).getByText("MISSING")).toBeTruthy();
    expect(screen.getByText("ATTENTION")).toBeTruthy();
  });

  it("says OK when nothing is late or missing", () => {
    render(<DayTimelineView date="2026-10-05" rows={[row({}), row({ status: "not_due" })]} />);
    expect(screen.getByText("OK so far")).toBeTruthy();
  });

  it("an unreadable day shows a neutral line", () => {
    render(<DayTimelineView date="2026-10-05" rows={null} />);
    expect(screen.getByText("The day timeline is unavailable.")).toBeTruthy();
  });
});

describe("DayTimelineCheck", () => {
  it("renders nothing for a non-owner and never reads", async () => {
    expect(await DayTimelineCheck({ owner: false })).toBeNull();
    expect(checkDay).not.toHaveBeenCalled();
  });

  it("an owner gets the card; a read error gives the neutral line, not the error", async () => {
    checkDay.mockResolvedValueOnce([row({})]);
    render(await DayTimelineCheck({ owner: true }));
    expect(screen.getByRole("heading", { name: "Day timeline check" })).toBeTruthy();
    cleanup();
    checkDay.mockRejectedValueOnce(new Error("libsql://secret.example token"));
    render(await DayTimelineCheck({ owner: true }));
    expect(screen.getByText("The day timeline is unavailable.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret\.example/);
  });
});
