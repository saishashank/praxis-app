// @vitest-environment node
// M21 A1 (D-1213; AT-76 M21 part; BLD-041): the Committee switch refuses "on" until the stored steelman health shows 10
// qualifying nights at 98 % or better. Every other key passes. The guard is called by updateConfig, so a refused edit
// writes no version and no audit row.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "@/lib/config/admin";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { committeeGuard, FROZEN_TRIAL_KEYS } from "@/lib/config/guards/committee";
import { liveRolesGuard } from "@/lib/config/guards/liveRoles";
import { minilmGuard } from "@/lib/config/guards/minilm";
import { REGIME_ALT_REFUSAL, regimeAltGuard } from "@/lib/config/guards/regimeAlt";
import { SWEEP_REFUSAL, sweepGuard } from "@/lib/config/guards/sweep";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { GUARDS, switchRefusal } from "@/lib/config/switchGuards";
import { insertNight, type NightRow } from "@/lib/steelman/store";
import { addUser, auditRows, ENV } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
beforeEach(async () => {
  invalidateConfigCache();
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
});

const night = (i: number, over: Partial<NightRow> = {}): NightRow => ({
  market: "AU",
  d: `2026-03-${String(i).padStart(2, "0")}`,
  requested: 3,
  written: 3,
  notWrittenLimit: 0,
  notWrittenBudget: 0,
  notWrittenNoModel: 0,
  notWrittenCritic: 0,
  notWrittenError: 0,
  claimsTotal: 20,
  claimsValid: 20,
  validityPpm: 1_000_000,
  criticHidden: 0,
  createdAt: "2026-03-30T00:00:00.000Z",
  ...over,
});
const plant = async (n: number, over: Partial<NightRow> = {}) => {
  for (let i = 1; i <= n; i++) await insertNight(main, night(i, over));
};
const REFUSAL = (n: number) =>
  `The Committee can be switched on after 10 nights with the case-writing check at 98 % or better (${n} of 10 so far)`;

describe("switchRefusal", () => {
  it("committee_enabled = on is refused with the count until 10 nights qualify", async () => {
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(0));
    await plant(9);
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(9));
    await insertNight(main, night(10));
    expect(await switchRefusal(main, "committee_enabled", "on")).toBeNull();
  });

  it("a night under 98 % or with nothing written does not count", async () => {
    await plant(9);
    await insertNight(main, night(10, { validityPpm: 979_999 }));
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(9));
    // the window is the last 10 nights: 11th night qualifies but the bad one is still inside the window of ten
    await insertNight(main, night(11));
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(9));
    await insertNight(main, night(12, { written: 0, claimsTotal: 0, claimsValid: 0 }));
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(8));
  });

  it("switching off is never refused, and every other key and value passes", async () => {
    expect(await switchRefusal(main, "committee_enabled", "off")).toBeNull();
    expect(await switchRefusal(main, "owner_real_money_tools", "on")).toBeNull();
    expect(await switchRefusal(main, "retention_logs_days", 21)).toBeNull();
    expect(await switchRefusal(main, "not_a_key", "on")).toBeNull();
  });
});

describe("updateConfig calls the guard (Owner edit, audited)", () => {
  const edit = (key: string, rawValue: string) =>
    updateConfig({
      mainDb: main,
      authDb: auth,
      env: ENV,
      actorId: ownerId,
      key,
      rawValue,
      reason: "switch",
      now: new Date("2026-10-10T07:00:00.000Z"),
    });
  const versions = async (key: string) =>
    Number(
      (
        await main.execute({
          sql: "SELECT COUNT(*) n FROM config_version WHERE key = ?",
          args: [key],
        })
      ).rows[0]!.n,
    );

  it("9 qualifying nights: refused, no version, no audit row; 10: accepted and audited", async () => {
    await plant(9);
    const before = (await auditRows(auth)).length;
    expect(await edit("committee_enabled", "on")).toEqual({
      ok: false,
      error: "invalid",
      message: REFUSAL(9),
    });
    expect(await versions("committee_enabled")).toBe(0);
    expect((await auditRows(auth)).length).toBe(before);
    await insertNight(main, night(10));
    expect(await edit("committee_enabled", "on")).toMatchObject({ ok: true });
    expect(await versions("committee_enabled")).toBe(1);
    expect((await auditRows(auth)).some((r) => r.action === "config.change")).toBe(true);
  });

  it("switching the Committee off is always accepted, and owner_real_money_tools is a plain audited switch", async () => {
    expect(await edit("committee_enabled", "off")).toMatchObject({ ok: true });
    expect(await edit("owner_real_money_tools", "on")).toMatchObject({ ok: true });
    const rows = await auditRows(auth);
    expect(rows.filter((r) => r.action === "config.change")).toHaveLength(2);
  });

  it("pwa_push_enabled = on is refused by its validator", async () => {
    const r = await edit("pwa_push_enabled", "on");
    expect(r).toMatchObject({ ok: false, error: "invalid" });
    expect(JSON.stringify(r)).toContain("Web push is not built");
  });
});

// ---- M22 A2 (D-1445): the guard registry ----------------------------------------------------------------------------

// The two tables of migration 0039 (task A1), with the columns the guard reads and the NOT NULL columns a real row needs, so
// the same inserts work before and after A1 is merged (IF NOT EXISTS leaves the real tables alone).
const TRIAL_TABLES = [
  "CREATE TABLE IF NOT EXISTS committee_prereg (trial_id TEXT NOT NULL, version INTEGER NOT NULL, market TEXT NOT NULL, frozen_json TEXT NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (trial_id, version))",
  "CREATE TABLE IF NOT EXISTS committee_trial_result (trial_id TEXT NOT NULL, market TEXT NOT NULL, d TEXT NOT NULL, kind TEXT NOT NULL, verdict TEXT NOT NULL, stats_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (trial_id, market, d, kind))",
];
const startTrial = async (db: Client, id = "t1") => {
  for (const sql of TRIAL_TABLES) await db.execute(sql);
  await db.execute({
    sql: "INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES (?, 1, 'AU', '{}', ?, '2026-11-01T00:00:00.000Z')",
    args: [id, "a".repeat(64)],
  });
};
const finishTrial = (db: Client, id = "t1") =>
  db.execute({
    sql: "INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at) VALUES (?, 'AU', '2026-11-01', 'final', 'FAIL', '{}', '2026-11-01T00:00:00.000Z')",
    args: [id],
  });
const throwing = (msg: string) => ({
  execute: async (): Promise<never> => {
    throw new Error(msg);
  },
});
const FROZEN_REFUSAL = "The Committee trial is running: its settings are frozen until it ends";

describe("the registry (D-1445)", () => {
  it("guards exactly the Committee switch and its frozen trial keys, the live roles, MiniLM, the alt inputs and the sweep", () => {
    expect(Object.keys(GUARDS).sort()).toEqual(
      [
        "committee_enabled",
        ...FROZEN_TRIAL_KEYS,
        "llm_live_roles",
        "minilm_enabled",
        "regime_altinputs_enabled",
        "intraday_sweep_enabled",
      ].sort(),
    );
    for (const k of Object.keys(GUARDS)) expect(CONFIG_KEYS).toHaveProperty(k);
    expect([...FROZEN_TRIAL_KEYS].sort()).toEqual([
      "committee_horizon_sessions",
      "committee_min_settled",
      "committee_permutations",
      "committee_trial_sessions",
    ]);
  });

  it("the registry gives the Committee guard's results unchanged", async () => {
    expect(GUARDS.committee_enabled).toBe(committeeGuard);
    expect(await switchRefusal(main, "committee_enabled", "on")).toBe(REFUSAL(0));
    expect(await committeeGuard(main, "on")).toBe(REFUSAL(0));
    expect(await committeeGuard(main, "off")).toBeNull();
    expect(await committeeGuard(throwing("down"), "on")).toBe(REFUSAL(0)); // fails closed
  });

  it("regime_altinputs_enabled is owned by E5: display only, refuses on only when the shadow table cannot be read (fails closed)", async () => {
    expect(GUARDS.regime_altinputs_enabled).toBe(regimeAltGuard);
    expect(await switchRefusal(main, "regime_altinputs_enabled", "on")).toBeNull();
    expect(await switchRefusal(main, "regime_altinputs_enabled", "off")).toBeNull();
    expect(await regimeAltGuard(throwing("down"), "on")).toBe(REGIME_ALT_REFUSAL);
    expect(await regimeAltGuard(throwing("down"), "off")).toBeNull();
  });

  it("intraday_sweep_enabled is owned by E5: on is refused until the batch source row is accepted, fails closed", async () => {
    expect(GUARDS.intraday_sweep_enabled).toBe(sweepGuard);
    expect(await switchRefusal(main, "intraday_sweep_enabled", "on")).toBe(SWEEP_REFUSAL);
    expect(await switchRefusal(main, "intraday_sweep_enabled", "off")).toBeNull();
    expect(await sweepGuard(throwing("down"), "on")).toBe(SWEEP_REFUSAL);
    expect(await sweepGuard(throwing("down"), "off")).toBeNull();
    await main.execute({
      sql: "INSERT INTO source_register (source, risk, status) VALUES ('yahoo_delayed_batch', 'medium', 'pending')",
      args: [],
    });
    expect(await switchRefusal(main, "intraday_sweep_enabled", "on")).toBe(SWEEP_REFUSAL);
    await main.execute({
      sql: "UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed_batch'",
      args: [],
    });
    expect(await switchRefusal(main, "intraday_sweep_enabled", "on")).toBeNull();
  });

  it("minilm_enabled is owned by L5: registered, refuses on, never reads the database (tests/llm/minilm/guard.test.ts)", async () => {
    expect(GUARDS.minilm_enabled).toBe(minilmGuard);
    expect(await minilmGuard(throwing("down"), "on")).toBe(
      "The local classifier has not been trained yet",
    );
    expect(await switchRefusal(main, "minilm_enabled", "off")).toBeNull();
  });

  it("llm_live_roles is owned by L1: registered and no longer a stub (tests/config/liveRolesGuard.test.ts)", async () => {
    expect(GUARDS.llm_live_roles).toBe(liveRolesGuard);
    // no bake-off PASS is recorded in the repository: adding any job is refused, emptying the list passes
    expect(await switchRefusal(main, "llm_live_roles", ["R1"])).not.toBeNull();
    expect(await switchRefusal(main, "llm_live_roles", [])).toBeNull();
  });

  it("an unguarded key, an unknown key and a prototype name pass", async () => {
    expect(await switchRefusal(main, "toString", "x")).toBeNull();
    expect(await switchRefusal(main, "__proto__", "x")).toBeNull();
    expect(await switchRefusal(main, "constructor", "x")).toBeNull();
  });
});

describe("the frozen trial keys (D-1420)", () => {
  it("are free with no trial, before the tables exist, and after the final verdict", async () => {
    for (const k of FROZEN_TRIAL_KEYS) expect(await switchRefusal(main, k, 30), k).toBeNull();
    await startTrial(main);
    await finishTrial(main);
    for (const k of FROZEN_TRIAL_KEYS) expect(await switchRefusal(main, k, 30), k).toBeNull();
  });

  it("are refused, whatever the value, while a trial has a pre-registration and no final row", async () => {
    await startTrial(main);
    for (const k of FROZEN_TRIAL_KEYS) {
      expect(await switchRefusal(main, k, 30), k).toBe(FROZEN_REFUSAL);
      expect(await switchRefusal(main, k, CONFIG_KEYS[k].default), k).toBe(FROZEN_REFUSAL);
    }
    expect(await switchRefusal(main, "committee_shortlist", 2)).toBeNull(); // not a frozen key
    expect(await switchRefusal(main, "committee_enabled", "off")).toBeNull(); // the switch itself is not frozen
    await finishTrial(main);
    expect(await switchRefusal(main, "committee_horizon_sessions", 30)).toBeNull();
  });

  it("a second trial starts frozen again; an unreadable database refuses; a missing table does not", async () => {
    await startTrial(main, "t1");
    await finishTrial(main, "t1");
    await startTrial(main, "t2");
    expect(await switchRefusal(main, "committee_min_settled", 200)).toBe(FROZEN_REFUSAL);
    expect(await switchRefusal(throwing("db down"), "committee_min_settled", 200)).toBe(
      FROZEN_REFUSAL,
    );
    expect(
      await switchRefusal(
        throwing("no such table: committee_prereg"),
        "committee_min_settled",
        200,
      ),
    ).toBeNull();
  });

  it("updateConfig refuses a frozen edit with the text, writes no version and no audit row", async () => {
    const edit = (key: string, rawValue: string) =>
      updateConfig({
        mainDb: main,
        authDb: auth,
        env: ENV,
        actorId: ownerId,
        key,
        rawValue,
        reason: "trial",
        now: new Date("2026-11-10T07:00:00.000Z"),
      });
    await startTrial(main);
    const before = (await auditRows(auth)).length;
    expect(await edit("committee_trial_sessions", "100")).toEqual({
      ok: false,
      error: "invalid",
      message: FROZEN_REFUSAL,
    });
    expect((await auditRows(auth)).length).toBe(before);
    await finishTrial(main);
    expect(await edit("committee_trial_sessions", "100")).toMatchObject({ ok: true });
  });
});
