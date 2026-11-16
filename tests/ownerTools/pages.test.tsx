// M21 B1 (UXN-314..317, D-1216..D-1220, AT-77, AT-78; F): the two Owner-tool pages and the pick tile's slot, rendered from
// a real (temporary) database. The guard is mocked to pass (its own tests are in tests/auth/ownerToolsGuard.test.ts and
// tests/ui/pageGuard.test.ts); the Owner's capital and templates are read through `ownerTools(...)`, so the pinned Owner
// and the switch must be real here too.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { ENV } from "../auth/helpers";
import { envOf, fullWorld, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { setConfig } from "@/lib/config/store";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { updatePreferences } from "@/lib/preferences/service";
import { saveHoldings } from "@/lib/ownerTools/holdings";

let world: World;
let env: LoaderEnv;
const owner = { id: 0, email: "owner@example.test", name: null, role: "owner" as const };
vi.mock("@/lib/auth/ownerToolsGuard", () => ({
  requireOwnerTools: vi.fn(async () => owner),
  ownerToolsVisibleTo: vi.fn(async () => true),
}));
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

import RecommendationsPage from "@/app/(app)/(owner-tools)/recommendations/page";
import HoldingsPage from "@/app/(app)/(owner-tools)/holdings/page";
import { pickExtras } from "@/lib/ownerTools/pickExtras";

afterAll(cleanupTempDbs);
afterEach(cleanup);

const TEMPLATE = "https://broker.example/trade?symbol={code}&ex={market}";

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

const setPrefs = async (patch: Record<string, unknown>) => {
  const r = await updatePreferences(
    world.auth,
    process.env,
    undefined,
    { id: world.ids.owner, pinnedOwner: true },
    patch,
  );
  expect(r.ok).toBe(true);
};

describe("/recommendations", () => {
  it("with no amount set: the fixed words, the 'enter an amount' state, no parcel, no link", async () => {
    render(await RecommendationsPage());
    expect(screen.getByTestId("notice").textContent).toBe(
      "Paper-tested ideas, not advice. Place and manage your own orders.",
    );
    expect(screen.getByTestId("enter-amount")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Recommendations/ })).toBeInTheDocument();
    expect(screen.queryAllByTestId("parcel")).toHaveLength(0);
    expect(screen.queryAllByTestId("broker-links")).toHaveLength(0);
    expect(screen.getByTestId("capital-form")).toBeInTheDocument();
    // no password, no token: the only inputs are the amount and the template rows
    expect(document.querySelector("input[type=password]")).toBeNull();
  });

  it("with an amount and a template: Balanced tier, parcels, the concentration line and one link per pick", async () => {
    await setPrefs({ real_capital: 10_000 });
    await setPrefs({ broker_links: [{ name: "My broker", url_template: TEMPLATE }] });
    render(await RecommendationsPage());
    expect(screen.queryByTestId("enter-amount")).toBeNull();
    const tier = document.querySelector('[data-tier="Balanced"]')!;
    expect(tier).not.toBeNull();
    const rows = within(tier as HTMLElement).getAllByTestId("rec-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByTestId("parcel").textContent).toContain("99 shares");
    expect(within(rows[0]!).getByTestId("chance").textContent).toBe("Not enough history yet");
    const link = within(rows[0]!).getByRole("link", { name: "Open in My broker" });
    expect(link.getAttribute("href")).toBe("https://broker.example/trade?symbol=ZZUP&ex=AU");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("concentration").textContent).toBe(
      "Largest sector: Not classified yet, 50 % of the amount",
    );
    // every external link on the page is built from the template, and only that
    const external = [...document.querySelectorAll("a[href^=http]")].map((a) =>
      a.getAttribute("href"),
    );
    expect(external.sort()).toEqual([
      "https://broker.example/trade?symbol=ZZOTH&ex=AU",
      "https://broker.example/trade?symbol=ZZUP&ex=AU",
    ]);
  });

  it("a small amount says 'Too small for a parcel'", async () => {
    await setPrefs({ real_capital: 1_000 });
    render(await RecommendationsPage());
    expect(screen.getAllByTestId("too-small")[0]!.textContent).toBe("Too small for a parcel");
    expect(screen.queryByTestId("concentration")).toBeNull();
  });
});

describe("/holdings", () => {
  it("with nothing saved: the empty state, the form and the disabled screenshot control", async () => {
    render(await HoldingsPage());
    expect(screen.getByTestId("holdings-empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read from a screenshot" })).toBeDisabled();
    expect(screen.getByTestId("ocr-note").textContent).toBe(
      "Not available yet: screenshots are not read in this version",
    );
    expect(screen.getByTestId("holdings-form")).toBeInTheDocument();
  });

  it("lists the current upload with what the app knows, read-only, and the Owner's broker link", async () => {
    await saveHoldings(
      world.main,
      "AU",
      [{ code: "ZZUP", qty: 250, avgCostMicro: 8_500_000n }],
      new Date("2026-10-20T00:00:00.000Z"),
      "aaaaaaaa",
    );
    await setPrefs({ broker_links: [{ name: "My broker", url_template: TEMPLATE }] });
    render(await HoldingsPage());
    const row = screen.getByTestId("holding-row");
    expect(row.textContent).toContain("ZZUP");
    expect(row.textContent).toContain("250 shares");
    expect(within(row).getByTestId("holding-breakers").textContent).toContain("nothing flagged");
    expect(within(row).getByTestId("holding-alerts").textContent).toContain("none");
    expect(within(row).getByTestId("holding-paper").textContent).toContain("not held");
    expect(within(row).getByRole("link", { name: "Open in My broker" }).getAttribute("href")).toBe(
      "https://broker.example/trade?symbol=ZZUP&ex=AU",
    );
    // the edit form carries the saved row
    expect((document.querySelector('input[name="code"]') as HTMLInputElement).value).toBe("ZZUP");
    expect((document.querySelector('input[name="cost"]') as HTMLInputElement).value).toBe("8.5");
  });

  it("a code that is not in the instrument list says the app has no facts for it", async () => {
    await saveHoldings(
      world.main,
      "AU",
      [{ code: "ZZNONE", qty: 1, avgCostMicro: 1_000_000n }],
      new Date("2026-10-21T00:00:00.000Z"),
      "bbbbbbbb",
    );
    render(await HoldingsPage());
    expect(screen.getByTestId("holding-unknown").textContent).toMatch(
      /^Not in the .+ list: the app has no facts for this code.$/,
    );
    expect(screen.queryByTestId("holding-breakers")).toBeNull();
  });

  it("rendering the page changes no table (read-only beside the form)", async () => {
    const before = await tableCounts();
    render(await HoldingsPage());
    cleanup();
    render(await RecommendationsPage());
    expect(await tableCounts()).toEqual(before);
  });
});

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const db of [world.main, world.auth]) {
    const t = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    for (const r of t.rows) {
      const n = String(r.name);
      out[n] = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${n}"`)).rows[0]!.n);
    }
  }
  return out;
}

describe("the pick tile's slot (pickExtras)", () => {
  const user = owner as never;
  it("gives the pinned Owner the tier word and the links, keyed by pick", async () => {
    await setPrefs({ broker_links: [{ name: "My broker", url_template: TEMPLATE }] });
    const m = await pickExtras({
      user,
      market: "AU",
      profile: "aggressive",
      picks: [{ id: "p1", code: "ZZUP" }],
    });
    render(<>{m.get("p1")}</>);
    expect(screen.getByTestId("tier-label").textContent).toBe("Turbo");
    expect(screen.getByRole("link", { name: "Open in My broker" }).getAttribute("href")).toBe(
      "https://broker.example/trade?symbol=ZZUP&ex=AU",
    );
  });

  it("gives nothing when the switch is off (the section answers as a missing route)", async () => {
    await setConfig(world.main, {
      key: "owner_real_money_tools",
      value: "off",
      userId: null,
      reason: "test",
      now: "2026-10-02T00:00:00.000Z",
    });
    invalidateConfigCache();
    const m = await pickExtras({
      user,
      market: "AU",
      profile: "aggressive",
      picks: [{ id: "p1", code: "ZZUP" }],
    });
    expect(m.size).toBe(0);
  });

  it("gives nothing for a user who is not the pinned Owner", async () => {
    await setConfig(world.main, {
      key: "owner_real_money_tools",
      value: "on",
      userId: null,
      reason: "test",
      now: "2026-10-03T00:00:00.000Z",
    });
    invalidateConfigCache();
    const editor = {
      id: world.ids.editor,
      email: "editor@example.test",
      name: null,
      role: "editor",
    };
    const m = await pickExtras({
      user: editor as never,
      market: "AU",
      profile: "aggressive",
      picks: [{ id: "p1", code: "ZZUP" }],
    });
    expect(m.size).toBe(0);
  });
});
