// M23 M4 (D-1643, D-1760...D-1769; CXA-015, CXA-010, CXA-005): the research half of the Cortex page rendered from the rows of the
// e2e seed state `cortex-research`: four sections in plain words, no lineage key and no internal code on the page, proposal counts
// for the Owner alone, a masked viewer's dates as weeks, the meters' special words and a page with nothing stored.
import { cleanup, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { emptyWorld, type Who, type World } from "../loaders/world";
import CortexPage from "@/app/(app)/cortex/page";
import { apply } from "../../e2e/seed/states/cortex-research.mjs";
import { matchPatterns } from "../../scripts/ci/internal-code-patterns.mjs";

let current: World;
let who: Who = "owner";
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({
    id: current.ids[who],
    role: who === "granted" ? "viewer" : who,
  })),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => current.main, authDb: () => current.auth }));
vi.mock("next/navigation", () => ({ usePathname: () => "/cortex" }));

afterAll(cleanupTempDbs);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T23:00:00.000Z"));
});

const SEEDED = "2026-10-16T09:00:00Z";
const ISO = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;
const KEYS = [
  "cxa003_lowvol",
  "cxa003_hi52_vol",
  "cxa003_short_cover",
  "ann_angles",
  "movers_a1",
  "movers_a2",
  "neff_live_F1",
  "llm_proposal_",
  "holdout_look",
  "research_meter",
  "residual_monitor",
];

async function seeded(): Promise<World> {
  const w = await emptyWorld();
  await apply(w.main, SEEDED);
  return w;
}
const show = async (w: World, as: Who) => {
  current = w;
  who = as;
  render(await CortexPage());
};
const section = (id: string) =>
  document.querySelector(`[data-cortex-section=${id}]`) as HTMLElement | null;

describe("the four research sections", () => {
  it("show names, results, the 12-character fingerprint and the refusal count", async () => {
    await show(await seeded(), "owner");
    const t = section("research-tests")!;
    expect(t).not.toBeNull();
    for (const name of [
      "Lowest-volatility stocks",
      "New 52-week high on heavy volume",
      "Falling short positions",
    ])
      expect(within(t).getAllByText(name).length).toBeGreaterThan(0);
    expect(t.textContent).toContain("Pass");
    expect(t.textContent).toContain("Null (no edge found)");
    expect(t.textContent).toContain("Inconclusive");
    expect(t.querySelector("[data-research-inconclusive]")!.textContent).toContain(
      "not enough data to say either way",
    );
    const fps = [...t.querySelectorAll(".font-mono")].map((x) => x.textContent ?? "");
    expect(fps.length).toBeGreaterThan(0);
    for (const f of fps) expect(f).toMatch(/^[0-9a-f]{12}$/);
    // one refused repeat look, on the Pass row
    expect(t.textContent).toMatch(/Repeat looks refused/);
  });

  it("show the waiting rows with n of target, the expected date and the two special words", async () => {
    await show(await seeded(), "owner");
    const w = section("research-waiting")!;
    expect(w.textContent).toContain("Announcement history");
    expect(w.textContent).toContain("14 of 252 sessions collected");
    expect(w.textContent).toMatch(/Expected about (Mon|Tue|Wed|Thu|Fri) /);
    expect(w.textContent).toContain("Waiting for a forward record"); // movers_a2: blocked, n 0
    expect(w.textContent).toContain("the look is waiting for complete events"); // movers_a1: met, no look
    expect(w.textContent).toContain("Live-tested setups, Breakout");
    expect(w.textContent).toContain("Halt-resume block test");
  });

  it("show all eight monitors, the stall alarm in words and the one-regime label", async () => {
    await show(await seeded(), "owner");
    const m = section("research-monitors")!;
    for (let i = 1; i <= 8; i++)
      expect(m.querySelector(`[data-research-monitor="${i}"]`)).not.toBeNull();
    const alarm = m.querySelector("[data-research-alarm]")!.textContent ?? "";
    expect(alarm).toContain("Alarm: ");
    expect(m.textContent).toContain("Trades are stalling more than expected for Breakout");
    expect(m.textContent).toContain("(one regime only)");
    expect(m.textContent).toContain("40.0% stalled against 30.0% expected (from calibration)");
    expect(m.textContent).toContain("Revisit the disagreement rule");
    expect(m.textContent).toContain("Q3 2026");
  });

  it("show the industry-group series with the static industry label", async () => {
    await show(await seeded(), "owner");
    const s = section("research-sector")!;
    expect(s.textContent).toContain("static industry");
    expect(s.textContent).toContain("ZZ Industrials");
    expect(s.textContent).toContain("-0.40%");
  });
});

describe("what each viewer sees", () => {
  it("gives the Owner alone the proposal counts, as counts", async () => {
    await show(await seeded(), "owner");
    expect(document.querySelector("[data-owner-proposals]")!.textContent).toContain(
      "1 kept for your review, 1 refused",
    );
    cleanup();
    for (const as of ["editor", "viewer", "granted"] as const) {
      await show(await seeded(), as);
      expect(document.querySelector("[data-owner-proposals]")).toBeNull();
      expect(section("research-proposals")).toBeNull();
      cleanup();
    }
  });

  it("shows a masked viewer weeks instead of dates in the research sections", async () => {
    await show(await seeded(), "viewer");
    for (const id of [
      "research-tests",
      "research-waiting",
      "research-monitors",
      "research-sector",
    ]) {
      const s = section(id)!;
      expect(s, id).not.toBeNull();
      expect(s.textContent ?? "", id).not.toMatch(ISO);
    }
    expect(section("research-sector")!.textContent).toMatch(/latest session: week \d+/);
  });

  it("never renders a lineage key, a table name or an internal code, for any role", async () => {
    for (const as of ["owner", "editor", "viewer"] as const) {
      await show(await seeded(), as);
      const text = ["research-tests", "research-waiting", "research-monitors", "research-sector"]
        .map((id) => section(id)?.textContent ?? "")
        .join("\n");
      for (const k of KEYS) expect(text, `${as}: ${k}`).not.toContain(k);
      expect(matchPatterns(text), as).toEqual([]);
      cleanup();
    }
  });
});

describe("a page with nothing stored", () => {
  it("lists the four parts as not measured yet and shows no empty table", async () => {
    await show(await emptyWorld(), "owner");
    const missing = document.querySelector("[data-cortex-unmeasured]")!.textContent ?? "";
    for (const m of [
      "Tests and their one look",
      "Waiting for data",
      "Risk monitors",
      "Sector series",
    ])
      expect(missing).toContain(m);
    expect(section("research-tests")).toBeNull();
    expect(section("research-monitors")).toBeNull();
    expect(document.querySelector("[data-owner-proposals]")).toBeNull();
  });
});
