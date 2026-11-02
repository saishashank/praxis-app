// @vitest-environment node
// M17 WP2 (D-398): the acceptance gate for the delayed-quote host. `readQuoteSourceState` reports the
// register status, the kill-switch mode and the dispatch switch; the seeded host is pending, so the
// routes (which skip unless register = enabled, mode = on and dispatch is on) skip.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  DISPATCH_ENABLED_KEY,
  readQuoteSourceState,
  SOURCE_CONTROLS,
  YAHOO_DELAYED_SOURCE_ID,
  type QuoteSourceState,
} from "@/lib/data/controls";

afterEach(cleanupTempDbs);

const open = (s: QuoteSourceState) =>
  s.register === "enabled" && s.mode === "on" && s.dispatchEnabled;

describe("readQuoteSourceState", () => {
  it("is pending, on, dispatch off on a fresh database: the gate is closed", async () => {
    const db = await freshDb("main");
    const s = await readQuoteSourceState(db);
    expect(s).toEqual({ register: "pending", mode: "on", dispatchEnabled: false });
    expect(open(s)).toBe(false);
  });

  it("opens only when enabled, on and dispatch is on", async () => {
    const db = await freshDb("main");
    await db.execute(
      "UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'",
    );
    expect(open(await readQuoteSourceState(db))).toBe(false);
    await db.execute({
      sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, 'true', 'x')",
      args: [DISPATCH_ENABLED_KEY],
    });
    const s = await readQuoteSourceState(db);
    expect(s).toEqual({ register: "enabled", mode: "on", dispatchEnabled: true });
    expect(open(s)).toBe(true);
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'yahoo_delayed'");
    expect(open(await readQuoteSourceState(db))).toBe(false);
    await db.execute("UPDATE source_status SET mode = 'tripped' WHERE source = 'yahoo_delayed'");
    expect((await readQuoteSourceState(db)).mode).toBe("tripped");
  });

  it("reports null when the rows are missing", async () => {
    const db = await freshDb("main");
    await db.execute("DROP TRIGGER source_status_no_delete");
    await db.execute("DELETE FROM source_status WHERE source = 'yahoo_delayed'");
    await db.execute("DROP TRIGGER source_register_no_delete");
    await db.execute("DELETE FROM source_register WHERE source = 'yahoo_delayed'");
    expect(await readQuoteSourceState(db)).toEqual({
      register: null,
      mode: null,
      dispatchEnabled: false,
    });
  });

  it("the control entry carries the O-26 style risk text", () => {
    const c = SOURCE_CONTROLS[YAHOO_DELAYED_SOURCE_ID];
    expect(c.ref).toBe("O-26");
    expect(c.riskText).toMatch(/unofficial/);
    expect(c.riskText).toMatch(/kill switch/);
    expect(c.riskText).toMatch(/2,000/);
  });
});
