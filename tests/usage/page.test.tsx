// PLT-050, PLT-051, UX-100, ROL-102a (Usage page is Owner-only)
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UsagePage from "@/app/(app)/usage/page";
import HomePage from "@/app/(app)/page";
import type { Meter } from "@/lib/usage/meters";

const guard = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/guard", () => guard);
const metersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/usage/meters", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage/meters")>()),
  getMeters: metersMock,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn(), signOutAction: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const owner = { id: 1, email: "o@example.test", name: null, role: "owner" };
const meters: Meter[] = [
  {
    id: "turso-rows-written",
    label: "Turso rows written",
    used: 4_200_000,
    limit: 6_000_000,
    unit: "rows",
    period: "monthly",
    periodLabel: "2026-10 (UTC)",
    ratio: 0.7,
    level: "notice",
    note: "Recorded by jobs (app traffic not included). Estimate.",
  },
  {
    id: "turso-storage",
    label: "Turso storage",
    used: null,
    limit: 3,
    unit: "GB",
    period: "none",
    periodLabel: "current",
    ratio: null,
    level: "no data",
    note: "Not measured yet (needs the Turso platform API - later).",
  },
  {
    id: "emails-sent",
    label: "Emails sent",
    used: 0,
    limit: null,
    unit: "emails",
    period: "monthly",
    periodLabel: "2026-10 (UTC)",
    ratio: null,
    level: "no data",
    note: "Counted from jobs named email-* (estimate).",
  },
];

describe("usage page", () => {
  it("requires the admin action; a viewer is refused before any data is read", async () => {
    guard.requireUser.mockRejectedValueOnce(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(UsagePage()).rejects.toThrow(/403/);
    expect(guard.requireUser).toHaveBeenCalledWith("admin", "/usage");
    expect(metersMock).not.toHaveBeenCalled();
  });

  it("owner: table with text levels, used/limit, period, source and footer", async () => {
    guard.requireUser.mockResolvedValueOnce(owner);
    metersMock.mockResolvedValueOnce(meters);
    render(await UsagePage());
    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Turso rows written" })).toBeInTheDocument();
    expect(screen.getAllByText("NOTICE").length).toBe(2); // summary + row
    expect(screen.getAllByText("NO DATA").length).toBe(2);
    expect(screen.getByText(/4,200,000 rows \/ 6,000,000 rows \(70\.0%\)/)).toBeInTheDocument();
    expect(screen.getByText(/No data \/ 3 GB/)).toBeInTheDocument();
    expect(screen.getByText(/0 emails \/ n\/a/)).toBeInTheDocument();
    expect(screen.getAllByText("2026-10 (UTC)").length).toBe(2);
    expect(screen.getByText(/app traffic not included/)).toBeInTheDocument();
    expect(screen.getByText(/Worst level:/)).toHaveTextContent("NOTICE");
    expect(screen.getByText(/not financial advice/)).toBeInTheDocument();
  });

  it("shows a neutral message when the data cannot be read", async () => {
    guard.requireUser.mockResolvedValueOnce(owner);
    metersMock.mockRejectedValueOnce(new Error("db down: secret detail"));
    render(await UsagePage());
    expect(screen.getByRole("status")).toHaveTextContent("Usage data unavailable");
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});

describe("home page Usage link", () => {
  it("is shown for the owner only", async () => {
    guard.requireUser.mockResolvedValueOnce({ ...owner, role: "editor" });
    render(await HomePage());
    expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
    cleanup();
    guard.requireUser.mockResolvedValueOnce(owner);
    render(await HomePage());
    expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute("href", "/usage");
  });
});
