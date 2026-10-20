// @vitest-environment node
// M8 T5 (D-105, decision 44): a violation found by the batch 3 ARN-101 re-check opens one S1
// `ledger_invariant` incident through notifyIncident (one email), once per kind per day; a clean check
// opens nothing; the batch still ends degraded with no book row changed (the re-check is report only).
import type { Client } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEDGER_INVARIANT_KIND,
  raiseLedgerInvariantIncident,
  reviewDay,
  type RecheckSummary,
} from "@/lib/agents/batch3";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode as setReplayMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { buildGolden } from "../agents/batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
afterAll(cleanupTempDbs);

const ENV: Record<string, string | undefined> = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
};
const bad: RecheckSummary = {
  cohorts: 3,
  violations: 2,
  fatal: 1,
  byCode: { double_entry: 2 },
  cohortsWithViolations: ["C1"],
};
const clean: RecheckSummary = { ...bad, violations: 0, fatal: 0, cohortsWithViolations: [] };

async function setMode(db: Client, mode: string) {
  await db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });
}

describe("raiseLedgerInvariantIncident", () => {
  let db: Client;
  let mock: MockProvider;
  const notify = () => ({ env: ENV, provider: mock, sleep: async () => {} });
  beforeEach(async () => {
    db = await freshDb("main");
    mock = createMockProvider();
    await setMode(db, "incidents");
  });

  it("opens one S1 incident and sends one email; same day again: nothing new", async () => {
    const o = { d: "2026-10-19", now: "2026-10-19T09:00:00.000Z", notify: notify() };
    expect(await raiseLedgerInvariantIncident(db, o, bad)).toBe(true);
    expect(await raiseLedgerInvariantIncident(db, o, bad)).toBe(false);
    const inc = (await db.execute("SELECT severity, kind, detail_json FROM incident")).rows;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S1", kind: LEDGER_INVARIANT_KIND });
    expect(JSON.parse(String(inc[0]!.detail_json))).toMatchObject({ d: "2026-10-19", fatal: 1 });
    expect(mock.outbox).toHaveLength(1);
  });

  it("a later day while the first is open adds neither a row nor a mail; a resolved one reopens", async () => {
    const at = (d: string) => ({ d, now: `${d}T09:00:00.000Z`, notify: notify() });
    await raiseLedgerInvariantIncident(db, at("2026-10-19"), bad);
    expect(await raiseLedgerInvariantIncident(db, at("2026-10-20"), bad)).toBe(false);
    await db.execute("UPDATE incident SET resolved_at = '2026-10-20T10:00:00.000Z'");
    expect(await raiseLedgerInvariantIncident(db, at("2026-10-21"), bad)).toBe(true);
    expect((await db.execute("SELECT 1 FROM incident")).rows).toHaveLength(2);
  });

  it("a clean check opens nothing; with no email wiring it records without sending", async () => {
    const o = { d: "2026-10-19", now: "2026-10-19T09:00:00.000Z" };
    expect(await raiseLedgerInvariantIncident(db, o, clean)).toBe(false);
    expect((await db.execute("SELECT 1 FROM incident")).rows).toHaveLength(0);
    expect(await raiseLedgerInvariantIncident(db, o, bad)).toBe(true);
    expect(mock.outbox).toHaveLength(0);
  });

  it("never throws: a database error is a quiet false", async () => {
    const broken = { execute: () => Promise.reject(new Error("no table")) } as unknown as Client;
    const o = { d: "x", now: "2026-10-19T09:00:00.000Z" };
    expect(await raiseLedgerInvariantIncident(broken, o, bad)).toBe(false);
  });
});

describe("batch 3 wiring (golden world)", () => {
  it("a broken book raises the S1 incident and the batch still ends degraded", async () => {
    const params = testParams();
    const db = await freshReplayDb();
    await buildGolden(db);
    await setReplayMode(db, "full");
    await startCohortsAt(db, 295, ["E01", "E07"]);
    await runNights(db, params, 295, 300);
    const day = DATES[300]!;
    const first = await db.execute({
      sql: "SELECT cohort_id FROM nav_daily WHERE d = ? ORDER BY cohort_id LIMIT 1",
      args: [day],
    });
    await db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id)
            VALUES (?, ?, 'broken:1', 'cash_settled', 5000000, 'seed', NULL, NULL)`,
      args: [String(first.rows[0]!.cohort_id), day],
    });
    const mock = createMockProvider();
    const r = await reviewDay(db, {
      market: MARKET,
      d: day,
      replay: true,
      now: NOW,
      params,
      notify: { env: ENV, provider: mock, sleep: async () => {} },
    });
    expect(r.status).toBe("degraded");
    const inc = (await db.execute("SELECT severity, kind FROM incident")).rows;
    expect(inc).toEqual([expect.objectContaining({ severity: "S1", kind: "ledger_invariant" })]);
  });
});
