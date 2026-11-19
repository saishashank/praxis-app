// @vitest-environment node
// M23 M4 (D-1760...D-1769): the research half of the Cortex page as data: wording of every monitor, the meters' special
// words, the verdict words (older ones through displayVerdict), the static industry label and the Owner-only proposal counts.
import { afterEach, describe, expect, it } from "vitest";
import {
  INCONCLUSIVE_REASON,
  loadResearchView,
  monitorLines,
  NO_FORWARD_RECORD,
  WAITING_COMPLETE,
} from "@/lib/research/pageView";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { apply } from "../../e2e/seed/states/cortex-research.mjs";

afterEach(cleanupTempDbs);
const when = (d: string) => `on ${d}`;
const NOW = "2026-10-16T09:00:00Z";

describe("monitorLines", () => {
  it("names families through the badge and puts alarms in plain words", () => {
    const stall = monitorLines(
      7,
      {
        families: [
          {
            family: "F1",
            realised_rate: 0.4,
            expected_rate: 0.3,
            expected_source: "shadow, previous four quarters",
            alarm: true,
          },
        ],
      },
      true,
    );
    expect(stall.lines).toEqual([
      "Breakout: 40.0% stalled against 30.0% expected (from earlier quarters).",
    ]);
    expect(stall.alarmLines[0]).toMatch(/^Trades are stalling more than expected for Breakout/);
    const fill = monitorLines(
      8,
      { families: [{ family: "F3", unfilled_share: 0.2, previous_share: 0.1, alarm: true }] },
      true,
    );
    expect(fill.lines[0]).toBe(
      "News drift: 20.0% of setups went unfilled (10.0% the quarter before).",
    );
    expect(fill.alarmLines).toHaveLength(1);
    const one = monitorLines(
      5,
      { families: [{ family: "F2", setups: 30, top_share: 0.93, one_regime_only: true }] },
      false,
    );
    expect(one.lines[0]).toContain("(one regime only)");
    const many = monitorLines(
      5,
      { families: [{ family: "F2", setups: 30, top_share: 0.5, one_regime_only: false }] },
      false,
    );
    expect(many.lines[0]).not.toContain("one regime only");
  });

  it("reads a shape that does not fit as no lines, never a throw", () => {
    for (let m = 1; m <= 8; m++) expect(() => monitorLines(m, "x", false)).not.toThrow();
    expect(monitorLines(7, { families: "nope" }, false)).toEqual({ lines: [], alarmLines: [] });
    expect(
      monitorLines(4, { held_through_unconfirmed: 1, closed_on_stop: 0 }, false).lines[0],
    ).toBe(
      "1 position was held while a company's share change was still unconfirmed; 0 closed on a stop.",
    );
  });
});

describe("loadResearchView", () => {
  it("lists the seeded looks with plain names, results and 12-character fingerprints", async () => {
    const db = await freshDb("main");
    await apply(db, NOW);
    const v = await loadResearchView(db, { market: "AU", when, owner: true });
    expect(v.tests.map((t) => [t.name, t.result])).toEqual(
      expect.arrayContaining([
        ["Lowest-volatility stocks", "Pass"],
        ["New 52-week high on heavy volume", "Null (no edge found)"],
        ["Falling short positions", "Inconclusive"],
      ]),
    );
    for (const t of v.tests) expect(t.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(v.tests.find((t) => t.name === "Lowest-volatility stocks")!.refusals).toBe(1);
    expect(v.inconclusive).toEqual(["Falling short positions"]);
    expect(INCONCLUSIVE_REASON).toMatch(/not enough data/);
  });

  it("maps older verdict words and shows an unmapped one as an older result", async () => {
    const db = await freshDb("main");
    await db.execute(
      "INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('short_shadow','AU','2026-10-01T00:00:00Z','abcdefg','fail'), ('regime_altinputs','AU','2026-10-01T00:00:00Z','abcdefg','weird')",
    );
    const v = await loadResearchView(db, { market: "AU", when, owner: false });
    expect(v.tests.find((t) => t.name === "Short-selling shadow test")!.result).toBe(
      "Null (no edge found)",
    );
    expect(v.tests.find((t) => t.name === "Outside-signal market-state test")!.result).toBe(
      "Older result",
    );
  });

  it("words the meters: collecting with a date, met with no look, blocked with no record", async () => {
    const db = await freshDb("main");
    await apply(db, NOW);
    const v = await loadResearchView(db, { market: "AU", when, owner: false });
    const by = (n: string) => v.waiting.find((w) => w.name === n)!;
    expect(by("Announcement history").progress).toBe("14 of 252 sessions collected");
    expect(by("Announcement history").expected).toMatch(/^Expected about on 20/);
    expect(by("Halt-resume block test").status).toBe(WAITING_COMPLETE);
    expect(by("Results-window entries test").status).toBe(NO_FORWARD_RECORD);
    expect(by("Live-tested setups, Breakout").progress).toBe("12 of 150 independent setups");
    expect(by("Live-tested setups, Breakout").expected).toBeNull();
    // a meter that has no row yet is simply absent
    expect(v.waiting.find((w) => w.name === "Heavily-shorted names test")).toBeUndefined();
  });

  it("says a met mover with a look on file has had its look", async () => {
    const db = await freshDb("main");
    await apply(db, NOW);
    const sha = "f".repeat(64);
    await db.execute({
      sql: "INSERT INTO research_prereg (lineage, market, item, frozen_json, sha, created_at) VALUES ('movers_a1','AU','CXA-014','{}',?,?)",
      args: [sha, NOW],
    });
    await db.execute({
      sql: "INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('movers_a1','AU',?,?,'NULL')",
      args: [NOW, sha],
    });
    const v = await loadResearchView(db, { market: "AU", when, owner: false });
    expect(v.waiting.find((w) => w.name === "Halt-resume block test")!.status).toBe(
      "One look taken",
    );
  });

  it("reads all eight monitors, the calibration row of monitor 2 and the revisit alarm of monitor 6", async () => {
    const db = await freshDb("main");
    await apply(db, NOW);
    const v = await loadResearchView(db, { market: "AU", when, owner: false });
    expect(v.monitors).toHaveLength(8);
    expect(v.monitors.every((m) => m.period !== null)).toBe(true);
    expect(v.monitors[1]!.period).toMatch(/^At calibration, on 20/);
    expect(v.monitors[0]!.period).toBe("Q3 2026");
    expect(v.monitors[5]!.alarm).toBe(true);
    expect(v.monitors[5]!.alarmLines.join(" ")).toContain("Revisit the disagreement rule");
    expect(v.monitors[6]!.alarm).toBe(true);
    expect(v.monitors[0]!.alarm).toBe(false);
  });

  it("labels the sector series static industry and carries only the Owner's proposal counts", async () => {
    const db = await freshDb("main");
    await apply(db, NOW);
    const owner = await loadResearchView(db, { market: "AU", when, owner: true });
    expect(owner.sector!.label).toBe("static industry");
    expect(owner.sector!.rows.map((r) => r.group)).toEqual([
      "ZZ Industrials",
      "ZZ Materials",
      "ZZ Utilities",
    ]);
    expect(owner.proposals).toEqual({ kept: 1, refused: 1 });
    const other = await loadResearchView(db, { market: "AU", when, owner: false });
    expect(other.proposals).toBeNull();
  });

  it("is empty on a fresh database", async () => {
    const db = await freshDb("main");
    const v = await loadResearchView(db, { market: "AU", when, owner: true });
    expect(v.tests).toEqual([]);
    expect(v.waiting).toEqual([]);
    expect(v.sector).toBeNull();
    expect(v.monitors.every((m) => m.period === null)).toBe(true);
  });
});
