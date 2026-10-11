// DAT-211, UX-010, ROL-102a: the System Health "Data quality" section.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HealthPage from "@/app/(app)/health/page";

const requireUser = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("@/app/(app)/health/actions", () => ({ confirmCalendarAction: vi.fn() }));

afterEach(cleanup);
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });

const quality = (gatePass: boolean, withCodes: boolean) => ({
  date: "2026-10-13",
  tiers: [
    { tier: "U1", valid: 17, expected: 20, score: 0.85, gatePass },
    { tier: "U2", valid: 5, expected: 5, score: 1, gatePass: true },
  ],
  openTotal: 3,
  rules: [
    {
      checkId: "DAT-210:missing_bar",
      severity: "error",
      count: 2,
      blocksEntries: true,
      ...(withCodes ? { topCodes: ["ZZA", "ZZB"] } : {}),
    },
    { checkId: "DAT-200:refetch_diff", severity: "warning", count: 1, blocksEntries: false },
  ],
});
const sectionOf = () => screen.getByRole("heading", { name: "Data quality" }).closest("section")!;

describe("health page: data quality", () => {
  it("owner sees the verdict, tier scores, counts by rule and the codes", async () => {
    summaryMock.mockResolvedValue({ jobs: [], quality: quality(false, true) });
    as("owner");
    render(await HealthPage());
    const section = sectionOf();
    expect(within(section).getByRole("status")).toHaveTextContent("FAIL — no new entries");
    expect(section).toHaveTextContent("Latest date: 2026-10-13. Exits are never blocked.");
    expect(within(section).getByText("17 of 20")).toBeInTheDocument();
    expect(within(section).getByText("85.0%")).toBeInTheDocument();
    expect(within(section).getByText("DAT-210:missing_bar")).toBeInTheDocument();
    expect(within(section).getByText("ZZA, ZZB")).toBeInTheDocument();
    expect(within(section).getByRole("columnheader", { name: "Codes" })).toBeInTheDocument();
  });

  it.each(["editor", "viewer"])("%s sees counts but no codes column", async (role) => {
    summaryMock.mockResolvedValue({ jobs: [], quality: quality(true, false) });
    as(role);
    render(await HealthPage());
    const section = sectionOf();
    expect(within(section).getByRole("status")).toHaveTextContent("PASS");
    expect(within(section).getByText("DAT-210:missing_bar")).toBeInTheDocument();
    expect(within(section).queryByRole("columnheader", { name: "Codes" })).toBeNull();
    expect(section).not.toHaveTextContent("ZZA");
  });

  it("shows NO DATA when there is no U1 score row", async () => {
    summaryMock.mockResolvedValue({
      jobs: [],
      quality: { date: "2026-10-13", tiers: [], rules: [], openTotal: 0 },
    });
    as("viewer");
    render(await HealthPage());
    expect(within(sectionOf()).getByRole("status")).toHaveTextContent("NO DATA");
    expect(screen.getByText("No open flags for this date.")).toBeInTheDocument();
  });

  it("no scores yet: says so; no data object: hides the section", async () => {
    as("viewer");
    summaryMock.mockResolvedValue({
      jobs: [],
      quality: { date: null, tiers: [], rules: [], openTotal: 0 },
    });
    render(await HealthPage());
    expect(screen.getByText("No quality checks have run yet.")).toBeInTheDocument();
    cleanup();
    for (const q of [undefined, null]) {
      summaryMock.mockResolvedValue({ jobs: [], quality: q });
      render(await HealthPage());
      expect(screen.queryByRole("heading", { name: "Data quality" })).toBeNull();
      cleanup();
    }
  });
});
