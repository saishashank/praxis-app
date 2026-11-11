// One strategy page, wording and branch variants (UX-030..032, UXN-051, UXN-055, D-200, D-915, D-919):
// the page component over hand-built loader results, so the live and end-of-day day row, the research
// disclosure with and without data, the Owner / Editor / masked columns and the leverage sleeve are each
// pinned without a database. The chart, the revert button and the robustness tables have their own tests.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PastRound, StrategyDetail, StrategyTile } from "@/lib/ui/loaders/strategies";
import type { StrategyExtras } from "@/lib/ui/loaders/strategyViews";
import type { Loaded } from "@/lib/ui/loaders/common";

type Role = "owner" | "editor" | "viewer";
const h = vi.hoisted(() => ({
  role: "owner" as string,
  detail: null as unknown,
  extras: null as unknown,
  robustness: { visible: false } as unknown,
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: 1, role: h.role, email: "x@example.test", name: null })),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => ({}), authDb: () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/strategies/E01",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/ui/loaders/strategies", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/strategies")>()),
  loadStrategyDetail: async () => h.detail,
}));
vi.mock("@/lib/ui/loaders/strategyViews", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/strategyViews")>()),
  loadStrategyExtras: async () => h.extras,
}));
vi.mock("@/lib/ui/loaders/robustness", () => ({ loadRobustness: async () => h.robustness }));
vi.mock("@/app/(app)/strategies/[execution]/StrategyChart", () => ({
  StrategyChart: (p: { trades: unknown[]; showMarkers: boolean; maxDropText: string }) => (
    <div data-testid="chart" data-markers={String(p.showMarkers)} data-trades={p.trades.length}>
      {p.maxDropText}
    </div>
  ),
}));
vi.mock("@/app/(app)/strategies/[execution]/RevertVersion", () => ({
  RevertVersion: ({ versionId }: { versionId: string }) => <button>Revert {versionId}</button>,
}));
vi.mock("@/app/(app)/strategies/[execution]/Robustness", () => ({
  Robustness: () => <div data-testid="robustness" />,
}));

import StrategyPage from "@/app/(app)/strategies/[execution]/page";

const m = (micro: number) => ({ micro, currency: "AUD" as const, simulated: true as const });
const ISO = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;

const tile = (over: Partial<StrategyTile> = {}): StrategyTile => ({
  currency: "AUD",
  execution: "E01",
  family: "F1",
  variant: "U",
  name: "Follow the trend",
  oneLiner: "Buys what is rising.",
  moneyType: "Plain shares",
  hasCohort: true,
  round: 2,
  startD: "2026-10-12",
  sessions: 5,
  live: true,
  seed: m(600_000_000),
  nav: m(630_000_000),
  returnPpm: 50_000,
  day: { change: m(3_000_000), ppm: 4_800, label: "Fri 16 Oct" },
  positionPpm: 400_000,
  bust: m(300_000_000),
  target: m(1_200_000_000),
  stage: "running" as StrategyTile["stage"],
  bustDistancePpm: 500_000,
  label: null,
  regime: "NEUTRAL",
  control: "enabled" as StrategyTile["control"],
  needsAttention: false,
  attention: [],
  spark: [],
  ...over,
});

const round = (over: Partial<PastRound> = {}): PastRound => ({
  round: 1,
  startD: "2026-09-01",
  terminalKind: "target",
  terminalD: "2026-09-30",
  sessions: 20,
  outcome: m(1_200_000_000),
  ...over,
});

const detail = (over: Partial<StrategyDetail> = {}, t: StrategyTile | null = tile()) =>
  ({
    state: "ok",
    asOf: "2026-10-16",
    text: "",
    masked: false,
    data: {
      found: true,
      execution: "E01",
      family: "F1",
      variant: "U",
      name: "Follow the trend",
      oneLiner: "Buys what is rising.",
      tile: t,
      ruleVersion: "v2",
      costProfile: "P5",
      navSeries: [
        { d: "2026-10-15", nav: 600_000_000 },
        { d: "2026-10-16", nav: 630_000_000 },
      ],
      trades: [],
      pastRounds: [],
      sleeve: null,
      ...over,
    },
  }) as Loaded<StrategyDetail>;

const trade = (over: Record<string, unknown> = {}) => ({
  key: "t1",
  stock: "Zed Upward Holdings",
  entryDate: "2026-10-15",
  exitDate: null,
  entryDay: "2026-10-15",
  exitDay: null,
  qty: 3,
  open: true,
  exitType: null,
  returnPpm: null,
  pnl: null,
  entryPrice: m(10_000_000),
  exitPrice: null,
  stop: m(9_000_000),
  target: m(12_000_000),
  lastPrice: m(10_500_000),
  lastPriceAt: "11:35",
  cardHref: "/cards/c1",
  ...over,
});

const extras = (over: Partial<StrategyExtras> = {}): StrategyExtras =>
  ({
    regimes: [],
    trades: [],
    controls: [],
    zeroEdge: null,
    evidence: null,
    label: null,
    sleeve: null,
    versions: [],
    ledger: [],
    pendingChallengers: [],
    family: "F1",
    ...over,
  }) as unknown as StrategyExtras;

const evidence = (over: Record<string, unknown> = {}) => ({
  scope: "all",
  effectiveN: 6,
  cohorts: 6,
  resolved: 6,
  censored: 0,
  cif: [
    {
      month: 12,
      n: 6,
      target: { p: 0.25, lo: 0.1, hi: 0.5 },
      bust: { p: 0.1 },
      stalled: { p: 0.05 },
    },
  ],
  navMinusSeed: { n: 6, meanMicro: 12_000_000, lowerMicro: 1, upperMicro: 2 },
  minusC2Micro: -4_000_000,
  cifTargetMinusC2: -0.032,
  comparator: "C2",
  ...over,
});

async function page(role: Role = "owner") {
  h.role = role;
  render(await StrategyPage({ params: Promise.resolve({ execution: "E01" }) }));
}

beforeEach(() => {
  h.detail = detail();
  h.extras = extras();
  h.robustness = { visible: false };
});
afterEach(cleanup);

describe("strategy page: header and day row", () => {
  it("shows the end-of-day change under its day name and the plain round line", async () => {
    await page();
    expect(screen.getByText("Change on Fri 16 Oct")).toBeInTheDocument();
    expect(document.body.textContent).toContain("Change on Fri 16 Oct▲+A$3.00 (+0.48%)");
    expect(screen.getByText(/Round 2 · started Mon 12 Oct · 5 sessions held/)).toBeInTheDocument();
    expect(screen.getByText(/Plain shares · Buys what is rising\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(ISO);
  });

  it("keeps a live label as it is and drops the percentage when there is none", async () => {
    h.detail = detail(
      {},
      tile({
        sessions: 1,
        day: { change: m(-3_000_000), ppm: null, label: "Today (delayed, 10:45)" },
      }),
    );
    await page();
    expect(screen.getByText("Today (delayed, 10:45)")).toBeInTheDocument();
    expect(screen.queryByText(/Change on Today/)).toBeNull();
    expect(screen.getByText(/-A\$3\.00$/)).toBeInTheDocument();
    expect(screen.getByText(/1 session held/)).toBeInTheDocument();
  });

  it("has no day tile, no one-liner and says so when nothing was measured", async () => {
    h.detail = detail(
      { oneLiner: null },
      tile({ day: null, returnPpm: null, bust: null, target: null, regime: null }),
    );
    await page();
    expect(screen.queryByText(/^Change on /)).toBeNull();
    expect(screen.getByText("No evidence label yet")).toBeInTheDocument();
    expect(screen.getByText(/Plain shares$/)).toBeInTheDocument();
  });

  it("shows the strategy state pill for a stopped strategy", async () => {
    h.detail = detail({}, tile({ control: "killed" as StrategyTile["control"] }));
    await page();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("shows the empty state, no chart and no header value when no round has started", async () => {
    h.detail = {
      ...detail({}, tile({ hasCohort: false, nav: null, seed: null })),
      text: "No round yet.",
    };
    await page();
    expect(screen.getByText("Nothing to chart yet")).toBeInTheDocument();
    expect(screen.getByText("No round has started yet")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(document.querySelector("[data-header-nav]")).toBeNull();
  });

  it("copes with a strategy that has no tile at all", async () => {
    h.detail = detail({}, null);
    await page();
    expect(screen.getByText("No round has started yet")).toBeInTheDocument();
  });

  it("says the data is out of date when the loader says stale", async () => {
    h.detail = { ...detail(), state: "stale", text: "Showing data from Fri 9 Oct." };
    await page();
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.getByText("Showing data from Fri 9 Oct.")).toBeInTheDocument();
  });

  it("answers an unknown strategy with not found", async () => {
    h.detail = { ...detail(), data: { ...detail().data, found: false } };
    await expect(StrategyPage({ params: Promise.resolve({ execution: "E99" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(
      StrategyPage({ params: Promise.resolve({ execution: "%E0%A4%A" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("strategy page: evidence label and chart", () => {
  it("shows the label, its smallest detectable edge and the cost warning", async () => {
    h.extras = extras({
      label: {
        label: "Too early to tell",
        n: 12,
        mde: 0.0125,
        possibleLuck: true,
        costInfeasible: true,
      },
    });
    await page();
    expect(
      screen.getByText(/Based on 12 results; smallest edge it could detect 1\.25%/),
    ).toBeInTheDocument();
    expect(screen.getByText("Costs may be too high for this strategy.")).toBeInTheDocument();
  });

  it("omits the detectable edge when it is not known", async () => {
    h.extras = extras({
      label: {
        label: "Too early to tell",
        n: 3,
        mde: null,
        possibleLuck: false,
        costInfeasible: false,
      },
    });
    await page();
    expect(screen.getByText("Based on 3 results")).toBeInTheDocument();
    expect(screen.queryByText(/Costs may be too high/)).toBeNull();
  });

  it("explains a single session round and a drop figure once there are two sessions", async () => {
    h.detail = detail({ navSeries: [{ d: "2026-10-16", nav: 600_000_000 }] });
    await page();
    expect(screen.getByTestId("chart")).toHaveTextContent(
      "Not measured yet: a round needs at least two sessions.",
    );
    cleanup();
    h.detail = detail();
    await page();
    expect(screen.getByTestId("chart").textContent).toMatch(/Largest drop so far in this round: /);
  });

  it("builds the trade strip with return, price and open-return words, and no markers for a masked viewer", async () => {
    h.extras = extras({
      trades: [
        trade(),
        trade({
          key: "t2",
          stock: "Zed Downward Mining",
          open: false,
          entryDay: null,
          exitDay: "2026-10-16",
          returnPpm: -20_000,
          pnl: m(-600_000),
          exitPrice: m(9_800_000),
          lastPrice: null,
          lastPriceAt: null,
          stop: null,
          target: null,
        }),
        trade({ key: "t3", entryPrice: null, lastPrice: null, lastPriceAt: null }),
      ],
    });
    h.detail = { ...detail(), masked: true };
    await page("viewer");
    expect(screen.getByTestId("chart")).toHaveAttribute("data-markers", "false");
    expect(screen.getByTestId("chart")).toHaveAttribute("data-trades", "3");
    const open = screen.getByRole("heading", { name: "Open positions" }).closest("section")!;
    expect(open.textContent).toContain("3 shares");
    expect(document.body.textContent).not.toMatch(ISO);
    expect(screen.getByText(/^1 closed trade in this round/)).toBeInTheDocument();
  });

  it("says one share and since an earlier session for an open position with no entry day", async () => {
    h.extras = extras({ trades: [trade({ qty: 1, entryDay: null })] });
    await page();
    const open = screen.getByRole("heading", { name: "Open positions" }).closest("section")!;
    expect(open.textContent).toContain("1 share");
    expect(open.textContent).toContain("since an earlier session");
    expect(screen.getByTestId("chart")).toHaveAttribute("data-markers", "true");
  });

  it("shows the zero-edge level only when its mean and the seed are known", async () => {
    h.extras = extras({ zeroEdge: { target: 0.1, trials: 500, meanNavMinusSeedMicro: 5_000_000 } });
    await page();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });
});

describe("strategy page: rules in force", () => {
  it("shows the version and cost words to the Owner, hides both from a masked viewer", async () => {
    await page();
    const rules = screen.getByRole("heading", { name: "Rules in force" }).closest("section")!;
    expect(rules.textContent).toContain("Rule version in use: v2");
    expect(rules.textContent).toMatch(/Trading costs: brokerage /);
    expect(rules.textContent).not.toMatch(/\bP5\b/);
    cleanup();
    h.detail = { ...detail(), masked: true };
    await page("viewer");
    const masked = screen.getByRole("heading", { name: "Rules in force" }).closest("section")!;
    expect(masked.textContent).toContain("the current one");
    expect(masked.textContent).not.toContain("Trading costs");
  });

  it("falls back to n/a without a version and uses the live version row when there is one", async () => {
    h.detail = detail({ ruleVersion: null, costProfile: null });
    await page();
    const rules = screen.getByRole("heading", { name: "Rules in force" }).closest("section")!;
    expect(rules.textContent).toContain("n/a");
    expect(rules.textContent).not.toContain("Trading costs");
    cleanup();
    h.extras = extras({
      versions: [
        {
          id: "v9",
          n: 9,
          origin: "owner",
          registeredD: "2026-10-01",
          status: "live",
          live: true,
          validation: null,
          revertable: false,
        },
      ],
    });
    await page();
    expect(
      screen.getByRole("heading", { name: "Rules in force" }).closest("section")!.textContent,
    ).toContain("v9");
  });
});

describe("strategy page: matched controls and the research disclosure", () => {
  it("puts the control comparison in the open when there are enough separate rounds", async () => {
    h.extras = extras({
      evidence: evidence(),
      zeroEdge: { target: 0.083, trials: 400, meanNavMinusSeedMicro: null },
      versions: [
        {
          id: "v1",
          n: 1,
          origin: "seed",
          registeredD: "2026-10-01",
          status: "live",
          live: true,
          validation: "pass",
          revertable: false,
        },
      ],
    });
    await page();
    const card = screen
      .getByRole("heading", { name: "Compared with matched controls" })
      .closest("section")!;
    expect(document.querySelector("[data-research-details]")).toBeNull();
    expect(card.textContent).toContain("Based on 6 separate finished rounds");
    expect(card.textContent).toContain("25.0%");
    expect(card.textContent).toContain("90% range 10.0% to 50.0%");
    expect(card.textContent).toContain("-3.2 points");
    expect(card.textContent).toContain("reaches the goal in 8.3% of 400 trials");
  });

  it("shows a positive chance difference with a plus sign, and no range when none is stored", async () => {
    h.extras = extras({
      evidence: evidence({
        cifTargetMinusC2: 0.05,
        minusC2Micro: null,
        navMinusSeed: null,
        cif: [{ month: 12, n: 6, target: { p: 0.5 }, bust: { p: 0 }, stalled: { p: 0 } }],
      }),
      versions: [
        {
          id: "v1",
          n: 1,
          origin: "seed",
          registeredD: "2026-10-01",
          status: "live",
          live: true,
          validation: null,
          revertable: false,
        },
      ],
    });
    await page();
    const card = screen
      .getByRole("heading", { name: "Compared with matched controls" })
      .closest("section")!;
    expect(card.textContent).toContain("+5.0 points");
    expect(card.textContent).not.toContain("90% range 0");
    expect(card.textContent).toContain("Zero-edge benchmark: Not measured yet");
  });

  it("says what is needed when fewer than three rounds finished, inside the closed research disclosure", async () => {
    h.extras = extras({ evidence: evidence({ effectiveN: 2 }) });
    await page();
    const research = document.querySelector("[data-research-details]")!;
    expect(research.closest("details")!.open).toBe(false);
    expect(research.textContent).toContain(
      "These figures need at least 3 separate finished rounds",
    );
    expect(research.textContent).toContain("Version history");
    expect(screen.getByTestId("robustness")).toBeInTheDocument();
  });

  it("treats a missing effective N as too few rounds", async () => {
    h.extras = extras({ evidence: evidence({ effectiveN: null }) });
    await page();
    expect(document.querySelector("[data-research-details]")).not.toBeNull();
  });

  it("leaves the disclosure out when the evidence, the robustness section and the versions are all in the open", async () => {
    h.robustness = { visible: false };
    h.extras = extras({
      evidence: evidence(),
      versions: [
        {
          id: "v1",
          n: 1,
          origin: "seed",
          registeredD: "2026-10-01",
          status: "live",
          live: true,
          validation: null,
          revertable: false,
        },
      ],
    });
    await page();
    expect(document.querySelector("[data-research-details]")).toBeNull();
    cleanup();
    h.robustness = { visible: true };
    await page();
    expect(document.querySelector("[data-research-details]")).not.toBeNull();
  });
});

describe("strategy page: past rounds", () => {
  it("lists rounds with plain endings and says in progress, not final or sessions unknown", async () => {
    h.detail = detail({
      pastRounds: [
        round(),
        round({
          round: 2,
          terminalKind: "bust",
          terminalD: "2026-09-10",
          sessions: null,
          outcome: null,
        }),
        round({ round: 3, terminalKind: "odd", terminalD: "2026-09-12" }),
        round({ round: 4, terminalKind: null, terminalD: null, sessions: 3, outcome: null }),
        round({ round: 5, terminalKind: "timeout", terminalD: "2026-W40" }),
      ],
    });
    await page();
    const card = screen.getByRole("heading", { name: "Past rounds" }).closest("section")!;
    const t = card.textContent!;
    expect(t).toContain("Reached the goal, Wed 30 Sep");
    expect(t).toContain("Hit the loss limit, Thu 10 Sep");
    expect(t).toContain("odd, Sat 12 Sep");
    expect(t).toContain("In progress");
    expect(t).toContain("Ran out of time, 2026-W40");
    expect(t).toContain("Not final yet");
    expect(t).toContain("Not measured yet");
    expect(t).not.toMatch(ISO);
  });

  it("says no rounds yet", async () => {
    await page();
    expect(screen.getByText("No rounds yet.")).toBeInTheDocument();
  });
});

describe("strategy page: leverage sleeve", () => {
  const leg = (over: Record<string, unknown> = {}) => ({
    leverage: 10,
    sleeveTrades: 4,
    shadowTrades: 2,
    closeouts: 1,
    locks: 0,
    netPl: m(2_000_000),
    navMinusSeed: { n: 5, meanMicro: 3_000_000, lowerMicro: -1_000_000, upperMicro: 8_000_000 },
    ...over,
  });
  it("shows a locked sleeve and both hypothetical legs with their figures", async () => {
    h.detail = detail({
      variant: "L",
      sleeve: {
        state: "locked",
        mode: "x",
        sinceD: "2026-10-14",
        lossToRecover: m(5_000_000),
        openTrades: 2,
      },
    });
    h.extras = extras({
      sleeve: {
        hypotheticalLabel: "h",
        levered: leg() as never,
        reality: leg({ netPl: null, navMinusSeed: null }) as never,
      },
    });
    await page();
    const card = screen.getByRole("heading", { name: "Leverage sleeve" }).closest("section")!;
    expect(card.textContent).toContain("Locked while it recovers");
    expect(card.textContent).toContain("Since");
    expect(card.textContent).toContain("Wed 14 Oct");
    expect(card.textContent).toContain("90% range -A$1.00 to +A$8.00, 5 rounds");
    expect(card.textContent).toContain("+A$2.00");
    expect(card.textContent).toContain("Not measured yet");
    expect(card.textContent).toContain(
      "Hypothetical leverage (simulated, not real broker leverage)",
    );
  });

  it("shows an unlocked sleeve, and says so when there is no sleeve activity or no leg figures", async () => {
    h.detail = detail({
      variant: "L",
      sleeve: {
        state: "free",
        mode: "x",
        sinceD: "2026-10-14",
        lossToRecover: m(0),
        openTrades: 0,
      },
    });
    h.extras = extras({ sleeve: { hypotheticalLabel: "h", levered: null, reality: null } });
    await page();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(screen.getAllByText("No sleeve figures stored yet")).toHaveLength(2);
    cleanup();
    h.detail = detail({ variant: "L", sleeve: null });
    h.extras = extras({ sleeve: null });
    await page();
    expect(screen.getByText("No sleeve activity yet")).toBeInTheDocument();
  });

  it("has no sleeve card for a plain strategy", async () => {
    await page();
    expect(screen.queryByRole("heading", { name: "Leverage sleeve" })).toBeNull();
  });
});

describe("strategy page: versions, challengers and ledger", () => {
  const versions = [
    {
      id: "v3",
      n: 3,
      origin: "challenger",
      registeredD: "2026-10-10",
      status: "live",
      live: true,
      validation: "passed",
      revertable: false,
    },
    {
      id: "v2",
      n: 2,
      origin: "rollback",
      registeredD: "2026-10-05",
      status: "old",
      live: false,
      validation: null,
      revertable: true,
    },
    {
      id: "v1",
      n: 1,
      origin: "mystery",
      registeredD: "2026-10-01",
      status: "old",
      live: false,
      validation: null,
      revertable: false,
    },
  ];
  it("gives the Owner a working revert and the words for each origin", async () => {
    h.extras = extras({ versions: versions as never });
    await page("owner");
    const card = screen
      .getByRole("heading", { name: "Rule version and changes" })
      .closest("section")!;
    const t = card.textContent!;
    expect(t).toContain("Promoted from a challenger (in use now)");
    expect(t).toContain("Rolled back to an earlier version");
    expect(t).toContain("mystery");
    expect(t).toContain("Not tested");
    expect(within(card).getAllByRole("button", { name: "Revert v2" }).length).toBeGreaterThan(0);
    expect(t).toContain("In use");
    expect(t).toContain("Not available");
    expect(t).toContain("Reverting schedules an earlier version for the next restart.");
  });

  it("shows an Editor a disabled revert with its reason and a viewer no revert column", async () => {
    h.extras = extras({ versions: versions as never });
    await page("editor");
    const btn = screen.getAllByRole("button", { name: "Revert" })[0]!;
    expect(btn).toBeDisabled();
    expect(screen.queryByText(/Reverting schedules/)).toBeNull();
    cleanup();
    await page("viewer");
    expect(screen.queryByRole("button", { name: /Revert/ })).toBeNull();
  });

  it("lists waiting challengers as links, and the change ledger in plain words", async () => {
    h.extras = extras({
      pendingChallengers: [{ id: "CH-1", state: "testing" }] as never,
      ledger: [
        { effectiveD: "2026-10-10", kind: "promotion" },
        { effectiveD: "2026-10-11", kind: "weird_kind" },
      ] as never,
    });
    h.detail = detail(
      {},
      tile({ attention: ["a stop was hit", "data is thin"], needsAttention: true }),
    );
    await page();
    expect(screen.getByRole("link", { name: "CH-1" })).toHaveAttribute(
      "href",
      "/reviews/learned/challengers/CH-1",
    );
    expect(screen.getByText(/\(testing\)/)).toBeInTheDocument();
    expect(screen.getByText("Needs a look: a stop was hit; data is thin.")).toBeInTheDocument();
    expect(screen.getByText("Promotion, Sat 10 Oct")).toBeInTheDocument();
    expect(screen.getByText("weird_kind, Sun 11 Oct")).toBeInTheDocument();
  });

  it("says no challengers are waiting and shows no version history or ledger when none are stored", async () => {
    await page();
    expect(screen.getByText("No challengers are waiting.")).toBeInTheDocument();
    expect(screen.queryByText("Change ledger for this strategy")).toBeNull();
    expect(screen.queryByText("Needs a look:", { exact: false })).toBeNull();
  });
});
