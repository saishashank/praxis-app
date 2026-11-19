// @vitest-environment node
// M22 E5 (DAT-248, D-1439): the alt inputs per market. Pending sources give nothing; an accepted source's newest fresh point is
// read; the macro sources come from the market profile.
import { afterEach, describe, expect, it } from "vitest";
import { enabledPredictionSources, macroSourcesOf, readAltInputs } from "@/lib/regime/alt/inputs";
import { cleanupTempDbs } from "../../db/helpers";
import { D, accept, putPoint, world } from "./harness";

afterEach(cleanupTempDbs);

describe("readAltInputs", () => {
  it("is unavailable while no source is accepted, even with stored points", async () => {
    const db = await world();
    await putPoint(db, "polymarket", "e1", D, 900_000);
    const i = await readAltInputs(db, { market: "AU", d: D });
    expect(i.status).toBe("unavailable");
    expect(i.predictions).toEqual([]);
    expect(await enabledPredictionSources(db)).toEqual([]);
  });

  it("reads the newest fresh point of an accepted source and ignores a stale one", async () => {
    const db = await world();
    await accept(db, "polymarket_public");
    await putPoint(db, "polymarket", "e1", "2030-01-30", 300_000);
    await putPoint(db, "polymarket", "e1", "2030-01-31", 700_000);
    await putPoint(db, "polymarket", "e2", "2029-12-01", 900_000); // stale
    await putPoint(db, "kalshi", "e3", D, 800_000); // its row is not accepted
    const i = await readAltInputs(db, { market: "AU", d: D });
    expect(i.predictions).toEqual([
      { source: "polymarket", eventKey: "e1", d: "2030-01-31", probPpm: 700_000 },
    ]);
    expect(i.status).toBe("partial");
  });

  it("is ok with both kinds and takes the macro sources from the profile", async () => {
    const db = await world();
    expect(await macroSourcesOf(db, "AU")).toEqual(["rba", "abs"]);
    await accept(db, "kalshi_public");
    await putPoint(db, "kalshi", "e1", D, 100_000);
    await db.execute({
      sql: "INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at) VALUES ('rba', 'FIRMMCRTD', '2030-01-15', 4000000, 'x')",
      args: [],
    });
    const i = await readAltInputs(db, { market: "AU", d: D });
    expect(i.status).toBe("ok");
    expect(i.macro).toEqual([
      { source: "rba", seriesId: "FIRMMCRTD", d: "2030-01-15", valueMicro: "4000000" },
    ]);
  });

  it("refuses a malformed day", async () => {
    const db = await world();
    await expect(readAltInputs(db, { market: "AU", d: "x" })).rejects.toThrow(RangeError);
  });
});
