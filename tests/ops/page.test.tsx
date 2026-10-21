// Ops checklist page (UX-118, OPS-020; M7 T19b): Owner-only guard first, tasks with Melbourne due dates,
// a Mark done button only where a tick is allowed, token expiry dates, and neutral failure text.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpsPage from "@/app/(app)/ops/page";
import { buildChecklist } from "@/lib/ops/checklist";

const guard = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/guard", () => guard);
const ops = vi.hoisted(() => ({ loadOps: vi.fn() }));
vi.mock("@/lib/ops/service", () => ({ loadOps: ops.loadOps }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}) }));
vi.mock("@/lib/preferences/read", () => ({
  userPreferences: async () => ({ time_format: "24h" }),
}));
vi.mock("@/app/(app)/ops/actions", () => ({ tickOpsTaskAction: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T01:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const owner = { id: 1, email: "o@example.test", name: null, role: "owner" };
const WARN = [14, 7, 2];
const model = () => ({
  today: "2026-10-05",
  warnDays: WARN,
  tasks: buildChecklist(
    "2026-10-05",
    [{ taskId: "weekly_review", dueD: "2026-10-03", doneAt: "2026-10-03T22:00:00Z" }],
    [{ name: "turso_token", expiresOn: "2026-10-12" }],
    WARN,
  ),
  tokens: [{ name: "turso_token", expiresOn: "2026-10-12", daysLeft: 7 }],
});

describe("ops page", () => {
  it("asks for the admin action first; a non-Owner never reaches the data", async () => {
    guard.requireUser.mockRejectedValueOnce(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(OpsPage()).rejects.toThrow(/403/);
    expect(guard.requireUser).toHaveBeenCalledWith("admin", "/ops");
    expect(ops.loadOps).not.toHaveBeenCalled();
  });

  it("shows due and overdue tasks with a button, finished and future ones without", async () => {
    guard.requireUser.mockResolvedValueOnce(owner);
    ops.loadOps.mockResolvedValueOnce(model());
    render(await OpsPage());
    expect(screen.getByRole("heading", { level: 1, name: "Ops checklist" })).toBeInTheDocument();
    expect(screen.getByText(/Today is Mon, 5 Oct 2026/)).toBeInTheDocument();
    const needs = screen.getByRole("region", { name: "Needs doing" });
    // monthly (Sat 3 Oct), offsite (1 Oct), restore drill (1 Oct), calendar (1 Nov 2025), token rotation
    expect(within(needs).getAllByText(/Monthly checks/).length).toBeGreaterThan(0);
    expect(
      within(needs).getByText(/Overdue by 2 days \(due Sat, 3 Oct 2026\)/),
    ).toBeInTheDocument();
    expect(within(needs).getAllByText(/Rotate turso_token/).length).toBeGreaterThan(0);
    expect(within(needs).getAllByRole("button", { name: /Mark done/ }).length).toBe(5);
    const rest = screen.getByRole("region", { name: "Done and coming up" });
    expect(within(rest).getAllByText(/Weekly review/).length).toBeGreaterThan(0);
    expect(within(rest).getByText(/Next due Sat, 10 Oct 2026/)).toBeInTheDocument();
    expect(within(rest).getAllByText(/ASIC CFD leverage label/).length).toBeGreaterThan(0);
    expect(within(rest).queryByRole("button")).toBeNull();
    const tokens = screen.getByRole("table", { name: "Token expiry dates" });
    expect(within(tokens).getByRole("rowheader", { name: "turso_token" })).toBeInTheDocument();
    expect(within(tokens).getByText("7")).toBeInTheDocument();
  });

  it("shows a neutral message when the data cannot be read", async () => {
    guard.requireUser.mockResolvedValueOnce(owner);
    ops.loadOps.mockRejectedValueOnce(new Error("db down: secret detail"));
    render(await OpsPage());
    expect(screen.getByRole("status")).toHaveTextContent("Ops checklist unavailable");
    expect(screen.queryByText(/secret detail/)).toBeNull();
  });
});
