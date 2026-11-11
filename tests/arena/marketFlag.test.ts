// @vitest-environment node
// M19 B2 (MKT-110 a, D-996): the `--market` flag of the arena and picks command lines. No literal default: the
// flag, else the single enabled market, else "market required"; a market that is not enabled is refused with the
// fixed words, and the pre-open route and the picks CLI refuse it the same way.
import { afterEach, describe, expect, it } from "vitest";
import {
  MARKET_NOT_ENABLED_LINE,
  MARKET_REQUIRED_LINE,
  resolveCliMarket,
} from "@/lib/arena/marketFlag";
import { picksMain } from "@/lib/picks/cli";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("resolveCliMarket", () => {
  it("omitted: the single enabled market (production: AU)", async () => {
    const db = await freshDb("main");
    expect(await resolveCliMarket(db, [])).toEqual({ ok: true, market: "AU" });
    expect(await resolveCliMarket(db, ["--date", "2026-10-13"])).toEqual({
      ok: true,
      market: "AU",
    });
  });

  it("--market AU passes; --market IN and --market US are refused under the seed", async () => {
    const db = await freshDb("main");
    expect(await resolveCliMarket(db, ["--market", "AU"])).toEqual({ ok: true, market: "AU" });
    for (const m of ["IN", "US", "ZZ"]) {
      expect(await resolveCliMarket(db, ["--market", m])).toEqual({
        ok: false,
        line: MARKET_NOT_ENABLED_LINE,
      });
    }
    expect(MARKET_NOT_ENABLED_LINE).toBe("refused: market not enabled");
  });

  it("two enabled markets and no flag: market required; the flag picks one", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    expect(await resolveCliMarket(db, [])).toEqual({ ok: false, line: MARKET_REQUIRED_LINE });
    expect(await resolveCliMarket(db, ["--market", "IN"])).toEqual({ ok: true, market: "IN" });
    expect(MARKET_REQUIRED_LINE).toBe("refused: market required");
  });

  it("no enabled market at all: market required", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 0, mode = 'off' WHERE code = 'AU'");
    expect(await resolveCliMarket(db, [])).toEqual({ ok: false, line: MARKET_REQUIRED_LINE });
  });
});

describe("picksMain", () => {
  it("--market IN under the seed: exit 2 with the fixed words", async () => {
    const db = await freshDb("main");
    const lines: string[] = [];
    const code = await picksMain(
      ["--market", "IN", "--date", "2026-10-13"],
      { TURSO_MAIN_URL: "file:ignored", TURSO_MAIN_TOKEN: "t" },
      {
        openDb: () => db,
        out: (s) => lines.push(s),
        nowMs: () => Date.parse("2026-10-13T08:00:00Z"),
      },
    );
    expect(code).toBe(2);
    expect(lines).toEqual(["arena-picks: refused: market not enabled"]);
  });
});
