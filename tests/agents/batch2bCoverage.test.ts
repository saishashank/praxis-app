// Live defect (October 2026): with no U1 code (an incomplete 60-session tier window) and the ASX
// source off, no family can produce a candidate, and batch 2b recorded `success` with no signal for
// a week. coverageGaps names those gaps and the night is recorded `degraded` (the Control Room shows
// it); a night with U1 codes is unchanged.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { coverageGaps } from "@/lib/agents/batch2b";
import type { CodeFacts } from "@/lib/agents/families/types";
import { cleanupTempDbs } from "../db/helpers";
import { DATES, freshReplayDb, runNights, setMode, testParams } from "./batch2bHarness";
import { buildGolden, D, goldenCodes } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterAll(cleanupTempDbs);

const codes = (...tiers: CodeFacts["tier"][]): CodeFacts[] =>
  tiers.map((tier, i) => ({ code: `ZZ${i}`, tier }) as CodeFacts);

describe("coverageGaps", () => {
  it("is empty when a U1 code is present, whatever the ASX source", () => {
    expect(coverageGaps({ codes: codes("U1", "U2"), sources: { asx: "on", asic: "on" } })).toEqual(
      [],
    );
    expect(coverageGaps({ codes: codes("U1"), sources: { asx: "off", asic: "on" } })).toEqual([]);
  });

  it("names a universe without U1, and no runnable family when ASX is off as well", () => {
    expect(coverageGaps({ codes: codes("U2", "U3"), sources: { asx: "on", asic: "on" } })).toEqual([
      "no_u1_codes",
    ]);
    expect(coverageGaps({ codes: codes("U2", "U3"), sources: { asx: "off", asic: "on" } })).toEqual(
      ["no_u1_codes", "no_family_can_run"],
    );
    expect(coverageGaps({ codes: [], sources: { asx: "off", asic: "off" } })).toEqual([
      "no_u1_codes",
      "no_family_can_run",
    ]);
  });
});

async function night(
  db: Client,
): Promise<{ status: string; reason: string | null; details: unknown }> {
  const run = await runNights(db, testParams(), D, D);
  const r = run.signals.get(DATES[D]!)!;
  const rec = await db.execute({
    sql: "SELECT details_json FROM run_record WHERE id = ?",
    args: [r.runId],
  });
  return {
    status: r.status,
    reason: r.reason,
    details: JSON.parse(String(rec.rows[0]!.details_json)),
  };
}

describe("signalsDay", () => {
  it("records a night with U1 codes as success, without a coverage entry", async () => {
    const db = await freshReplayDb();
    await buildGolden(db);
    await setMode(db, "full");
    const r = await night(db);
    expect(r.status).toBe("success");
    expect(r.reason).toBeNull();
    expect((r.details as { coverage: unknown }).coverage).toBeNull();
  });

  it("records a night whose universe has no U1 code as degraded, naming the gap", async () => {
    const db = await freshReplayDb();
    await buildGolden(db, { codes: goldenCodes().map((c) => ({ ...c, tier: "U2" as const })) });
    await setMode(db, "full");
    const r = await night(db);
    expect(r.status).toBe("degraded");
    expect(r.reason).toBe("no_u1_codes");
    expect((r.details as { coverage: unknown }).coverage).toEqual(["no_u1_codes"]);
  });
});
