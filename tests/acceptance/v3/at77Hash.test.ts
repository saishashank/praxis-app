// @vitest-environment node
// AT-77 "switching on changes no book, order, signal, rule or alert" (M21 A1, D-1237, PRD-041): the AT-32 golden ZZ world
// is run twice, once with `owner_real_money_tools` at its default "off" and once with the Owner's switch "on", and every
// table except `config_version` (the switch write itself) dumps identically. Nothing the Owner tools add may move a book.
// Today nothing reads the switch, so the test is a guard for the streams that follow: it stays green on every branch.
// Synthetic ZZ data only (SEC-110).
import { afterAll, describe, expect, it, vi } from "vitest";
import { setConfig } from "@/lib/config/store";
import { cleanupTempDbs } from "../../db/helpers";
import { at32World, dump } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

describe("AT-77: the Owner switch moves nothing (D-1237)", () => {
  it("the golden world dumps identically with owner_real_money_tools on and off, except config_version", async () => {
    const off = await at32World();
    expect(
      String(
        (
          await off.execute(
            "SELECT COUNT(*) n FROM config_version WHERE key = 'owner_real_money_tools'",
          )
        ).rows[0]!.n,
      ),
    ).toBe("0");
    const on = await at32World(async (db) => {
      await setConfig(db, {
        key: "owner_real_money_tools",
        value: "on",
        userId: null,
        reason: "AT-77 hash test",
        now: "2030-01-01T00:00:00.000Z",
      });
    });
    expect(
      Number(
        (
          await on.execute(
            "SELECT COUNT(*) n FROM config_version WHERE key = 'owner_real_money_tools'",
          )
        ).rows[0]!.n,
      ),
    ).toBe(1);
    const a = await dump(off);
    const b = await dump(on);
    // not vacuous: the world has cards, signals, orders and decisions
    expect(a.rows.signal).toBeGreaterThan(0);
    expect(a.rows.decision_card).toBeGreaterThan(0);
    expect(a.rows.arena_order).toBeGreaterThan(0);
    // the switch is the only difference, and it is in config_version only
    expect(Object.keys(b.perTable).sort()).toEqual(Object.keys(a.perTable).sort());
    const differing = Object.keys(a.perTable)
      .filter((t) => a.perTable[t] !== b.perTable[t])
      .sort();
    expect(differing).toEqual(["config_version"]);
    for (const t of Object.keys(a.rows).filter((t) => t !== "config_version")) {
      expect(b.rows[t], `${t} row count`).toBe(a.rows[t]);
    }
  });
});
