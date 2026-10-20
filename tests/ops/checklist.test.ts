// @vitest-environment node
// OPS-020 due dates (UX-118; M7 T19b): Melbourne calendar dates, correct across BOTH daylight-saving
// changes of 2026 (clocks forward 04 Oct 02:00 AEST -> 03:00 AEDT; back 05 Apr 03:00 AEDT -> 02:00 AEST).
import { describe, expect, it } from "vitest";
import {
  ASIC_REVIEW_FROM,
  buildChecklist,
  daysBetween,
  firstSaturday,
  FIXED_TASKS,
  melbourneToday,
  occurrences,
  tickableDue,
  type DoneRow,
} from "@/lib/ops/checklist";

const WARN = [14, 7, 2];
const row = (today: string, id: string, done: DoneRow[] = []) =>
  buildChecklist(today, done, [], WARN).find((r) => r.id === id)!;

describe("Melbourne today across the two DST changes", () => {
  it.each([
    // [instant, Melbourne date]
    ["2026-10-03T13:30:00Z", "2026-10-03"], // 23:30 AEST: a fixed +11 would say 04 Oct
    ["2026-10-03T13:59:59Z", "2026-10-03"],
    ["2026-10-03T14:00:00Z", "2026-10-04"], // midnight AEST
    ["2026-10-03T16:30:00Z", "2026-10-04"], // 03:30 AEDT (the 02:00-03:00 hour does not exist)
    ["2026-10-04T12:59:59Z", "2026-10-04"], // 23:59 AEDT
    ["2026-10-04T13:00:00Z", "2026-10-05"], // midnight AEDT
    ["2026-04-04T12:59:59Z", "2026-04-04"], // 23:59 AEDT
    ["2026-04-04T13:30:00Z", "2026-04-05"], // 00:30 AEDT: a fixed +10 would say 04 Apr
    ["2026-04-04T16:30:00Z", "2026-04-05"], // 02:30 AEST (the hour repeats)
    ["2026-04-05T13:59:59Z", "2026-04-05"], // 23:59 AEST
    ["2026-04-05T14:00:00Z", "2026-04-06"], // midnight AEST
  ])("%s is %s", (iso, d) => {
    expect(melbourneToday(new Date(iso))).toBe(d);
  });
});

describe("dates", () => {
  it("first Saturday of a month, including a month that starts on a Saturday", () => {
    expect(firstSaturday(2026, 10)).toBe("2026-10-03");
    expect(firstSaturday(2026, 4)).toBe("2026-04-04");
    expect(firstSaturday(2026, 8)).toBe("2026-08-01"); // 1 Aug 2026 is a Saturday
    expect(firstSaturday(2027, 1)).toBe("2027-01-02");
  });
  it("whole days between calendar dates ignore the 23 and 25 hour days", () => {
    expect(daysBetween("2026-10-03", "2026-10-05")).toBe(2);
    expect(daysBetween("2026-04-04", "2026-04-06")).toBe(2);
    expect(daysBetween("2026-12-31", "2027-01-02")).toBe(2);
    expect(daysBetween("2026-10-05", "2026-10-03")).toBe(-2);
  });
});

describe("weekly review (Saturday)", () => {
  it("is due on the Saturday itself, even at 23:30 on the night the clocks go forward", () => {
    const today = melbourneToday(new Date("2026-10-03T13:30:00Z")); // Saturday 23:30 AEST
    const r = row(today, "weekly_review");
    expect(r).toMatchObject({
      dueD: "2026-10-03",
      status: "due",
      daysOverdue: 0,
      nextD: "2026-10-10",
    });
  });
  it("is one day overdue on the Sunday after the clocks go forward (04 Oct)", () => {
    const r = row(melbourneToday(new Date("2026-10-03T16:30:00Z")), "weekly_review");
    expect(r).toMatchObject({ dueD: "2026-10-03", status: "overdue", daysOverdue: 1 });
  });
  it("is one day overdue on the Sunday after the clocks go back (05 Apr), not due today", () => {
    // 00:30 AEDT on Sunday 05 Apr: a fixed +10 offset would still say Saturday and "due"
    const r = row(melbourneToday(new Date("2026-04-04T13:30:00Z")), "weekly_review");
    expect(r).toMatchObject({ dueD: "2026-04-04", status: "overdue", daysOverdue: 1 });
  });
  it("a tick moves it to done and shows the next Saturday", () => {
    const done = [{ taskId: "weekly_review", dueD: "2026-04-04", doneAt: "2026-04-04T02:00:00Z" }];
    const r = row("2026-04-05", "weekly_review", done);
    expect(r).toMatchObject({
      status: "done",
      nextD: "2026-04-11",
      doneAt: "2026-04-04T02:00:00Z",
    });
  });
  it("the same weekday rule holds across every week of 2026 (DST weeks included)", () => {
    for (let i = 0; i < 365; i += 1) {
      const today = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const o = occurrences({ cadence: "weekly", id: "weekly_review" }, today);
      expect(new Date(`${o.latest}T00:00:00Z`).getUTCDay()).toBe(6);
      expect(daysBetween(o.latest!, today)).toBeLessThan(7);
      expect(daysBetween(o.latest!, today)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(today, o.next!)).toBeGreaterThan(0);
      expect(daysBetween(today, o.next!)).toBeLessThanOrEqual(7);
    }
  });
});

describe("monthly (first Saturday) and offsite (1st)", () => {
  it("is due on 03 Oct 2026, the night the clocks go forward", () => {
    expect(row("2026-10-03", "monthly_checks")).toMatchObject({
      dueD: "2026-10-03",
      status: "due",
      nextD: "2026-11-07",
    });
  });
  it("is overdue by one day on 05 Apr 2026 (first Saturday was 04 Apr)", () => {
    expect(row(melbourneToday(new Date("2026-04-04T13:30:00Z")), "monthly_checks")).toMatchObject({
      dueD: "2026-04-04",
      status: "overdue",
      daysOverdue: 1,
    });
  });
  it("before the first Saturday it still shows the previous month's occurrence", () => {
    expect(row("2026-10-02", "monthly_checks").dueD).toBe("2026-09-05");
  });
  it("the offsite check falls on the 1st, also across the year end", () => {
    expect(row("2026-10-01", "offsite_backup")).toMatchObject({
      dueD: "2026-10-01",
      status: "due",
    });
    expect(row("2027-01-01", "offsite_backup")).toMatchObject({
      dueD: "2027-01-01",
      nextD: "2027-02-01",
    });
    expect(row("2026-12-31", "offsite_backup")).toMatchObject({
      dueD: "2026-12-01",
      nextD: "2027-01-01",
    });
  });
});

describe("quarterly, yearly and one-off", () => {
  it("restore drill on 1 Jan, Apr, Jul, Oct", () => {
    expect(row("2026-10-04", "restore_drill").dueD).toBe("2026-10-01");
    expect(row("2026-04-05", "restore_drill").dueD).toBe("2026-04-01");
    expect(row("2026-03-31", "restore_drill").dueD).toBe("2026-01-01");
    expect(row("2026-03-31", "restore_drill").nextD).toBe("2026-04-01");
  });
  it("calendar confirmation on 1 November", () => {
    expect(row("2026-10-31", "calendar_confirm")).toMatchObject({
      dueD: "2025-11-01",
      nextD: "2026-11-01",
    });
    expect(row("2026-11-01", "calendar_confirm")).toMatchObject({
      dueD: "2026-11-01",
      status: "due",
    });
  });
  it("the ASIC review is not due until after 23 May 2027", () => {
    expect(row("2026-10-04", "asic_cfd_review")).toMatchObject({
      dueD: null,
      status: "upcoming",
      nextD: ASIC_REVIEW_FROM,
    });
    expect(row("2027-05-23", "asic_cfd_review").status).toBe("upcoming");
    expect(row("2027-05-24", "asic_cfd_review")).toMatchObject({
      dueD: ASIC_REVIEW_FROM,
      status: "due",
    });
    expect(row("2027-06-01", "asic_cfd_review")).toMatchObject({
      status: "overdue",
      daysOverdue: 8,
    });
  });
});

describe("token rotation", () => {
  const tokens = [
    { name: "turso_token", expiresOn: "2026-10-20" },
    { name: "alpha_key", expiresOn: "2026-12-31" },
  ];
  it("opens at the largest warning day and is due on the expiry date", () => {
    const at = (today: string) =>
      buildChecklist(today, [], tokens, WARN).filter((r) => r.id.startsWith("rotate_"));
    expect(at("2026-10-05").find((r) => r.id === "rotate_turso_token")).toMatchObject({
      status: "upcoming",
      dueD: null,
      nextD: "2026-10-20",
    });
    expect(at("2026-10-06").find((r) => r.id === "rotate_turso_token")).toMatchObject({
      status: "due",
      dueD: "2026-10-20",
    });
    expect(at("2026-10-22").find((r) => r.id === "rotate_turso_token")).toMatchObject({
      status: "overdue",
      daysOverdue: 2,
    });
    expect(at("2026-10-06").find((r) => r.id === "rotate_alpha_key")?.status).toBe("upcoming");
  });
  it("is ordered by expiry date and a tick on that date marks it done", () => {
    const rows = buildChecklist(
      "2026-10-10",
      [{ taskId: "rotate_turso_token", dueD: "2026-10-20", doneAt: "2026-10-10T01:00:00Z" }],
      tokens,
      WARN,
    ).filter((r) => r.id.startsWith("rotate_"));
    expect(rows.map((r) => r.id)).toEqual(["rotate_turso_token", "rotate_alpha_key"]);
    expect(rows[0]).toMatchObject({ status: "done", doneAt: "2026-10-10T01:00:00Z" });
  });
});

describe("what a tick may name", () => {
  it("only the occurrence shown today", () => {
    expect(tickableDue("weekly_review", "2026-10-05", [], WARN)).toBe("2026-10-03");
    expect(tickableDue("asic_cfd_review", "2026-10-05", [], WARN)).toBeNull();
    expect(tickableDue("nope", "2026-10-05", [], WARN)).toBeNull();
    expect(
      tickableDue("rotate_x", "2026-10-05", [{ name: "x", expiresOn: "2026-10-10" }], WARN),
    ).toBe("2026-10-10");
  });
  it("every fixed task has a stable id and wording", () => {
    expect(FIXED_TASKS.map((t) => t.id)).toEqual([
      "weekly_review",
      "monthly_checks",
      "offsite_backup",
      "restore_drill",
      "calendar_confirm",
      "asic_cfd_review",
    ]);
    for (const t of FIXED_TASKS) expect(t.detail.length).toBeGreaterThan(20);
  });
});
