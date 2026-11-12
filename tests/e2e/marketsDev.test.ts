// @vitest-environment node
// M19 E2 (D-994, D-1077, UXN-312): the development state `markets-dev` enables the built markets named by
// PRAXIS_MARKETS_ENABLED in the throwaway e2e database, and does nothing when the variable is unset (every CI lane
// keeps the production shape that `market-built-off` and e2e/market-off.spec.ts assert).
import { afterEach, describe, expect, it } from "vitest";
import { apply, marketsFromEnv } from "../../e2e/seed/states/markets-dev.mjs";
import * as builtOff from "../../e2e/seed/states/market-built-off.mjs";
import { STATE_NAMES } from "../../e2e/seed/states.mjs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const state = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  (await db.execute("SELECT code, enabled, mode FROM market ORDER BY code")).rows.map(
    (r) => `${String(r.code)}:${Number(r.enabled)}:${String(r.mode)}`,
  );

describe("markets-dev", () => {
  it("reads the variable like production does: unset or empty is AU, unknown codes are dropped", () => {
    expect(marketsFromEnv({})).toEqual(["AU"]);
    expect(marketsFromEnv({ PRAXIS_MARKETS_ENABLED: "" })).toEqual(["AU"]);
    expect(marketsFromEnv({ PRAXIS_MARKETS_ENABLED: "AU,IN,US" })).toEqual(["AU", "IN", "US"]);
    expect(marketsFromEnv({ PRAXIS_MARKETS_ENABLED: "in, zz" })).toEqual(["IN"]);
  });

  it("is not one of the production-shape states of `all` (it contradicts market-built-off)", () => {
    expect(STATE_NAMES).not.toContain("markets-dev");
  });

  it("unset: nothing changes, and the production-shape state still passes", async () => {
    const db = await freshDb("main");
    const before = await state(db);
    expect(await apply(db, undefined, {})).toEqual(["AU"]);
    expect(await state(db)).toEqual(before);
    await builtOff.apply(db);
  });

  it("AU,IN,US: every built market is enabled with its mode off; applying it twice changes nothing; market-built-off refuses", async () => {
    const db = await freshDb("main");
    const env = { PRAXIS_MARKETS_ENABLED: "AU,IN,US" };
    expect(await apply(db, undefined, env)).toEqual(["AU", "IN", "US"]);
    const once = await state(db);
    expect(once.filter((s) => s.startsWith("IN") || s.startsWith("US"))).toEqual([
      "IN:1:off",
      "US:1:off",
    ]);
    await apply(db, undefined, env);
    expect(await state(db)).toEqual(once);
    await expect(builtOff.apply(db)).rejects.toThrow(/expected markets AU enabled/);
  });
});
