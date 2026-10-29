// M7 T9: the (app) layout wires the user, the shell loader into the shell, and is not a
// guard (D-038): with no user it renders the page alone, and a failing loader gives a reduced header.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.hoisted(() => vi.fn());
const loadShell = vi.hoisted(() => vi.fn());
const envFor = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: async () => {} }));
vi.mock("@/lib/ui/loaders/shell", () => ({
  envFor: (...a: unknown[]) => envFor(...a),
  loadShell: (...a: unknown[]) => loadShell(...a),
}));

import AppLayout from "@/app/(app)/layout";

const user = { id: 3, email: "o@example.test", name: null, role: "owner" as const };
const model = {
  state: "ok",
  user: { id: 3, role: "owner" },
  masked: false,
  market: { code: "AU", mode: "data_only", currency: "AUD" },
  bell: { count: 2, topTier: "P1" },
  banners: [{ id: "mode:data_only", text: "Data only: the strategies are not running yet." }],
};

beforeEach(() => {
  getCurrentUser.mockReset();
  loadShell.mockReset();
  envFor.mockReset();
  envFor.mockResolvedValue({});
});

const page = <main>Page body</main>;

describe("(app) layout", () => {
  it("renders the shell around the page for a signed-in user", async () => {
    getCurrentUser.mockResolvedValue(user);
    loadShell.mockResolvedValue(model);
    render(await AppLayout({ children: page }));
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Alerts, 2 not yet acknowledged, highest P1/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Appearance/ })).toBeNull();
    // the mode line is Home's own status strip now; the shell renders no mode banner (UXR-006)
    expect(screen.queryByText("Data only: the strategies are not running yet.")).toBeNull();
    expect(envFor).toHaveBeenCalledWith({ id: 3, role: "owner" });
  });

  it("renders the page alone when nobody is signed in (the page itself redirects)", async () => {
    getCurrentUser.mockResolvedValue(null);
    render(await AppLayout({ children: page }));
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(loadShell).not.toHaveBeenCalled();
  });

  it("renders the page alone when the session lookup fails", async () => {
    getCurrentUser.mockRejectedValue(new Error("auth unavailable"));
    render(await AppLayout({ children: page }));
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });

  it("shows a reduced header and a warning when the shell data cannot be read", async () => {
    getCurrentUser.mockResolvedValue({ ...user, role: "viewer" });
    envFor.mockRejectedValue(new Error("database not configured"));
    render(await AppLayout({ children: page }));
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText("Some header information is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alerts, none waiting" })).toBeInTheDocument();
  });

  it("uses the viewer's role for the menus", async () => {
    getCurrentUser.mockResolvedValue({ ...user, role: "viewer" });
    loadShell.mockResolvedValue({ ...model, banners: [] });
    render(await AppLayout({ children: page }));
    expect(screen.getByRole("button", { name: "Account and settings menu" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users & roles" })).toBeNull();
  });
});
