// @vitest-environment node
// M8 T5 (D-102, decision 44): a red thesis-breaker on an open position reaches the alert table as ONE
// P0 alert per breaker per day through the default sink; a quiet (green/amber) night raises none; a
// rerun adds none; the P0 is the kind the D-101 flush picks up.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signalsDay } from "@/lib/agents/batch2b";
import { breakerAlertTier, createAlertRowSink } from "@/lib/agents/breakerEval";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { parseFacts, readAlert } from "@/lib/alerts/deliver";
import { rulesText } from "@/lib/alerts/tiers";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { buildGolden } from "../agents/batch2bScenario";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });

const params = testParams();
const d = (i: number): string => DATES[i]!;
type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string): Promise<Row[]> =>
  (await db.execute(sql)).rows.map((r) => ({ ...r }));

async function world(halt: boolean): Promise<Client> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  if (halt) {
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES (?, 'ZZUP', 'HALT-1', ?, ?, 'Trading Halt', 1, 'Trading Halt', NULL, ?)`,
      args: [MARKET, `${d(302)}T03:00:00.000Z`, `${d(302)}T03:00:00.000Z`, ASX_SOURCE],
    });
  }
  await startCohortsAt(db, 295, ["E01", "E07"]);
  await runNights(db, params, 295, 304); // default sink: no breakerSink option
  return db;
}

let green: Client;
let red: Client;
afterAll(cleanupTempDbs);
beforeAll(async () => {
  green = await world(false);
  red = await world(true);
});

describe("red breaker -> P0 alert (D-102)", () => {
  it("a held position's red breakers are P0 alerts, one per breaker per day", async () => {
    const alerts = await rows(
      red,
      "SELECT * FROM alert WHERE kind = 'thesis_breaker' ORDER BY alert_key",
    );
    expect(alerts.map((a) => a.alert_key)).toEqual(
      ["TB-HALT", "TB-NEG"].map((b) =>
        expect.stringMatching(new RegExp(`^tb:.*ZZUP.*:${b}:${d(302)}$`)),
      ),
    );
    for (const a of alerts) {
      expect(a).toMatchObject({ tier: "P0", code: "ZZUP", market: MARKET });
      const f = parseFacts(String(a.facts_json));
      expect(f.why).toContain("turned red");
      expect(rulesText("P0", "thesis_breaker", "ZZUP", f)).toContain("ZZUP");
      expect((await readAlert(red, String(a.alert_key)))?.tier).toBe("P0");
    }
  });

  it("a rerun of the night raises nothing new", async () => {
    const before = await rows(red, "SELECT alert_key FROM alert");
    const again = await signalsDay(red, {
      market: MARKET,
      d: d(302),
      replay: true,
      now: () => NOW(),
      params,
    });
    expect(again.status).toBe("already_done");
    expect(await rows(red, "SELECT alert_key FROM alert")).toEqual(before);
  });

  it("a quiet (green or amber) breaker never raises a P0", async () => {
    expect(await rows(green, "SELECT 1 FROM alert WHERE kind = 'thesis_breaker'")).toEqual([]);
    expect(await rows(green, "SELECT 1 FROM alert WHERE tier = 'P0'")).toEqual([]);
  });
});

describe("the default sink", () => {
  it("is idempotent on the key; P0 for a trade, P2 for a pending order", async () => {
    const db = await world(false);
    const sink = createAlertRowSink(db);
    const base = {
      market: MARKET,
      code: "ZZUP",
      d: d(303),
      phase: "nightly" as const,
      cardId: "card:1",
      executionId: "E01",
      breakerId: "TB-NEG" as const,
      status: "red" as const,
      valueText: "v",
      triggerText: "t",
      triggerRef: null,
      effect: "none" as const,
      detectedAt: `${d(303)}T00:00:00.000Z`,
    };
    await sink.record({ ...base, key: "tb:T1:TB-NEG:x1", subjectKind: "trade", subjectId: "T1" });
    await sink.record({ ...base, key: "tb:T1:TB-NEG:x1", subjectKind: "trade", subjectId: "T1" });
    await sink.record({ ...base, key: "tb:O1:TB-NEG:x2", subjectKind: "order", subjectId: "O1" });
    const r = await rows(
      db,
      "SELECT alert_key, tier FROM alert WHERE alert_key LIKE 'tb:%:x_' ORDER BY alert_key",
    );
    expect(r).toEqual([
      { alert_key: "tb:O1:TB-NEG:x2", tier: "P2" },
      { alert_key: "tb:T1:TB-NEG:x1", tier: "P0" },
    ]);
    expect(breakerAlertTier("trade")).toBe("P0");
  });
});
