// DAT-160, D-057 #11, ROL-102a: the System Health trading calendar line and Confirm button.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HealthPage from "@/app/(app)/health/page";
import { CalendarConfirmForm } from "@/app/(app)/health/CalendarConfirmForm";

const requireUser = vi.hoisted(() => vi.fn());
const summaryMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/health/summary", () => ({ getHealthSummary: summaryMock }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("@/app/(app)/health/actions", () => ({ confirmCalendarAction: vi.fn() }));

afterEach(cleanup);

const cal = (year: number, unconfirmed: number) => ({
  market: "AU",
  year,
  tradingDays: 254,
  holidays: 7,
  unconfirmed,
  total: 261,
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });

describe("health page: trading calendar", () => {
  it("owner sees the status and a Confirm button for an unconfirmed year only", async () => {
    summaryMock.mockResolvedValue({ jobs: [], calendar: [cal(2026, 261), cal(2027, 0)] });
    as("owner");
    render(await HealthPage());
    expect(screen.getByRole("heading", { name: "Trading calendar" })).toBeInTheDocument();
    expect(screen.getByText(/AU trading calendar 2026: 254 days,/)).toHaveTextContent(
      "NOT CONFIRMED",
    );
    expect(screen.getByText(/AU trading calendar 2027: 254 days,/)).toHaveTextContent(
      /\bCONFIRMED/,
    );
    expect(screen.getByText(/AU trading calendar 2027/)).not.toHaveTextContent("NOT CONFIRMED");
    expect(screen.getAllByRole("button", { name: /Confirm AU \d{4} calendar/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Confirm AU 2026 calendar" })).toBeInTheDocument();
  });

  it.each(["editor", "viewer"])("%s sees the status but no Confirm button", async (role) => {
    summaryMock.mockResolvedValue({ jobs: [], calendar: [cal(2026, 261)] });
    as(role);
    render(await HealthPage());
    expect(screen.getByText(/AU trading calendar 2026: 254 days,/)).toHaveTextContent(
      "NOT CONFIRMED",
    );
    expect(screen.queryByRole("button", { name: /Confirm AU/ })).toBeNull();
  });

  it("hides the section when there is no calendar data", async () => {
    for (const calendar of [undefined, null, []]) {
      summaryMock.mockResolvedValue({ jobs: [], calendar });
      as("owner");
      render(await HealthPage());
      expect(screen.queryByRole("heading", { name: "Trading calendar" })).toBeNull();
      cleanup();
    }
  });
});

describe("CalendarConfirmForm", () => {
  it("submits market and year, then shows Confirmed", async () => {
    const action = vi.fn(async (fd: FormData) => {
      void fd;
      return { ok: true as const, rows: 261 };
    });
    render(<CalendarConfirmForm action={action} market="AU" year={2026} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm AU 2026 calendar" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Confirmed."));
    const fd = action.mock.calls[0][0];
    expect(fd.get("market")).toBe("AU");
    expect(fd.get("year")).toBe("2026");
  });

  it("shows safe error text for a returned code", async () => {
    const action = vi.fn(async () => ({ error: "unavailable" }));
    render(<CalendarConfirmForm action={action} market="AU" year={2026} />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm AU 2026/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Something went wrong. Please try again.",
      ),
    );
  });
});
