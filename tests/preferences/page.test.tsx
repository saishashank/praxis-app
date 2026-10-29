// UX-110, UX-004, SEC-016, ROL-106, ROL-102a: Settings > Personal page, home link, layout theme.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  updateAppearanceAction: (fd: FormData) => action(fd),
  updateRegionAction: (fd: FormData) => action(fd),
  setQuietHoursAction: vi.fn(),
  signOutEverywhereSelfAction: vi.fn(),
}));
// The market list for "Open the app in" (falls back to the stored market when it cannot be read).
const envFor = vi.hoisted(() => vi.fn());
const marketRows = vi.hoisted(() => vi.fn());
const quietHours = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui/loaders/shell", () => ({ envFor: (...a: unknown[]) => envFor(...a) }));
vi.mock("@/lib/ui/loaders/settings", () => ({ loadSettings: async () => ({}) }));
vi.mock("@/app/(app)/settings/region", () => ({
  marketRows: (...a: unknown[]) => marketRows(...a),
  readProfiles: async () => ({}),
  readSharedMarkets: async () => new Set<string>(),
}));
vi.mock("@/lib/alerts/api", () => ({ getQuietHours: (...a: unknown[]) => quietHours(...a) }));
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
  envFor.mockRejectedValue(new Error("no env in this test"));
  quietHours.mockResolvedValue(null);
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 7, email: `${role}@example.test`, name: null, role });

const openRow = async (name: RegExp | string) => {
  const row = screen.getByRole("link", { name });
  await act(async () => fireEvent.click(row));
  return await screen.findByRole("dialog");
};

describe("settings page (UXR-027: one page, rows with current values)", () => {
  it.each(["owner", "editor", "viewer"])(
    "renders for %s with account, sign out, grouped value rows and footers",
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
      // "Sign out everywhere" is admin (Owner) only
      expect(screen.queryByRole("link", { name: /Sign out everywhere/ }) !== null).toBe(
        r === "owner",
      );
      expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
      for (const g of ["Account", "Appearance", "Time and alerts", "Region and markets", "About"]) {
        expect(screen.getByRole("heading", { name: g })).toBeInTheDocument();
      }
      // UXR-003: the current value is in the row, before anything is opened
      const rowValue = (name: RegExp, value: string) =>
        expect(screen.getByRole("link", { name })).toHaveTextContent(value);
      rowValue(/^Theme/, "Dark (default)");
      rowValue(/^Motion/, "On");
      rowValue(/^Time format/, "24-hour (13:30)");
      rowValue(/^P1 alerts/, "Immediately");
      rowValue(/^P2 alerts/, "In the digest");
      rowValue(/^Quiet hours/, "Off");
      rowValue(/^Show times in/, "Melbourne time");
      // no JS: each row is a link to its detail page
      const href = (name: RegExp, h: string) =>
        expect(screen.getByRole("link", { name })).toHaveAttribute("href", h);
      href(/^Time format/, "/settings/time");
      href(/^Quiet hours/, "/settings/quiet-hours");
      href(/^Theme/, "/settings/appearance");
      href(/^Markets/, "/settings/region");
      href(/^Licences/, "/settings/about#licences");
      // nothing is edited in the list itself: a Save only appears inside an open sheet
      expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(0);
      expect(
        screen.getByText(
          "Emails from this system never ask for keys or passwords. Sign in and do rotations only via your own bookmark.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Simulation for personal information only — not financial advice"),
      ).toBeInTheDocument();
    },
  );

  it("shows stored values", async () => {
    as("viewer");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, time_format: "12h" });
    render(await SettingsPage());
    expect(screen.getByRole("link", { name: /^Time format/ })).toHaveTextContent("12-hour");
  });

  it("a row opens a sheet with exactly one Save; saving closes it and toasts Saved", async () => {
    as("viewer");
    render(await SettingsPage());
    const dialog = await openRow(/^Time format/);
    expect(within(dialog).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("radio", { name: /12-hour/ }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0][0];
    expect(fd.get("time_format")).toBe("12h");
    expect(fd.has("theme")).toBe(false);
    expect(fd.has("alert_p0")).toBe(false);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("link", { name: /^Time format/ })).toHaveTextContent("12-hour");
  });

  it("shows the error text in the sheet and keeps it open", async () => {
    as("viewer");
    action.mockResolvedValue({ error: "invalid" });
    render(await SettingsPage());
    const dialog = await openRow(/^P1 alerts/);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please check the entries and try again.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("theme sheet: six option cards, check and Current on the stored theme, live preview", async () => {
    as("viewer");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, theme: "dim" });
    render(await SettingsPage());
    const dialog = await openRow(/^Theme/);
    expect(within(dialog).getAllByRole("radio")).toHaveLength(6);
    expect(within(dialog).getByRole("radio", { name: /Dim/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(dialog).getAllByText("Current")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Midnight/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
    expect(within(dialog).getByRole("radio", { name: /Midnight/ })).toHaveTextContent("Current");
    document.documentElement.removeAttribute("data-theme");
  });

  it("motion sheet saves only motion and sets data-motion on the root element", async () => {
    as("viewer");
    render(await SettingsPage());
    const dialog = await openRow(/^Motion/);
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Off/ }));
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(action).toHaveBeenCalledTimes(1);
    expect([...action.mock.calls[0][0].keys()]).toEqual(["motion"]);
    expect(action.mock.calls[0][0].get("motion")).toBe("off");
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^Motion/ })).toHaveTextContent("Off"),
    );
    expect(document.documentElement.getAttribute("data-motion")).toBe("off");
    document.documentElement.removeAttribute("data-motion");
  });

  it("closing the theme sheet without saving restores the stored theme", async () => {
    as("viewer");
    render(await SettingsPage());
    document.documentElement.setAttribute("data-theme", "dark");
    const dialog = await openRow(/^Theme/);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Close" })));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(action).not.toHaveBeenCalled();
    document.documentElement.removeAttribute("data-theme");
  });

  it("Owner gets a confirm sheet for Sign out everywhere", async () => {
    as("owner");
    render(await SettingsPage());
    const dialog = await openRow(/Sign out everywhere/);
    expect(within(dialog).getByText(/ends your sessions on every device/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Sign out everywhere" })).toHaveLength(1);
  });
});

describe("settings page values (UXR-003)", () => {
  it("lists only the markets the user may open, and shows quiet hours when set", async () => {
    as("owner");
    envFor.mockResolvedValue({ main: {}, auth: {}, now: new Date("2026-10-23T00:00:00Z") });
    marketRows.mockReturnValue([
      { code: "AU", exchange: "ASX", selectable: true },
      { code: "US", exchange: "NYSE", selectable: true },
      { code: "UK", exchange: "LSE", selectable: false },
    ]);
    quietHours.mockResolvedValue({ start: "22:00", end: "07:00" });
    render(await SettingsPage());
    const dialog = await openRow(/^Open the app in/);
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    expect(within(dialog).getByRole("radio", { name: /AU \(ASX\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /US \(NYSE\)/ })).toBeInTheDocument();
    expect(marketRows.mock.calls[0][3]).toBe(true); // the Owner's view of the markets
    expect(screen.getByRole("link", { name: /^Quiet hours/, hidden: true })).toHaveTextContent(
      "22:00–07:00",
    );
  });

  it("keeps a stored market that is no longer choosable, and shows stored values", async () => {
    as("viewer");
    envFor.mockResolvedValue({ main: {}, auth: {}, now: new Date("2026-10-23T00:00:00Z") });
    marketRows.mockReturnValue([{ code: "AU", exchange: "ASX", selectable: true }]);
    getPrefs.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      default_market: "JP",
      times_in: "exchange",
      motion: "off",
      theme: "midnight",
    });
    render(await SettingsPage());
    expect(screen.getByRole("link", { name: /^Open the app in/ })).toHaveTextContent("JP");
    expect(marketRows.mock.calls[0][3]).toBe(false);
    expect(screen.getByRole("link", { name: /^Show times in/ })).toHaveTextContent(
      "Exchange-local time",
    );
    expect(screen.getByRole("link", { name: /^Motion/ })).toHaveTextContent("Off");
    expect(screen.getByRole("link", { name: /^Theme/ })).toHaveTextContent("Midnight");
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
