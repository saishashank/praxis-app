// @vitest-environment node
// M22 E5 (DAT-248, D-1440, D-1441): the one nightly call. Inert while off: the gate input (regime_daily) and every other table
// are byte-equal; gate-only when on: no other table changes either; one row per session; unavailable while no source is accepted.
import { afterEach, describe, expect, it } from "vitest";
import {
  altRegimeNight,
  inputsJson,
  latestAltReading,
  loadRegimeLine,
  regimeLineOf,
} from "@/lib/regime/alt/shadow";
import { cleanupTempDbs } from "../../db/helpers";
import { D, NOW, accept, dumpOthers, putPoint, putRegime, setKey, world } from "./harness";

afterEach(cleanupTempDbs);

const rows = async (db: Awaited<ReturnType<typeof world>>) =>
  (await db.execute("SELECT * FROM regime_alt_reading")).rows.map((r) => ({ ...r }));

describe("altRegimeNight", () => {
  it("writes one unavailable row equal to the base while no source is accepted, and nothing else changes", async () => {
    const db = await world();
    await putRegime(db, D, "RISK-ON");
    const before = await dumpOthers(db);
    const r = await altRegimeNight(db, { market: "AU", d: D, now: NOW });
    expect(r).toEqual({
      status: "written",
      base: "RISK-ON",
      alt: "RISK-ON",
      inputs: "unavailable",
    });
    expect(await rows(db)).toHaveLength(1);
    expect((await rows(db))[0]).toMatchObject({
      base_state: "RISK-ON",
      alt_state: "RISK-ON",
      inputs_status: "unavailable",
    });
    expect(await dumpOthers(db)).toBe(before); // the gate input (regime_daily) and every other table byte-equal
  });

  it("with an accepted source and a stressed event the alt is one step more cautious; the base is untouched", async () => {
    const db = await world();
    await putRegime(db, D, "NEUTRAL");
    await accept(db, "polymarket_public");
    await putPoint(db, "polymarket", "e1", D, 900_000);
    const before = await dumpOthers(db);
    const r = await altRegimeNight(db, { market: "AU", d: D, now: NOW });
    expect(r).toMatchObject({
      status: "written",
      base: "NEUTRAL",
      alt: "RISK-OFF",
      inputs: "partial",
    });
    expect(await dumpOthers(db)).toBe(before);
    const stored = await db.execute({
      sql: "SELECT state FROM regime_daily WHERE d = ?",
      args: [D],
    });
    expect(stored.rows[0]!.state).toBe("NEUTRAL");
  });

  it("is one row per session: a second call changes nothing", async () => {
    const db = await world();
    await putRegime(db, D, "RISK-ON");
    await altRegimeNight(db, { market: "AU", d: D, now: NOW });
    const again = await altRegimeNight(db, { market: "AU", d: D, now: "2030-02-01T11:00:00.000Z" });
    expect(again).toEqual({ status: "already_done" });
    expect(await rows(db)).toHaveLength(1);
  });

  it("writes nothing without a base row", async () => {
    const db = await world();
    expect(await altRegimeNight(db, { market: "AU", d: D, now: NOW })).toEqual({
      status: "no_base",
    });
    expect(await rows(db)).toHaveLength(0);
  });

  it("uses the newest rule version's base state", async () => {
    const db = await world();
    await putRegime(db, D, "RISK-ON", 1);
    await putRegime(db, D, "RISK-OFF", 2);
    const r = await altRegimeNight(db, { market: "AU", d: D, now: NOW });
    expect(r).toMatchObject({ base: "RISK-OFF" });
  });

  it("keeps the stored inputs inside the column limit", () => {
    const predictions = Array.from({ length: 50 }, (_, i) => ({
      source: "polymarket",
      eventKey: `event-${"x".repeat(100)}-${i}`,
      d: D,
      probPpm: 500_000,
    }));
    const text = inputsJson({
      macroSources: [],
      enabledPrediction: [],
      predictions,
      macro: [],
      status: "partial",
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(text).predictions.length).toBeGreaterThan(0);
  });
});

describe("the Cortex line (D-1441)", () => {
  it("is null while the switch is off, shows both readings in plain words when on", async () => {
    const db = await world();
    await putRegime(db, D, "RISK-ON");
    await accept(db, "kalshi_public");
    await putPoint(db, "kalshi", "e1", D, 700_000);
    await altRegimeNight(db, { market: "AU", d: D, now: NOW });
    expect(await loadRegimeLine(db, "AU")).toBeNull();
    await setKey(db, "regime_altinputs_enabled", "on");
    expect(await loadRegimeLine(db, "AU")).toBe(
      "Regime: Calm and rising; with outside signals: Mixed (shadow)",
    );
    expect((await latestAltReading(db, "AU"))?.alt).toBe("NEUTRAL");
    expect(regimeLineOf({ d: D, base: "NEUTRAL", alt: "RISK-OFF", inputsStatus: "ok" })).toBe(
      "Regime: Mixed; with outside signals: Nervous (shadow)",
    );
  });
});
