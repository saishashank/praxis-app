// M20 S1 (AT-71, UXN-312, MKT-111, D-997): the Owner's switch-on card on Settings > Region. The Owner sees the
// checklist with each item's evidence, the projection and the control; the control is disabled while any item of the
// next step is open and names the open items; the rollback asks for a reason; Editors and Viewers see nothing of it.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const getPrefs = vi.hoisted(() => vi.fn());
const loadSettings = vi.hoisted(() => vi.fn());
const envFor = vi.hoisted(() => vi.fn());
const switchAction = vi.hoisted(() => vi.fn<(fd: FormData) => Promise<unknown>>());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/db/client", () => ({ authDb: () => ({}), mainDb: () => ({}) }));
vi.mock("@/lib/preferences/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/preferences/service")>()),
  getPreferences: (...a: unknown[]) => getPrefs(...a),
}));
vi.mock("@/lib/ui/loaders/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/settings")>()),
  loadSettings: (...a: unknown[]) => loadSettings(...a),
}));
vi.mock("@/lib/ui/loaders/shell", () => ({ envFor: (...a: unknown[]) => envFor(...a) }));
vi.mock("@/app/(app)/settings/actions", () => ({
  updateRegionAction: vi.fn(),
  updatePreferencesAction: vi.fn(),
  updateAppearanceAction: vi.fn(),
  setQuietHoursAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/region/actions", () => ({
  switchMarketAction: (fd: FormData) => switchAction(fd),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));

import RegionPage from "@/app/(app)/settings/region/page";
import { MarketSwitch } from "@/app/(app)/settings/region/MarketSwitch";
import { loadMarketSwitch, type SwitchMarketModel } from "@/lib/ui/loaders/settings";
import { DEFAULT_PREFERENCES } from "@/lib/preferences/service";
import { invalidateProfiles } from "@/lib/market/profile";
import { allowMarket, freshDb } from "../db/helpers";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  invalidateProfiles();
  getPrefs.mockResolvedValue({ ...DEFAULT_PREFERENCES });
  switchAction.mockResolvedValue({ ok: true, changed: true });
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
          { code: "AU", mode: "full", currency: "AUD", enabled: true, selectable: true },
          { code: "IN", mode: "off", currency: "INR", enabled: false, selectable: false },
          { code: "US", mode: "off", currency: "USD", enabled: false, selectable: false },
        ]
      : [{ code: "AU", mode: "full", currency: "AUD", enabled: true, selectable: true }],
  sharing: null,
});

const verdicts = [
  {
    metric: "turso_reads",
    label: "Turso rows read",
    total: 40_000_000,
    limit: 100_000_000,
    sharePct: 8,
    ok: true,
  },
  {
    metric: "turso_writes",
    label: "Turso rows written",
    total: 2_100_000,
    limit: 2_000_000,
    sharePct: 21,
    ok: false,
  },
] as never;

const model = (over: Partial<SwitchMarketModel> = {}): SwitchMarketModel => ({
  code: "IN",
  name: "India (NSE)",
  mode: "off",
  enabled: false,
  rollbackPending: false,
  next: "data_only",
  items: [
    {
      id: "profile_complete",
      ok: true,
      text: "Profile complete: 40 of 40 fields verified.",
      evidence: "/settings/region",
    },
    {
      id: "at_m_evidence",
      ok: false,
      text: "AT-M evidence not recorded.",
      evidence: "docs/test-reports/AT-M-IN.md",
    },
    {
      id: "licence_rows",
      ok: false,
      text: "9 of 18 source rows are pending: in_nse_bhavcopy.",
      evidence: "docs/source-licence-register.md",
    },
    { id: "quota_projection", ok: true, text: "fits", evidence: "/usage#projection" },
    { id: "au_mkt105", ok: false, text: "AU does not meet MKT-105 yet.", evidence: "/health" },
  ],
  complete: false,
  projection: { fits: false, verdicts },
  projectionNote: null,
  canRollback: false,
  ...over,
});

const ok = (m: SwitchMarketModel) => ({
  ...m,
  items: m.items.map((i) => ({ ...i, ok: true })),
  complete: true,
});

describe("MarketSwitch (the card)", () => {
  it("shows each item with its state and evidence, the projection, and a DISABLED button naming the open items", () => {
    render(<MarketSwitch markets={[model()]} action={switchAction} />);
    const card = screen.getByTestId("market-switch");
    const block = card.querySelector('[data-market="IN"]')!;
    expect(block.getAttribute("data-mode")).toBe("off");
    const items = [...block.querySelectorAll("[data-item]")];
    expect(items.map((i) => [i.getAttribute("data-item"), i.getAttribute("data-ok")])).toEqual([
      ["profile_complete", "1"],
      ["at_m_evidence", "0"],
      ["licence_rows", "0"],
      ["quota_projection", "1"],
      ["au_mkt105", "0"],
    ]);
    // an app path is a link, a repository path is text
    expect(
      within(block as HTMLElement).getAllByRole("link", { name: "Evidence" }).length,
    ).toBeGreaterThan(0);
    expect(
      within(block as HTMLElement).getByText("docs/test-reports/AT-M-IN.md"),
    ).toBeInTheDocument();
    // the projection figures
    expect(screen.getByTestId("projection-lines")).toHaveTextContent("does not fit");
    expect(card.querySelector('[data-metric="turso_writes"]')!.getAttribute("data-ok")).toBe("0");
    // the control is disabled and the reason is stated
    const btn = within(block as HTMLElement).getByRole("button", { name: "Switch on (data only)" });
    expect(btn).toBeDisabled();
    expect(screen.getByTestId("open-items")).toHaveTextContent(
      "3 items open (at_m_evidence, licence_rows, au_mkt105)",
    );
    // nothing can be sent while it is disabled
    fireEvent.click(btn);
    expect(switchAction).not.toHaveBeenCalled();
  });

  it("with every item done the control opens a confirmation and sends market, step and reason", async () => {
    render(<MarketSwitch markets={[ok(model())]} action={switchAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch on (data only)" }));
    const panel = screen.getByRole("group", { name: /Confirm: Switch on/ });
    fireEvent.change(within(panel).getByLabelText("Reason (optional)"), {
      target: { value: "India first" },
    });
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Confirm" })));
    const fd = switchAction.mock.calls[0]![0];
    expect(Object.fromEntries(fd.entries())).toEqual({
      market: "IN",
      to: "data_only",
      reason: "India first",
    });
  });

  it("the second step is labelled for full and offered only from data_only", () => {
    render(
      <MarketSwitch
        markets={[ok(model({ mode: "data_only", enabled: true, next: "full", canRollback: true }))]}
        action={switchAction}
      />,
    );
    expect(screen.getByRole("button", { name: "Switch to full" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Roll back to off" })).toBeInTheDocument();
  });

  it("the rollback asks for a reason (required) and sends the market and off", async () => {
    render(
      <MarketSwitch
        markets={[
          model({
            mode: "full",
            enabled: true,
            next: null,
            items: [],
            complete: false,
            canRollback: true,
          }),
        ]}
        action={switchAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Roll back to off" }));
    const panel = screen.getByRole("group", { name: /Confirm: Roll back to off/ });
    const reason = within(panel).getByLabelText("Reason (required)");
    expect(reason).toBeRequired();
    expect(panel).toHaveTextContent("closed at the next open");
    fireEvent.change(reason, { target: { value: "feed unreliable" } });
    await act(async () =>
      fireEvent.click(within(panel).getByRole("button", { name: "Roll back" })),
    );
    expect(Object.fromEntries(switchAction.mock.calls[0]![0].entries())).toEqual({
      market: "IN",
      to: "off",
      reason: "feed unreliable",
    });
  });

  it("a refusal is shown in words", async () => {
    switchAction.mockResolvedValue({ error: "checklist_open" });
    render(<MarketSwitch markets={[ok(model())]} action={switchAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch on (data only)" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("checklist still has open items");
  });

  it("during a rollback it says so and offers no control", () => {
    render(
      <MarketSwitch
        markets={[
          model({
            mode: "off",
            enabled: true,
            rollbackPending: true,
            next: null,
            items: [],
            canRollback: false,
          }),
        ]}
        action={switchAction}
      />,
    );
    expect(screen.getByTestId("rollback-pending")).toHaveTextContent("Rollback in progress");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<MarketSwitch markets={[]} action={switchAction} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("loadMarketSwitch (the Owner's model, from the database)", () => {
  const envOf = async (role: string) => {
    const main = await freshDb("main");
    return {
      env: {
        now: new Date("2026-11-20T02:00:00Z"),
        main,
        auth: {},
        user: { id: 1, role },
      } as never,
      main,
    };
  };

  it("is null for an Editor and a Viewer (D-997)", async () => {
    for (const role of ["editor", "viewer"])
      expect(await loadMarketSwitch((await envOf(role)).env)).toBeNull();
  });

  it("lists IN and US as off with the five items of the first step, none complete on the production seed", async () => {
    const m = (await loadMarketSwitch((await envOf("owner")).env))!;
    expect(m.map((x) => x.code)).toEqual(["IN", "US"]);
    for (const x of m) {
      expect([x.mode, x.enabled, x.next, x.complete, x.canRollback, x.rollbackPending]).toEqual([
        "off",
        false,
        "data_only",
        false,
        false,
        false,
      ]);
      expect(x.items.map((i) => i.id)).toEqual([
        "profile_complete",
        "at_m_evidence",
        "licence_rows",
        "quota_projection",
        "au_mkt105",
      ]);
      expect(x.items.filter((i) => !i.ok).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("a market in data_only offers the second step (seven items) and the rollback; during a rollback neither", async () => {
    const { env, main } = await envOf("owner");
    await allowMarket(main, "IN");
    await main.execute(
      "UPDATE market SET mode = 'data_only', data_only_since = '2026-11-10' WHERE code = 'IN'",
    );
    const m = (await loadMarketSwitch(env))!.find((x) => x.code === "IN")!;
    expect([m.mode, m.next, m.canRollback]).toEqual(["data_only", "full", true]);
    expect(m.items).toHaveLength(7);
    await main.execute(
      "UPDATE market SET mode = 'off', rollback_at = '2026-11-19T00:00:00Z' WHERE code = 'IN'",
    );
    const p = (await loadMarketSwitch(env))!.find((x) => x.code === "IN")!;
    expect([p.rollbackPending, p.next, p.canRollback, p.items]).toEqual([true, null, false, []]);
  });
});

describe("Region & markets page", () => {
  beforeEach(async () => {
    const main = await freshDb("main");
    envFor.mockImplementation(async () => ({
      now: new Date("2026-11-20T02:00:00Z"),
      main,
      auth: { execute: async () => ({ rows: [] }) },
      user: { id: 7, role: requireUser.mock.results[0] ? "owner" : "owner" },
    }));
  });

  it("the Owner sees the switch-on card under the table", async () => {
    as("owner");
    loadSettings.mockResolvedValue(settingsModel("owner"));
    envFor.mockImplementation(async () => ({
      now: new Date("2026-11-20T02:00:00Z"),
      main: await freshDb("main"),
      auth: { execute: async () => ({ rows: [] }) },
      user: { id: 7, role: "owner" },
    }));
    render(await RegionPage());
    const card = screen.getByTestId("market-switch");
    expect(card.querySelectorAll("[data-market]")).toHaveLength(2);
    expect(within(card).getAllByRole("button", { name: "Switch on (data only)" })).toHaveLength(2);
    for (const b of within(card).getAllByRole("button", { name: "Switch on (data only)" }))
      expect(b).toBeDisabled();
  });

  it.each(["editor", "viewer"])("%s: no switch card, no checklist, no control", async (role) => {
    as(role);
    loadSettings.mockResolvedValue(settingsModel(role));
    envFor.mockImplementation(async () => ({
      now: new Date("2026-11-20T02:00:00Z"),
      main: await freshDb("main"),
      auth: { execute: async () => ({ rows: [] }) },
      user: { id: 7, role },
    }));
    const { container } = render(await RegionPage());
    expect(screen.queryByTestId("market-switch")).toBeNull();
    expect(container.querySelector("[data-item]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch on|Roll back|Switch to full/ })).toBeNull();
  });
});
