// M21 B2 (ARN-121, D-1221, D-1275, AT-77, AT-78): the /trades page and the Owner's link on the alerts report, rendered from
// a real (temporary) database. The guard is mocked to pass (its own tests are in tests/auth/ownerToolsGuard.test.ts and
// tests/ui/pageGuard.test.ts). The world has one Balanced pick ZZUP of 2026-10-19, paper-bought at 10.00 and closed at 10.50
// with a net of 50,000 ppm. The Owner's trades: buy 100 at 10.10 (fees 5.00) on 2026-10-20, sell 100 at 10.40 (fees 5.00)
// on 2026-10-26 -> slippage +1.00 % and -0.95 %, real net 20.00 against paper 50.75, October mean +0.02 %.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { ENV } from "../auth/helpers";
import { envOf, fullWorld, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { setConfig } from "@/lib/config/store";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { appendTrades, voidTrade } from "@/lib/ownerTools/tradeLog/store";

let world: World;
let env: LoaderEnv;
let visible = true;
const owner = { id: 0, email: "owner@example.test", name: null, role: "owner" as const };
vi.mock("@/lib/auth/ownerToolsGuard", () => ({
  requireOwnerTools: vi.fn(async () => owner),
  ownerToolsVisibleTo: vi.fn(async () => visible),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => owner) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => world.main, authDb: () => world.auth }));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => env,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import TradesPage from "@/app/(app)/(owner-tools)/trades/page";
import AlertsReportPage from "@/app/(app)/reviews/alerts/page";

afterAll(cleanupTempDbs);
afterEach(cleanup);

const row = (over: Record<string, unknown> = {}) => ({
  market: "AU",
  code: "ZZUP",
  side: "buy" as const,
  d: "2026-10-20",
  qty: 100,
  priceMicro: 10_100_000n,
  feesMicro: 5_000_000n,
  note: null,
  ...over,
});

beforeAll(async () => {
  Object.assign(process.env, ENV, { OWNER_EMAIL: "owner@example.test" });
  world = await fullWorld();
  owner.id = world.ids.owner;
  env = envOf(world, "owner");
  await setConfig(world.main, {
    key: "owner_real_money_tools",
    value: "on",
    userId: null,
    reason: "test",
    now: "2026-10-01T00:00:00.000Z",
  });
  invalidateConfigCache();
}, 60_000);

describe("/trades", () => {
  it("with nothing logged: the empty states, the form and no credential field", async () => {
    render(await TradesPage());
    expect(screen.getByRole("heading", { name: "Trade log" })).toBeInTheDocument();
    expect(screen.getByTestId("trades-empty")).toBeInTheDocument();
    expect(screen.getByTestId("months-empty")).toBeInTheDocument();
    expect(screen.getByTestId("trades-form")).toBeInTheDocument();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByRole("link", { name: "Holdings" })).toBeInTheDocument();
  });

  it("lists the trades with the paper side, slippage and result, the monthly table, and marks a removed trade", async () => {
    const at = new Date("2026-10-27T00:00:00.000Z");
    await appendTrades(
      world.main,
      [
        row(),
        row({ side: "sell", d: "2026-10-26", priceMicro: 10_400_000n }),
        row({ d: "2026-10-21", note: "entered twice" }),
      ],
      "csv",
      "user:1",
      at,
      "up-1",
    );
    await voidTrade(world.main, 3, "typed twice", at);
    render(await TradesPage());
    const rows = screen.getAllByTestId("trade-row");
    expect(rows).toHaveLength(2);
    // newest first: the sale, then the purchase
    expect(within(rows[0]!).getByTestId("trade-slippage").textContent).toBe(
      "Against paper: -0.95 %",
    );
    expect(within(rows[0]!).getByTestId("trade-paper").textContent).toContain("Paper exit");
    expect(within(rows[0]!).getByTestId("trade-result").textContent).toMatch(
      /\+.*20\.00.*against paper.*\+.*50\.75/,
    );
    expect(within(rows[1]!).getByTestId("trade-slippage").textContent).toBe(
      "Against paper: +1.00 %",
    );
    expect(within(rows[1]!).getByTestId("trade-paper").textContent).toContain("Paper fill");
    const removed = screen.getByTestId("trade-removed");
    expect(removed.textContent).toContain("Removed: typed twice");
    expect(within(removed).queryByTestId("remove-form")).toBeNull();
    const month = screen.getByTestId("month-row");
    expect(month.textContent).toContain("2026-10");
    expect(month.textContent).toContain("+0.02 %");
    // nothing on the page is an internal code or a broker address
    expect(document.querySelector("a[href^=http]")).toBeNull();
    expect(screen.getAllByTestId("remove-form")).toHaveLength(2);
  });
});

describe("the link on the monthly alerts report (D-1221)", () => {
  it("the Owner with the tools on sees a link to /trades; nobody else does", async () => {
    visible = true;
    render(await AlertsReportPage());
    expect(screen.getByTestId("trade-log-link").querySelector("a")!.getAttribute("href")).toBe(
      "/trades",
    );
    cleanup();
    visible = false;
    render(await AlertsReportPage());
    expect(screen.queryByTestId("trade-log-link")).toBeNull();
    expect(document.body.textContent).not.toMatch(/trade log/i);
  });
});
