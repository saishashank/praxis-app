// @vitest-environment node
// M22 E5 (AGT-147, D-1443): the sweep plans only when the switch is on AND the batch source is accepted; otherwise nothing, and
// the scan universe is exactly what it was. Armed picks first, the per-slot request limit and the scan's remaining budget are
// respected, a code the scan already quotes is not asked for twice. Read only; no network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SWEEP_CODES_PER_REQUEST,
  SWEEP_SOURCE,
  planSweep,
  sweepAccepted,
  sweepStatus,
} from "@/lib/intraday/sweep";
import { scanUniverse } from "@/lib/intraday/universe";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const D = "2026-11-04";
let db: Client;

async function setKey(key: string, value: unknown): Promise<void> {
  await db.execute({
    sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, 'x')",
    args: [key, JSON.stringify(value)],
  });
}
const accept = () =>
  db.execute({
    sql: "INSERT INTO source_register (source, risk, status) VALUES (?, 'medium', 'enabled')",
    args: [SWEEP_SOURCE],
  });

/** n codes ZZ000..; the first half U1, the rest U2; ZZ001 is halted. */
async function universe(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, adv, halted) VALUES ('AU', '2026-11-03', ?, 'active', ?, 5000000, ?)",
      args: [`ZZ${String(i).padStart(3, "0")}`, i < n / 2 ? "U1" : "U2", i === 1 ? 1 : 0],
    });
  }
}
const plan = (over: Partial<Parameters<typeof planSweep>[1]> = {}) =>
  planSweep(db, { market: "AU", d: D, scanned: [], armed: [], requestsLeft: 100, ...over });

beforeEach(async () => {
  db = await freshDb("main");
});

describe("the two conditions", () => {
  it("is off by default and plans nothing", async () => {
    await universe(10);
    expect(await sweepStatus(db)).toBe("off");
    expect(await plan()).toEqual({ status: "off", batches: [], requests: 0 });
  });

  it("on without the accepted row plans nothing", async () => {
    await universe(10);
    await setKey("intraday_sweep_enabled", "on");
    expect(await sweepAccepted(db)).toBe(false);
    expect(await plan()).toEqual({ status: "not_accepted", batches: [], requests: 0 });
  });

  it("an accepted row with the switch off plans nothing", async () => {
    await universe(10);
    await accept();
    expect(await plan()).toMatchObject({ status: "off", batches: [] });
  });

  it("the scan universe is the same in every state", async () => {
    await universe(12);
    const base = await scanUniverse(db, "AU", D, 100);
    await setKey("intraday_sweep_enabled", "on");
    expect(await scanUniverse(db, "AU", D, 100)).toEqual(base);
    await accept();
    expect(await scanUniverse(db, "AU", D, 100)).toEqual(base);
  });
});

describe("a sweep with both conditions", () => {
  beforeEach(async () => {
    await setKey("intraday_sweep_enabled", "on");
    await accept();
  });

  it("builds U1 then U2 batches, skipping halted codes, one request per batch of the batch size", async () => {
    await universe(50);
    await setKey("intraday_sweep_requests_per_slot", 3);
    const p = await plan();
    expect(p.status).toBe("planned");
    expect(p.requests).toBe(3);
    expect(p.batches.map((b) => b.length)).toEqual([
      SWEEP_CODES_PER_REQUEST,
      SWEEP_CODES_PER_REQUEST,
      9,
    ]); // 49 not halted
    const all = p.batches.flat();
    expect(all).not.toContain("ZZ001"); // halted
    expect(all.slice(0, 3)).toEqual(["ZZ000", "ZZ002", "ZZ003"]); // U1 first, by code
    expect(new Set(all).size).toBe(all.length);
  });

  it("respects the per-slot limit and the requests the scan has left", async () => {
    await universe(200);
    await setKey("intraday_sweep_requests_per_slot", 5);
    expect((await plan({ requestsLeft: 2 })).requests).toBe(2);
    expect(await plan({ requestsLeft: 0 })).toEqual({
      status: "no_budget",
      batches: [],
      requests: 0,
    });
    await setKey("intraday_sweep_requests_per_slot", 0);
    expect((await plan()).status).toBe("no_budget");
    await setKey("intraday_sweep_requests_per_slot", 20);
    const big = await plan({ requestsLeft: 1000 });
    expect(big.requests).toBe(10); // 199 codes in batches of 20
    expect(big.batches.flat()).toHaveLength(199);
  });

  it("puts armed picks first, even outside the tiers, and never asks twice for a scanned code", async () => {
    await universe(30);
    await setKey("intraday_sweep_requests_per_slot", 1);
    const p = await plan({ armed: ["ZZ029", "QQ001"], scanned: ["ZZ000", "ZZ002"] });
    expect(p.batches[0]!.slice(0, 2)).toEqual(["QQ001", "ZZ029"]);
    expect(p.batches[0]).not.toContain("ZZ000");
    expect(p.batches[0]).not.toContain("ZZ002");
    expect(p.batches[0]).toHaveLength(SWEEP_CODES_PER_REQUEST);
    expect(p.batches[0]!.slice(2, 4)).toEqual(["ZZ003", "ZZ004"]);
  });

  it("fails closed when the register cannot be read", async () => {
    const broken = {
      execute: async (): Promise<never> => {
        throw new Error("down");
      },
    };
    expect(await sweepAccepted(broken as never)).toBe(false);
  });

  it("writes nothing", async () => {
    await universe(10);
    const rows = async () =>
      JSON.stringify([
        (await db.execute("SELECT COUNT(*) n FROM quote_run")).rows[0],
        (await db.execute("SELECT COUNT(*) n FROM intraday_candidate")).rows[0],
      ]);
    const before = await rows();
    await plan();
    expect(await rows()).toBe(before);
  });
});
