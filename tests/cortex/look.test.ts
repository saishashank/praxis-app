// @vitest-environment node
// V2-S1 (D-700…D-702): the quarterly live look. CTX-053 is re-evaluated in the app from live would-have
// outcomes; on today's data (no live sample) every family stays shadow and nothing is written; a family
// moves only through recordFamilyStatus and only when the rules pass; an Owner kill is left alone; a look
// is charged once per family per quarter. Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  lookCellId,
  lookAtFamily,
  previousQuarter,
  quarterBounds,
  quarterOf,
  runStatusLooks,
} from "@/lib/cortex/look";
import {
  cellsOfKind,
  familyStatusHistory,
  familyStatusMap,
  insertDecision,
  insertFamilyStatus,
  insertMap,
  insertOutcome,
  type CortexFamily,
} from "@/lib/cortex/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const M = "AU";
const NOW = "2027-01-04T01:00:00.000Z";
const D = "2027-01-04"; // first night of 2027Q1: the look covers 2026Q4

const dayN = (i: number): string =>
  new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10);

async function addMap(db: Client, family: CortexFamily, top3: number): Promise<void> {
  await insertMap(db, {
    market: M,
    family,
    ruleVersion: "v1",
    fittedAt: "2026-09-30T00:00:00.000Z",
    params: {
      a: 0,
      b: 1,
      s_mean: 0,
      s_sd: 1,
      K: 3,
      clusters: ["momentum"],
      top3_min_s: top3,
    } as never,
    activeSetHash: "h",
    nEff: 500,
    pool: "ZZ",
    fitSplit: "development",
  });
}

/** n filled would-have cases on distinct sessions from 2026-10-01; `net(i)` decides the result. */
async function addCases(
  db: Client,
  family: CortexFamily,
  n: number,
  f: (i: number) => { s: number; p: number | null; net: number; regime?: string },
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const x = f(i);
    const d = dayN(i % 85); // inside 2026Q4
    const code = `ZZ${i}`;
    await insertDecision(db, {
      market: M,
      d,
      bookId: `book:${family}`,
      code,
      arm: "shadow",
      family,
      s: x.s,
      p: x.p,
      expectedNetMicro: null,
      rankKey: null,
      limitMicro: 1_000_000,
      stopMicro: 900_000,
      qty: 1000,
      gateTrace: [{ gateId: "G09_regime", pass: true, value: x.regime ?? "RISK_ON" }],
      firstFailGate: null,
      signalId: null,
      orderId: null,
      cardId: null,
      sectorTilt: null,
      manifestId: "m",
    });
    await insertOutcome(db, {
      market: M,
      d,
      bookId: `book:${family}`,
      code,
      arm: "shadow",
      fillStatus: "filled",
      fillMicro: 1_000_000,
      fillD: d,
      exitD: d,
      exitRule: "level",
      grossMicro: x.net,
      netMicro: x.net,
      outcomeClass: x.net > 0 ? "win" : "loss",
      scoredAt: NOW,
    });
  }
}

describe("quarter arithmetic", () => {
  it("labels, bounds and the quarter before", () => {
    expect(quarterOf("2027-01-04")).toBe("2027Q1");
    expect(quarterOf("2026-12-31")).toBe("2026Q4");
    expect(quarterBounds("2026Q4")).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(previousQuarter("2027-01-04")).toBe("2026Q4");
    expect(previousQuarter("2026-10-01")).toBe("2026Q3");
  });
});

// R3-I4 (D-820): database-backed and bounded by the 30 s test timeout, so it is a timing-sensitive lane: one retry in CI only.
describe("[timing] the live look (CTX-053 in the app)", { retry: process.env.CI ? 1 : 0 }, () => {
  it("on today's data (no live outcomes) nothing is written and every family stays shadow", async () => {
    const db = await freshDb("main");
    const r = await runStatusLooks(db, { market: M, d: D, now: NOW });
    expect(r.map((x) => x.family)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    expect(r.every((x) => x.outcome === "skipped")).toBe(true);
    expect((await db.execute("SELECT COUNT(*) AS n FROM cortex_ledger_cell")).rows[0]!.n).toBe(0);
    expect((await db.execute("SELECT COUNT(*) AS n FROM family_status")).rows[0]!.n).toBe(0);
    expect(Object.values(await familyStatusMap(db, M, D)).every((s) => s === "shadow")).toBe(true);
  });

  it("a thin live sample is recorded as a charged, inconclusive look and writes no status row", async () => {
    const db = await freshDb("main");
    await addCases(db, "F1", 10, (i) => ({ s: 1 + i, p: 0.6, net: 5_000 }));
    const r = await lookAtFamily(db, {
      market: M,
      family: "F1",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(r).toMatchObject({ outcome: "inconclusive", nFilled: 10 });
    const cells = await cellsOfKind(db, M, "F1", "status_look");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cellId).toBe(lookCellId(M, "F1", "2026Q4"));
    expect(cells[0]!.result).toMatchObject({ outcome: "inconclusive", n_filled: 10 });
    expect(cells[0]!.loggedAt < cells[0]!.resultAt!).toBe(true);
    expect((await db.execute("SELECT COUNT(*) AS n FROM family_status")).rows[0]!.n).toBe(0);
    // a repeat of the night charges nothing more
    const again = await lookAtFamily(db, {
      market: M,
      family: "F1",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(again.outcome).toBe("skipped");
    expect(await cellsOfKind(db, M, "F1", "status_look")).toHaveLength(1);
  });

  it("a losing live sample is evaluated, stays shadow, and is recorded with its n_eff_live", async () => {
    const db = await freshDb("main");
    await addMap(db, "F1", 50);
    await addCases(db, "F1", 120, (i) => ({
      s: i % 100,
      p: 0.7,
      net: i % 3 === 0 ? 4_000 : -9_000,
    }));
    const r = await lookAtFamily(db, {
      market: M,
      family: "F1",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(r.outcome).toBe("evaluated");
    expect(r.failed.length).toBeGreaterThan(0);
    expect(r.record).toMatchObject({ written: true, status: "shadow" });
    const hist = await familyStatusHistory(db, M, "F1");
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ status: "shadow", setBy: "evaluator", sinceD: D });
    expect(hist[0]!.evidence).toMatchObject({
      source: "live_look",
      quarter: "2026Q4",
      n_filled: 120,
    });
    const cell = (await cellsOfKind(db, M, "F1", "status_look"))[0]!;
    expect(cell.result).toMatchObject({ outcome: "evaluated", status: "shadow", n_filled: 120 });
    expect(cell.result).toHaveProperty("n_eff_live");
  });

  it("no map threshold means no pooled cell: the economic gate fails and the family cannot be allowed", async () => {
    const db = await freshDb("main");
    // wins everywhere, p well calibrated: only the missing top-3 threshold keeps it out
    await addCases(db, "F4", 400, (i) => ({
      s: i,
      p: i % 2 === 0 ? 0.9 : 0.1,
      net: i % 2 === 0 ? 20_000 : -1,
    }));
    const r = await lookAtFamily(db, {
      market: M,
      family: "F4",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(r.outcome).toBe("evaluated");
    expect(r.failed).toContain("economic_gate:not_enough_history");
    expect((await familyStatusMap(db, M, D)).F4).toBe("shadow");
  });

  it("an Owner kill is left alone", async () => {
    const db = await freshDb("main");
    await insertFamilyStatus(db, {
      market: M,
      family: "F1",
      sinceD: "2026-12-01",
      status: "suspended",
      evidence: { by: "owner" },
      statementId: null,
      setBy: "owner_kill",
    });
    await addCases(db, "F1", 80, (i) => ({ s: i, p: 0.6, net: -1_000 }));
    const r = await lookAtFamily(db, {
      market: M,
      family: "F1",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(r.record).toEqual({ written: false, reason: "suspended" });
    expect((await familyStatusMap(db, M, D)).F1).toBe("suspended");
  });

  it("an allowed family is not demoted by a live sample that is merely too thin to test it", async () => {
    const db = await freshDb("main");
    await insertFamilyStatus(db, {
      market: M,
      family: "F1",
      sinceD: "2026-11-01",
      status: "allowed",
      evidence: { by: "import" },
      statementId: null,
      setBy: "import",
    });
    await addMap(db, "F1", 50);
    await addCases(db, "F1", 70, (i) => ({
      s: 20 + i,
      p: 0.55,
      net: i % 2 === 0 ? 6_000 : -5_000,
    }));
    const r = await lookAtFamily(db, {
      market: M,
      family: "F1",
      quarter: "2026Q4",
      d: D,
      now: NOW,
    });
    expect(r.outcome).toBe("evaluated");
    expect((await familyStatusMap(db, M, D)).F1).toBe("allowed");
    expect(await familyStatusHistory(db, M, "F1")).toHaveLength(1);
  });

  it("the only code that writes `allowed` is recordFamilyStatus (CTX-072)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/cortex/look.ts", "utf8");
    expect(src).not.toMatch(/insertFamilyStatus|INSERT INTO family_status/);
    expect(src).toMatch(/recordFamilyStatus/);
  });
});
