// @vitest-environment node
// AT-77 (M22 E5, AGT-147, D-1443): the whole-market sweep is off in a fresh configuration; on without the accepted batch source
// the scan universe is unchanged and the guard refuses the switch; with both conditions armed picks come first inside the budget.
// No network, nothing written.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { switchRefusal } from "@/lib/config/switchGuards";
import { SWEEP_SOURCE, planSweep } from "@/lib/intraday/sweep";
import { scanUniverse } from "@/lib/intraday/universe";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  for (let i = 0; i < 6; i += 1) {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, adv, halted) VALUES ('AU', '2026-11-03', ?, 'active', ?, 1, 0)",
      args: [`ZZ00${i}`, i < 3 ? "U1" : "U2"],
    });
  }
});

const set = (key: string, value: unknown) =>
  db.execute({
    sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, 'x')",
    args: [key, JSON.stringify(value)],
  });
const input = {
  market: "AU",
  d: "2026-11-04",
  scanned: [] as string[],
  armed: [] as string[],
  requestsLeft: 50,
};

describe("AT-77 sweep", () => {
  it("is off in a fresh configuration with five requests a slot", async () => {
    expect(CONFIG_KEYS.intraday_sweep_enabled.default).toBe("off");
    expect(CONFIG_KEYS.intraday_sweep_requests_per_slot.default).toBe(5);
    expect(await planSweep(db, input)).toEqual({ status: "off", batches: [], requests: 0 });
  });

  it("on without the accepted row: the universe is unchanged, nothing is planned, and the switch is refused", async () => {
    const before = await scanUniverse(db, "AU", "2026-11-04", 100);
    await set("intraday_sweep_enabled", "on");
    expect((await planSweep(db, input)).status).toBe("not_accepted");
    expect(await scanUniverse(db, "AU", "2026-11-04", 100)).toEqual(before);
    expect(await switchRefusal(db, "intraday_sweep_enabled", "on")).toMatch(/accepted first/);
  });

  it("with both conditions the armed picks come first and the request budget holds", async () => {
    await set("intraday_sweep_enabled", "on");
    await db.execute({
      sql: "INSERT INTO source_register (source, risk, status) VALUES (?, 'medium', 'enabled')",
      args: [SWEEP_SOURCE],
    });
    await set("intraday_sweep_requests_per_slot", 1);
    const p = await planSweep(db, { ...input, armed: ["ZZ005"], requestsLeft: 3 });
    expect(p.status).toBe("planned");
    expect(p.requests).toBe(1);
    expect(p.batches[0]![0]).toBe("ZZ005");
    expect(await switchRefusal(db, "intraday_sweep_enabled", "on")).toBeNull();
  });
});
