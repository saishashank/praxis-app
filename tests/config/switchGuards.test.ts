// @vitest-environment node
// M21 A1 (D-1213; AT-76 M21 part; BLD-041): the Committee switch refuses "on" until the stored steelman health shows 10
// qualifying nights at 98 % or better. Every other key passes. The guard is called by updateConfig, so a refused edit
// writes no version and no audit row.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "@/lib/config/admin";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { switchRefusal } from "@/lib/config/switchGuards";
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
