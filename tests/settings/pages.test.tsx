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
vi.mock("next/font/local", () => ({
  default: (o: { variable: string }) => ({ variable: o.variable }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import AboutPage from "@/app/(app)/settings/about/page";
import AppearancePage from "@/app/(app)/settings/appearance/page";
import RegionPage from "@/app/(app)/settings/region/page";
import { marketRows, toMelbourne, type WorkStatus } from "@/app/(app)/settings/region";
import { freshDb } from "../db/helpers";
import RootLayout from "@/app/layout";
import { currentLook } from "@/lib/preferences/current";
import { DEFAULT_PREFERENCES } from "@/lib/preferences/service";
// @ts-expect-error plain ESM script without types
import { approvedExceptions, buildNotices, licenceAllowed } from "../../scripts/gen-notices.mjs";

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
  markets:
    role === "owner"
      ? [
          { code: "AU", mode: "data_only", currency: "AUD", enabled: true, selectable: true },
          { code: "IN", mode: "off", currency: "INR", enabled: false, selectable: false },
          { code: "US", mode: "off", currency: "USD", enabled: false, selectable: false },
        ]
      : [{ code: "AU", mode: "data_only", currency: "AUD", enabled: true, selectable: true }],
  sharing: role === "owner" ? { acknowledgements: 2, lastAt: "2026-10-01T00:00:00.000Z" } : null,
});

describe("Appearance page", () => {
  it.each(["owner", "editor", "viewer"])(
    "renders six theme radios and Motion for %s",
    async (r) => {
      as(r);
      render(await AppearancePage());
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/appearance");
      expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
      expect(screen.getAllByRole("radio")).toHaveLength(6);
      expect(
        screen.getByRole("radio", {
          name: /^Light/, // D-884: default is light
        }),
      ).toBeChecked();
      expect(screen.getByLabelText("Animation")).toHaveValue("on");
      // The header theme toggle is gone (UXR-004); Settings > Appearance is the only place.
      expect(screen.queryByLabelText("Theme")).toBeNull();
      // UXR-002: the selected option is marked by text too, and the stored one says so
      expect(screen.getByText("Current setting")).toBeInTheDocument();
      // the sub-page tabs are gone (UXR-027); the shell breadcrumb leads back to Settings
      expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
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
    expect([...fd.keys()].sort()).toEqual(["motion", "text_size", "theme"]);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });
});

describe("Region & markets page", () => {
  beforeEach(async () => {
    const main = await freshDb("main");
    envFor.mockImplementation(async () => ({
      now: new Date("2026-10-20T01:00:00Z"),
      main,
      auth: { execute: async () => ({ rows: [] }) },
    }));
  });

  it("Owner sees every profile row, the built-off status lines and the sharing summary (D-998)", async () => {
    as("owner");
    loadSettings.mockResolvedValue(settingsModel("owner"));
    render(await RegionPage());
    expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/region");
    expect(screen.getByLabelText("Open the app in")).toHaveValue("AU");
    expect(screen.getByLabelText("Show times in")).toHaveValue("melbourne");
    expect(screen.getByText(/IN \(disabled\): Built — off in production/)).toBeInTheDocument();
    expect(screen.getByText(/US \(disabled\): Built — off in production/)).toBeInTheDocument();
    expect(screen.getByTestId("sharing-summary")).toHaveTextContent(
      "recorded: 2, latest 2026-10-01",
    );
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getByText("10:00–16:00")).toBeInTheDocument();
    expect(within(table).getByText("Active (collecting data only)")).toBeInTheDocument();
    expect(within(table).getAllByText("Built — off in production")).toHaveLength(2);
    expect(within(table).getAllByText("AT-M evidence: not recorded")).toHaveLength(2);
    expect(within(table).getAllByText("Open: Owner approval")).toHaveLength(2);
    expect(within(table).getAllByText("Open: AU 60 trading days (MKT-105)")).toHaveLength(2);
    expect(within(table).getAllByText(/Profile: \d+ of 40 fields verified/)).toHaveLength(3);
    for (const code of ["AU", "IN", "US"]) {
      expect(table.querySelector(`[data-market="${code}"]`)).not.toBeNull();
    }
  });

  it("Editor and Viewer see the enabled market only: no built-off row, no Owner-only fields", async () => {
    for (const r of ["editor", "viewer"]) {
      as(r);
      loadSettings.mockResolvedValue(settingsModel(r));
      const { container, unmount } = render(await RegionPage());
      expect(screen.queryByTestId("sharing-summary")).toBeNull();
      expect(screen.queryByText(/IN \(disabled\)/)).toBeNull();
      expect(screen.queryByText(/Built — off in production/)).toBeNull();
      expect(container.querySelector('[data-market="IN"]')).toBeNull();
      expect(container.querySelector('[data-market="US"]')).toBeNull();
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

  it("the Owner sees every row; others see enabled markets only, shared ones beyond the home market", () => {
    const model = settingsModel("owner");
    const own = marketRows(model, {}, new Set(), true, "2026-10-20");
    expect(own.map((r) => r.code)).toEqual(["AU", "IN", "US"]);
    expect(marketRows(model, {}, new Set(), false, "2026-10-20").map((r) => r.code)).toEqual([
      "AU",
    ]);
    // sharing a market that is not enabled never shows it (D-997)
    expect(marketRows(model, {}, new Set(["US"]), false, "2026-10-20").map((r) => r.code)).toEqual([
      "AU",
    ]);
    const two = {
      markets: [
        ...model.markets.slice(0, 1),
        { code: "IN", mode: "full", currency: "INR", enabled: true, selectable: true },
      ],
    };
    expect(marketRows(two, {}, new Set(), false, "2026-10-20").map((r) => r.code)).toEqual(["AU"]);
    expect(marketRows(two, {}, new Set(["IN"]), false, "2026-10-20").map((r) => r.code)).toEqual([
      "AU",
      "IN",
    ]);
  });

  it("status text follows the stored work status and the mode (D-998)", () => {
    const prof = (workStatus: WorkStatus) => ({
      tz: "Asia/Kolkata",
      open: "09:15",
      close: "15:30",
      exchange: "NSE",
      workStatus,
      evidenceRecordedAt: workStatus === "built" ? "2026-11-12" : null,
      verified: 3,
      total: 40,
    });
    const model = (mode: string) => ({
      markets: [{ code: "IN", mode, currency: "INR", enabled: false, selectable: false }],
    });
    const row = (ws: WorkStatus, mode = "off") =>
      marketRows(model(mode), { IN: prof(ws) }, new Set(), true, "2026-10-20")[0]!;
    expect(row("built")).toMatchObject({
      statusText: "Built — off in production",
      evidence: "AT-M evidence: recorded 2026-11-12",
      profileLine: "Profile: 3 of 40 fields verified",
      selectable: false,
    });
    expect(row("active", "full")).toMatchObject({ statusText: "Active", selectable: false });
    expect(row("active", "off").statusText).toBe("Paused");
    expect(row("in_build").statusText).toBe("In build");
    expect(row("testing").statusText).toBe("Testing");
    expect(row("not_started").statusText).toBe("Not started");
    expect(row("paused").statusText).toBe("Paused");
  });

  it("a market with mode off and no profile is paused and cannot be chosen", () => {
    const rows = marketRows(
      {
        markets: [{ code: "AU", mode: "off", currency: "AUD", enabled: true, selectable: true }],
      },
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
      expect(screen.getByText(/Source Sans 3: OFL-1.1/)).toBeInTheDocument();
      expect(screen.getByText(/Source Serif 4: OFL-1.1/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "tradingview.com" })).toHaveAttribute(
        "href",
        "https://www.tradingview.com/",
      );
      expect(screen.getByTestId("notices-count")).toHaveTextContent(/\d+ packages/);
      // D-173: a short summary first, the package list collapsed, approved exceptions labelled
      for (const h of ["This build", "Data sources", "Fonts and attribution"]) {
        expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
      }
      expect(screen.getByText("Open-source licences").closest("details")).not.toHaveAttribute(
        "open",
      );
      expect(screen.queryAllByText(/needs Owner approval/)).toHaveLength(0);
      expect(screen.getAllByText(/approved by the Owner, 2026-10-21/).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("marks an exception approved only when the Owner approved it (not pending)", () => {
    const approved = approvedExceptions({
      exceptions: [
        { package: "alpha", approvedBy: "Owner", date: "2026-10-21" },
        { package: "gamma", approvedBy: "pending", date: "2026-10-21" },
      ],
    });
    const out = buildNotices(
      {
        packages: {
          "node_modules/alpha": { version: "1.0.0", license: "GPL-3.0" },
          "node_modules/gamma": { version: "1.0.0", license: "GPL-3.0" },
          "node_modules/zeta": { version: "1.0.0", license: "MIT" },
        },
      },
      approved,
    );
    expect(out.packages).toEqual([
      {
        name: "alpha",
        version: "1.0.0",
        license: "GPL-3.0",
        allowed: false,
        approved: "2026-10-21",
      },
      { name: "gamma", version: "1.0.0", license: "GPL-3.0", allowed: false },
      { name: "zeta", version: "1.0.0", license: "MIT", allowed: true },
    ]);
    expect(approvedExceptions(undefined).size).toBe(0);
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
    expect(await currentLook()).toEqual({ theme: "light", motion: "on", text_size: "normal" }); // D-884: default is light
  });
});
