// Audit log page (D-174; UX-111, ROL-101..107): Owner only, read-only, moved off Users & roles.
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const svc = vi.hoisted(() => ({ listUsers: vi.fn(), listAudit: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ authDb: () => ({}) }));
vi.mock("@/lib/preferences/read", () => ({
  userPreferences: async () => ({ time_format: "24h" }),
}));
vi.mock("@/lib/users/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/users/service")>()),
  ...svc,
}));

import AuditPage from "@/app/(app)/audit/page";

const T = "2026-10-10T12:00:00.000Z";
const u = (id: number, email: string) => ({
  id,
  email,
  name: null,
  role: "viewer",
  status: "active",
  updatedAt: T,
});
const ev = (
  id: number,
  action: string,
  actorUserId: number | null,
  targetType: string | null,
  targetId: string | null,
  detailJson: string | null,
) => ({ id, at: T, action, actorUserId, targetType, targetId, detailJson });

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: 1, email: "owner@example.test", name: null, role: "owner" });
  svc.listUsers.mockResolvedValue([u(1, "owner@example.test"), u(2, "ed@example.test")]);
  svc.listAudit.mockResolvedValue([
    ev(3, "user.add", 1, "app_user", "2", '{"role":"editor"}'),
    ev(2, "sharing.ack", 1, "market", "AU", null),
    ev(1, "auth.signin_refused", null, null, null, null),
    ev(0, "auth.signin_success", 77, "app_user", "88", null),
  ]);
});

describe("audit log page", () => {
  it("is Owner-only, read-only, in Melbourne time, with names and no network data", async () => {
    render(await AuditPage());
    expect(requireUser).toHaveBeenCalledWith("admin", "/audit");
    expect(svc.listAudit).toHaveBeenCalledWith(expect.anything(), 100);
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeInTheDocument();
    const log = within(screen.getByRole("region", { name: "Audit log" }));
    expect(log.getByText("user.add")).toBeInTheDocument();
    expect(log.getAllByText("owner@example.test").length).toBeGreaterThan(0);
    expect(log.getAllByText("ed@example.test").length).toBeGreaterThan(0);
    expect(log.getByText("System")).toBeInTheDocument();
    expect(log.getByText("User #77")).toBeInTheDocument();
    expect(log.getByText("User #88")).toBeInTheDocument();
    expect(log.getByText("AU")).toBeInTheDocument();
    expect(log.getByText('{"role":"editor"}')).toBeInTheDocument();
    expect(log.queryByText(/IP|agent/i)).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says plainly when nothing is recorded", async () => {
    svc.listAudit.mockResolvedValue([]);
    render(await AuditPage());
    expect(screen.getByText("Nothing recorded yet")).toBeInTheDocument();
  });

  it("a non-Owner never reaches the data", async () => {
    requireUser.mockRejectedValue(new Error("403"));
    await expect(AuditPage()).rejects.toThrow(/403/);
    expect(svc.listAudit).not.toHaveBeenCalled();
  });
});
