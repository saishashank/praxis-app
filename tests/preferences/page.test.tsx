// UX-110, UX-004, SEC-016, ROL-106, ROL-102a: Settings > Personal page, home link, layout theme.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  updateAppearanceAction: vi.fn(),
  updateRegionAction: vi.fn(),
  setQuietHoursAction: vi.fn(),
}));
// The market list for "Open the app in" (falls back to the stored market when it cannot be read).
vi.mock("@/lib/ui/loaders/shell", () => ({
  envFor: async () => {
    throw new Error("no env in this test");
  },
}));
vi.mock("@/lib/alerts/api", () => ({ getQuietHours: async () => null }));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "inter-var" }),
  JetBrains_Mono: () => ({ variable: "mono-var" }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import SettingsPage from "@/app/(app)/settings/page";
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

const timeForm = () => screen.getByLabelText("Time format").closest("form") as HTMLFormElement;

describe("settings page (UXR-027: one page, rows with current values)", () => {
  it.each(["owner", "editor", "viewer"])(
    "renders for %s with account, sign out, rows, forms and footers",
    async (r) => {
      as(r);
      render(await SettingsPage());
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings");
      expect(getPrefs).toHaveBeenCalledWith({}, 7);
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByLabelText("Your role")).toHaveTextContent(
        r.charAt(0).toUpperCase() + r.slice(1),
      );
      // UXR-004: identity and a visible Sign out, without opening a menu
      expect(screen.getByText(`${r}@example.test`)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      // the four sub-page tabs are gone; groups take their place
      expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
      for (const g of ["Account", "Appearance", "Time and alerts", "Region and markets", "About"]) {
        expect(screen.getByRole("heading", { name: g })).toBeInTheDocument();
      }
      // UXR-003: current values are visible before editing
      expect(screen.getByText("Dark (default)", { selector: "span" })).toBeInTheDocument();
      expect(screen.getByText("24-hour (13:30)", { selector: "span" })).toBeInTheDocument();
      expect(screen.getAllByText("Immediately", { selector: "span" }).length).toBeGreaterThan(0);
      expect(screen.getByText("Off", { selector: "span" })).toBeInTheDocument(); // quiet hours
      expect(screen.getByRole("link", { name: /Markets/ })).toHaveAttribute(
        "href",
        "/settings/region",
      );
      expect(screen.getByRole("link", { name: /About Praxis/ })).toHaveAttribute(
        "href",
        "/settings/about",
      );
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
      // one Save per form (Appearance, Time and alerts, Region; quiet hours has its own "Save quiet hours")
      expect(within(timeForm()).getByRole("button", { name: "Save" })).toBeEnabled();
      expect(screen.getAllByRole("button", { name: "Save" }).length).toBe(3);
    },
  );

  it("shows stored values", async () => {
    as("viewer");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, time_format: "12h" });
    render(await SettingsPage());
    expect(screen.getByLabelText("Time format")).toHaveValue("12h");
  });

  it("submits the form and shows Saved, then an error text", async () => {
    as("viewer");
    render(await SettingsPage());
    const save = () => within(timeForm()).getByRole("button", { name: "Save" });
    await act(async () => fireEvent.click(save()));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0][0];
    expect(fd.has("theme")).toBe(false);
    expect(fd.get("time_format")).toBe("24h");
    expect(fd.get("alert_p2")).toBe("digest");
    expect(fd.has("alert_p0")).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    action.mockResolvedValue({ error: "invalid" });
    await act(async () => fireEvent.click(save()));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please check the entries and try again.",
    );
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
