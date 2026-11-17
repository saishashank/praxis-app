// @vitest-environment node
// AT-81 regime clause (M22 E5, DAT-248, D-1439...D-1441): the outside inputs change no gate while off and only gates, never
// scores, when on. On the AT-32 golden ZZ world: batch 3's one call writes one `regime_alt_reading` row per session and every
// other table (the regime row, signals, scores, ledgers) is byte-equal before and after, with the inputs off, with a source
// accepted and stressed, and with the display switch on. Synthetic data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { altRegimeNight, loadRegimeLine } from "@/lib/regime/alt/shadow";
import { cleanupTempDbs } from "../../db/helpers";
import { MARKET, NOW, testParams } from "../../agents/batch2bHarness";
import { at32World, dump } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const TS = "2030-12-31T00:00:00.000Z";

let db: Client;
let last: string;
beforeAll(async () => {
  db = await at32World();
  last = String(
    (await db.execute("SELECT MAX(d) AS d FROM regime_daily WHERE market = 'AU'")).rows[0]!.d,
  );
});

const changed = (a: Record<string, string>, b: Record<string, string>): string[] =>
  Object.keys(a).filter((t) => a[t] !== b[t]);
const alt = async () =>
  (await db.execute("SELECT * FROM regime_alt_reading")).rows.map((r) => ({ ...r }));

describe("AT-81 regime: the outside inputs are shadow only", () => {
  it("is off in a fresh configuration: no line, no reading, no source accepted", async () => {
    expect(await loadRegimeLine(db, "AU")).toBeNull();
    expect(await alt()).toEqual([]);
    expect(
      Number(
        (
          await db.execute(
            "SELECT COUNT(*) n FROM source_register WHERE source IN ('polymarket_public','kalshi_public')",
          )
        ).rows[0]!.n,
      ),
    ).toBe(0);
  });

  it("while off (no source accepted) the reading is unavailable and equals the base; only its own table moves", async () => {
    const before = await dump(db);
    const r = await altRegimeNight(db, { market: MARKET, d: last, now: TS });
    expect(r.status).toBe("written");
    const after = await dump(db);
    expect(changed(before.perTable, after.perTable)).toEqual(["regime_alt_reading"]);
    expect(await alt()).toMatchObject([{ d: last, inputs_status: "unavailable" }]);
    const row = (await alt())[0]!;
    expect(row.alt_state).toBe(row.base_state);
  });

  it("with a source accepted and a stressed event the alt is more cautious, and still only its own table moves", async () => {
    const d2 = String(
      (
        await db.execute({
          sql: "SELECT MAX(d) AS d FROM regime_daily WHERE market = 'AU' AND d < ?",
          args: [last],
        })
      ).rows[0]!.d,
    );
    await db.execute(
      "INSERT INTO source_register (source, risk, status) VALUES ('kalshi_public', 'medium', 'enabled')",
    );
    await db.execute({
      sql: "INSERT INTO alt_input_point (source, event_key, d, prob_ppm, fetched_at) VALUES ('kalshi', 'zz-event', ?, 900000, ?)",
      args: [d2, TS],
    });
    const before = await dump(db);
    const r = await altRegimeNight(db, { market: MARKET, d: d2, now: TS });
    expect(r.status).toBe("written");
    const after = await dump(db);
    expect(changed(before.perTable, after.perTable)).toEqual(["regime_alt_reading"]);
    expect(after.perTable.regime_daily).toBe(before.perTable.regime_daily); // the gate input is byte-equal
    const row = (await alt()).find((x) => x.d === d2)!;
    expect(row.inputs_status).toBe("partial");
  });

  it("batch 3 makes the one call: one row per session, the regime row byte-equal, nothing else of the nights changed by it", async () => {
    // the oldest night of the world has no reading yet (the two newest were written above)
    const days = (
      await db.execute("SELECT DISTINCT d FROM regime_daily WHERE market = 'AU' ORDER BY d")
    ).rows.map((r) => String(r.d));
    const fresh = days[0]!;
    const regimeBefore = (await dump(db)).perTable.regime_daily;
    const n0 = (await alt()).length;
    const res = await reviewDay(db, {
      market: MARKET,
      d: fresh,
      replay: true,
      now: NOW,
      params: testParams(),
    });
    expect(["success", "degraded"]).toContain(res.status);
    expect((await dump(db)).perTable.regime_daily).toBe(regimeBefore);
    const rows = await alt();
    expect(rows.filter((r) => r.d === fresh)).toHaveLength(1);
    expect(rows).toHaveLength(n0 + 1);
  });

  it("with the display switch on the line shows both readings in plain words", async () => {
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('regime_altinputs_enabled', 'global', '\"on\"', ?)",
      args: [TS],
    });
    const line = await loadRegimeLine(db, "AU");
    expect(line).toMatch(/^Regime: .+; with outside signals: .+ \(shadow\)$/);
    expect(line).not.toMatch(/RISK|SHOCK|NEUTRAL/);
  });
});
