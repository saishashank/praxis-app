// @vitest-environment node
// AT-76 (M21 part; D-1213, D-1235; BLD-041): a fresh configuration has the Committee off, and the switch is refused on a
// planted 9-night health count and accepted on 10. The trial and reflections clauses belong to M22 and re-run there.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "@/lib/config/admin";
import { invalidateConfigCache } from "@/lib/config/runtime";
import { getConfig } from "@/lib/config/store";
import { switchRefusal } from "@/lib/config/switchGuards";
import { loadSteelmanHealth } from "@/lib/health/steelman";
import { insertNight, type NightRow } from "@/lib/steelman/store";
import { addUser, ENV } from "../../auth/helpers";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

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

const night = (i: number): NightRow => ({
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
});
const edit = (value: string) =>
  updateConfig({
    mainDb: main,
    authDb: auth,
    env: ENV,
    actorId: ownerId,
    key: "committee_enabled",
    rawValue: value,
    reason: "AT-76",
    now: new Date("2026-10-10T07:00:00.000Z"),
  });

describe("AT-76 (M21 part)", () => {
  it("a fresh configuration has committee_enabled off", async () => {
    expect(await getConfig(main, "committee_enabled")).toBe("off");
  });

  it("the switch is disabled on a planted 9-night health count and enabled on 10", async () => {
    for (let i = 1; i <= 9; i++) await insertNight(main, night(i));
    expect((await loadSteelmanHealth(main, "AU")).qualifying).toBe(9);
    expect(await switchRefusal(main, "committee_enabled", "on")).toMatch(/9 of 10 so far/);
    expect(await edit("on")).toMatchObject({ ok: false, error: "invalid" });
    expect(await getConfig(main, "committee_enabled")).toBe("off");
    await insertNight(main, night(10));
    expect((await loadSteelmanHealth(main, "AU")).qualifying).toBe(10);
    expect(await switchRefusal(main, "committee_enabled", "on")).toBeNull();
    expect(await edit("on")).toMatchObject({ ok: true });
    invalidateConfigCache();
    expect(await getConfig(main, "committee_enabled")).toBe("on");
  });

  // M22 clauses live in split files (D-1448): the trial and its page in at76Trial.test.ts, the reflections in
  // at76Reflections.test.ts, the Committee engine (debate, judge, night, entry) in tests/committee/*.test.ts, the
  // Workers AI adapter in at77WorkersAi.test.ts and the intraday sweep in at77Sweep.test.ts.
  it("M22 clauses are proven in the split files of D-1448", () => {
    for (const name of ["at76Trial", "at76Reflections", "at77WorkersAi", "at77Sweep"]) {
      expect(existsSync(path.join(__dirname, `${name}.test.ts`)), name).toBe(true);
    }
    for (const name of ["debate", "judge", "night", "cli"]) {
      expect(existsSync(path.join(__dirname, "../../committee", `${name}.test.ts`)), name).toBe(
        true,
      );
    }
  });
});
