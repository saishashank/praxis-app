// UXN-019, UXN-280..282, UX-004: Settings > Appearance, Region & markets and About pages, the region
// helpers (hours in Melbourne time across DST), the notices generator and the Motion switch on <html>.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const getPrefs = vi.hoisted(() => vi.fn());
const getCurrentUser = vi.hoisted(() => vi.fn());
const loadSettings = vi.hoisted(() => vi.fn());
const envFor = vi.hoisted(() => vi.fn());
const appearanceAction = vi.hoisted(() => vi.fn<(fd: FormData) => Promise<unknown>>());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => ({}) }));
vi.mock("@/lib/preferences/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/preferences/service")>()),
  getPreferences: (...a: unknown[]) => getPrefs(...a),
}));
vi.mock("@/lib/ui/loaders/settings", () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...a),
}));
vi.mock("@/lib/ui/loaders/shell", () => ({ envFor: (...a: unknown[]) => envFor(...a) }));
vi.mock("@/app/(app)/settings/actions", () => ({
  updateAppearanceAction: (fd: FormData) => appearanceAction(fd),
  updateRegionAction: vi.fn(),
  updatePreferencesAction: vi.fn(),
  setQuietHoursAction: vi.fn(),
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "inter-var" }),
  JetBrains_Mono: () => ({ variable: "mono-var" }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import AboutPage from "@/app/(app)/settings/about/page";
import AppearancePage from "@/app/(app)/settings/appearance/page";
import RegionPage from "@/app/(app)/settings/region/page";
import { marketRows, toMelbourne } from "@/app/(app)/settings/region";
import RootLayout from "@/app/layout";
import { currentLook } from "@/lib/preferences/current";
import { DEFAULT_PREFERENCES } from "@/lib/preferences/service";
// @ts-expect-error plain ESM script without types
import { buildNotices, licenceAllowed } from "../../scripts/gen-notices.mjs";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES });
  appearanceAction.mockResolvedValue({ ok: true });
});
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 7, email: `${role}@example.test`, name: null, role });

const settingsModel = (role: string) => ({
  state: "ok",
  preferences: { ...DEFAULT_PREFERENCES },
  themes: [],
  quietHours: null,
  markets: [{ code: "AU", mode: "data_only", currency: "AUD", selectable: true }],
  sharing: role === "owner" ? { acknowledgements: 2, lastAt: "2026-10-01T00:00:00.000Z" } : null,
});

describe("Appearance page", () => {
  it.each(["owner", "editor", "viewer"])(
    "renders six theme radios and Motion for %s",
    async (r) => {
      as(r);
      render(await AppearancePage());
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/appearance");
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getAllByRole("radio")).toHaveLength(6);
      expect(screen.getByRole("radio", { name: "Dark (default)" })).toBeChecked();
      expect(screen.getByLabelText("Animation")).toHaveValue("on");
      // The shell's "Appearance: X. Switch to Y." button must stay the only control with that name.
      expect(screen.queryByLabelText("Theme")).toBeNull();
      expect(screen.getByRole("link", { name: "Appearance" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );

  it("shows stored values and submits only theme and motion", async () => {
    as("viewer");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, theme: "high_contrast", motion: "off" });
    render(await AppearancePage());
    expect(screen.getByRole("radio", { name: "High contrast" })).toBeChecked();
    expect(screen.getByLabelText("Animation")).toHaveValue("off");
    fireEvent.click(screen.getByRole("radio", { name: "Midnight" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    const fd = appearanceAction.mock.calls[0][0];
    expect(fd.get("theme")).toBe("midnight");
    expect(fd.get("motion")).toBe("off");
    expect([...fd.keys()].sort()).toEqual(["motion", "theme"]);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });
});

describe("Region & markets page", () => {
  beforeEach(() => {
    envFor.mockImplementation(async () => ({
      now: new Date("2026-10-20T01:00:00Z"),
      main: {
        execute: async () => ({
          rows: [{ code: "AU", tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" }],
        }),
      },
      auth: { execute: async () => ({ rows: [] }) },
    }));
  });

  it("Owner sees every market, the disabled reasons and the sharing summary", async () => {
    as("owner");
    loadSettings.mockResolvedValue(settingsModel("owner"));
    render(await RegionPage());
    expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/region");
    expect(screen.getByLabelText("Open the app in")).toHaveValue("AU");
    expect(screen.getByLabelText("Show times in")).toHaveValue("melbourne");
    expect(screen.getByText(/IN \(disabled\): Not started/)).toBeInTheDocument();
    expect(screen.getByText(/US \(disabled\): Not started/)).toBeInTheDocument();
    expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
      "recorded: 2, latest 2026-10-01",
    );
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getByText("10:00–16:00")).toBeInTheDocument();
    expect(within(table).getByText("Active (collecting data only)")).toBeInTheDocument();
  });

  it("Editor and Viewer see AU only, with no Owner-only fields", async () => {
    for (const r of ["editor", "viewer"]) {
      as(r);
      loadSettings.mockResolvedValue(settingsModel(r));
      const { unmount } = render(await RegionPage());
      expect(screen.queryByTestId("sharing-summary")).toBeNull();
      expect(screen.queryByText(/IN \(disabled\)/)).toBeNull();
      expect(screen.getByText(/markets the Owner has shared/)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("region helpers", () => {
  it("converts exchange hours to Melbourne time on a date (DST edges)", () => {
    expect(toMelbourne("2026-10-20", "10:00", "Australia/Sydney")).toBe("10:00");
    expect(toMelbourne("2026-10-20", "10:00", "Asia/Kolkata")).toBe("15:30");
    // New York is on summer time in October (14 h behind) and standard time in January (16 h).
    expect(toMelbourne("2026-10-20", "09:30", "America/New_York")).toBe("00:30");
    expect(toMelbourne("2027-01-20", "09:30", "America/New_York")).toBe("01:30");
    expect(toMelbourne("bad", "10:00", "Australia/Sydney")).toBeNull();
    expect(toMelbourne("2026-10-20", "10:00", "Not/AZone")).toBeNull();
  });

  it("lists IN and US as not started for the Owner and hides them from others unless shared", () => {
    const model = settingsModel("owner");
    const own = marketRows(model, {}, new Set(), true, "2026-10-20");
    expect(own.map((r) => r.code)).toEqual(["AU", "IN", "US"]);
    expect(own.find((r) => r.code === "IN")).toMatchObject({
      status: "not started",
      selectable: false,
    });
    expect(marketRows(model, {}, new Set(), false, "2026-10-20").map((r) => r.code)).toEqual([
      "AU",
    ]);
    expect(marketRows(model, {}, new Set(["US"]), false, "2026-10-20").map((r) => r.code)).toEqual([
      "AU",
      "US",
    ]);
  });

  it("a market with mode off is paused and cannot be chosen", () => {
    const rows = marketRows(
      { markets: [{ code: "AU", mode: "off", currency: "AUD", selectable: true }] },
      {},
      new Set(),
      true,
      "2026-10-20",
    );
    expect(rows[0]).toMatchObject({ status: "paused", selectable: false });
  });
});

describe("About page and notices", () => {
  it("lists libraries, fonts and the chart attribution for every role", async () => {
    for (const r of ["owner", "editor", "viewer"]) {
      as(r);
      const { unmount } = render(await AboutPage());
      expect(requireUser).toHaveBeenLastCalledWith("read", "/settings/about");
      expect(screen.getByText(/Inter: OFL-1.1/)).toBeInTheDocument();
      expect(screen.getByText(/JetBrains Mono: OFL-1.1/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "tradingview.com" })).toHaveAttribute(
        "href",
        "https://www.tradingview.com/",
      );
      expect(screen.getByTestId("notices-count")).toHaveTextContent(/\d+ packages/);
      unmount();
    }
  });

  it("the committed notices file covers every direct dependency with a licence", async () => {
    const pkg = (await import("../../package.json")).default;
    const notices = (await import("@/generated/notices.json")).default;
    const names = new Set(notices.packages.map((p) => p.name));
    for (const dep of Object.keys(pkg.dependencies)) expect(names.has(dep)).toBe(true);
    for (const p of notices.packages) expect(p.license).not.toBe("UNKNOWN");
  });

  it("builds from a lockfile: production only, sorted, allow-list applied", () => {
    const out = buildNotices({
      packages: {
        "": { name: "x" },
        "node_modules/zeta": { version: "1.0.0", license: "MIT" },
        "node_modules/alpha": { version: "2.0.0", license: "GPL-3.0" },
        "node_modules/a/node_modules/beta": { version: "3.0.0", license: "MIT OR GPL-3.0" },
        "node_modules/devonly": { version: "1.0.0", license: "MIT", dev: true },
      },
    });
    expect(out.packages.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta", "zeta"]);
    expect(out.packages.map((p: { allowed: boolean }) => p.allowed)).toEqual([false, true, true]);
    expect(licenceAllowed("Apache-2.0 AND LGPL-3.0-or-later")).toBe(false);
    expect(licenceAllowed("OFL-1.1")).toBe(true);
    expect(licenceAllowed(undefined)).toBe(false);
  });
});

describe("Motion switch on the root element", () => {
  it("sets data-motion=off only when the user chose Motion off", async () => {
    getCurrentUser.mockResolvedValue({ id: 7 });
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES, motion: "off", theme: "dim" });
    const off = await RootLayout({ children: null });
    expect(off.props["data-motion"]).toBe("off");
    expect(off.props["data-theme"]).toBe("dim");
    getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES });
    expect((await RootLayout({ children: null })).props["data-motion"]).toBeUndefined();
    getCurrentUser.mockResolvedValue(null);
    expect((await RootLayout({ children: null })).props["data-motion"]).toBeUndefined();
  });

  it("currentLook falls back to the defaults on any failure", async () => {
    getCurrentUser.mockRejectedValue(new Error("auth down"));
    expect(await currentLook()).toEqual({ theme: "dark", motion: "on" });
  });
});
