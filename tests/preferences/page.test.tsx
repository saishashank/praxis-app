// UX-110, UX-004, SEC-016, ROL-106, ROL-102a: Settings > Personal page, home link, layout theme.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const getPrefs = vi.hoisted(() => vi.fn());
const getCurrentUser = vi.hoisted(() => vi.fn());
const authDbMock = vi.hoisted(() => vi.fn());
const action = vi.hoisted(() => vi.fn<(fd: FormData) => Promise<unknown>>());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn(), signOutAction: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => authDbMock() }));
vi.mock("@/lib/preferences/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/preferences/service")>()),
  getPreferences: (...a: unknown[]) => getPrefs(...a),
}));
vi.mock("@/app/(app)/settings/actions", () => ({
  updatePreferencesAction: (fd: FormData) => action(fd),
}));
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "inter-var" }) }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import SettingsPage from "@/app/(app)/settings/page";
import HomePage from "@/app/(app)/page";
import RootLayout from "@/app/layout";
import { currentTheme } from "@/lib/preferences/current";
import { userPreferences } from "@/lib/preferences/read";
import { DEFAULT_PREFERENCES } from "@/lib/preferences/service";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  authDbMock.mockReturnValue({});
  getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES });
  action.mockResolvedValue({ ok: true });
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 7, email: `${role}@example.test`, name: null, role });

describe("settings page", () => {
  it.each(["owner", "editor", "viewer"])(
    "renders for %s with badge, form and footers",
    async (r) => {
      as(r);
      render(await SettingsPage());
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings");
      expect(getPrefs).toHaveBeenCalledWith({}, 7);
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByLabelText("Your role")).toHaveTextContent(r);
      expect(screen.getByLabelText("Theme")).toHaveValue("dark");
      expect(
        screen.getAllByRole("option").filter((o) => o.closest("select")?.name === "theme"),
      ).toHaveLength(6);
      expect(screen.getByLabelText("Default market")).toHaveValue("AU");
      expect(screen.getByLabelText("Time format")).toHaveValue("24h");
      expect(screen.getByLabelText("P1 alerts")).toHaveValue("immediate");
      expect(screen.getByLabelText("P2 alerts")).toHaveValue("digest");
      expect(screen.getByText(/P0 alerts are always delivered immediately/)).toBeInTheDocument();
      expect(screen.queryByLabelText("P0 alerts")).toBeNull();
      expect(
        screen.getByText(
          "Emails from this system never ask for keys or passwords. Sign in and do rotations only via your own bookmark.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Simulation for personal information only — not financial advice"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    },
  );

  it("shows stored values", async () => {
    as("viewer");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, theme: "dim", time_format: "12h" });
    render(await SettingsPage());
    expect(screen.getByLabelText("Theme")).toHaveValue("dim");
    expect(screen.getByLabelText("Time format")).toHaveValue("12h");
  });

  it("submits the form and shows Saved, then an error text", async () => {
    as("viewer");
    render(await SettingsPage());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0][0];
    expect(fd.get("theme")).toBe("dark");
    expect(fd.get("time_format")).toBe("24h");
    expect(fd.get("alert_p2")).toBe("digest");
    expect(fd.has("alert_p0")).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    action.mockResolvedValue({ error: "invalid" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please check the entries and try again.",
    );
  });
});

describe("home page link", () => {
  it.each(["owner", "editor", "viewer"])("%s sees Settings", async (r) => {
    as(r);
    render(await HomePage());
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});

describe("root layout theme", () => {
  it("sets data-theme from the signed-in user's preference", async () => {
    getCurrentUser.mockResolvedValue({ id: 7 });
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, theme: "high_contrast" });
    const el = await RootLayout({ children: <p>x</p> });
    expect(el.props["data-theme"]).toBe("high_contrast");
    expect(el.props.lang).toBe("en");
  });

  it("uses the default theme when signed out or on any failure", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await RootLayout({ children: null })).props["data-theme"]).toBe("dark");
    getCurrentUser.mockRejectedValue(new Error("auth down"));
    expect(await currentTheme()).toBe("dark");
    getCurrentUser.mockResolvedValue({ id: 7 });
    getPrefs.mockRejectedValue(new Error("db down"));
    expect(await currentTheme()).toBe("dark");
    expect(await userPreferences(7)).toEqual(DEFAULT_PREFERENCES);
  });
});
