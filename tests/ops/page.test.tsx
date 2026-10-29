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

  it("groups tasks Overdue / Due soon / Done; one Mark done and a text status pill per tickable row", async () => {
    guard.requireUser.mockResolvedValueOnce(owner);
    ops.loadOps.mockResolvedValueOnce(model());
    render(await OpsPage());
    expect(screen.getByRole("heading", { level: 1, name: "Ops checklist" })).toBeInTheDocument();
    expect(screen.getByText(/Today is Mon, 5 Oct 2026/)).toBeInTheDocument();
    const overdue = screen.getByRole("region", { name: /^Overdue/ });
    const soon = screen.getByRole("region", { name: /^Due soon/ });
    const done = screen.getByRole("region", { name: /^Done/ });
    // monthly (Sat 3 Oct), offsite (1 Oct), restore drill (1 Oct), calendar (1 Nov 2025), token rotation
    expect(within(overdue).getAllByText(/Monthly checks/).length).toBeGreaterThan(0);
    expect(
      within(overdue).getByText(/Overdue by 2 days \(due Sat, 3 Oct 2026\)/),
    ).toBeInTheDocument();
    // exactly one Mark done per overdue row, each row with a status pill that carries text
    const rows = within(overdue).getAllByRole("listitem");
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(within(r).getAllByRole("button", { name: /Mark done/ })).toHaveLength(1);
      expect(r.querySelector('[data-kind="status"]')).toHaveTextContent("Overdue");
    }
    expect(within(done).getAllByText(/Weekly review/).length).toBeGreaterThan(0);
    expect(within(done).getByText(/Next due Sat, 10 Oct 2026/)).toBeInTheDocument();
    expect(within(done).queryByRole("button")).toBeNull();
    expect(within(soon).getAllByText(/ASIC CFD leverage label/).length).toBeGreaterThan(0);
    // the token rotation is due now (not yet overdue): one Mark done; the not-yet-due ones have none
    expect(within(soon).getAllByText(/Rotate turso_token/).length).toBeGreaterThan(0);
    expect(within(soon).getAllByRole("button", { name: /Mark done/ })).toHaveLength(1);
    for (const r of within(soon).getAllByRole("listitem")) {
      expect(r.querySelector('[data-kind="status"]')).toHaveTextContent(/^(Not due yet|Due)$/);
    }
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
