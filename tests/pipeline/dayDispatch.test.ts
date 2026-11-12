// @vitest-environment node
// M20 A2 (D-1127): the batch-1 dispatcher. The home market's day is the pipeline in batch1-core.mjs; any other BUILT
// market (a seed module exists) runs `sources/<code>/day.mjs` found by convention; a missing module throws the fixed
// word `not built`; a code with no seed is not dispatched (the home pipeline refuses it as market_missing).
import type { Client } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import {
  loadDayModule,
  prepareBatch1,
  runBatch1,
  runsHomeDay,
} from "@/lib/data/pipeline/batch1-core.mjs";

const db = {} as Client;
const NOW = () => Date.UTC(2030, 0, 3, 7, 30);

describe("runsHomeDay", () => {
  it("is true for the home market and for a code with no seed, false for IN and US", () => {
    expect(runsHomeDay("AU")).toBe(true);
    expect(runsHomeDay("ZZ")).toBe(true);
    expect(runsHomeDay("IN")).toBe(false);
    expect(runsHomeDay("US")).toBe(false);
  });
});

describe("the convention", () => {
  it("passes the lower-case code to the loader and runs prepareDay / runDay with the market set", async () => {
    const prepareDay = vi.fn(async () => ({ action: "skip", target: "2030-01-03", reason: "x" }));
    const runDay = vi.fn(async () => ({
      exit: 0,
      status: "skipped",
      target: "2030-01-03",
      dates: [],
    }));
    const seen: string[] = [];
    const dayLoader = async (code: string) => {
      seen.push(code);
      return { prepareDay, runDay };
    };
    const p = await prepareBatch1(db, { nowMs: Date.now(), market: "IN", dayLoader });
    expect(p).toMatchObject({ action: "skip" });
    expect(prepareDay).toHaveBeenCalledWith(db, expect.objectContaining({ market: "IN" }));
    const r = await runBatch1(db, { nowMs: NOW, market: "US", barsText: null, dayLoader });
    expect(r).toMatchObject({ exit: 0, status: "skipped" });
    expect(runDay).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ market: "US", barsText: null }),
    );
    expect(seen).toEqual(["in", "us"]);
  });

  it("a built market with no module throws the fixed word `not built`, naming no path", async () => {
    const missing = async () => {
      throw new Error("Cannot find module D:\\secret\\path\\day.mjs");
    };
    await expect(runBatch1(db, { nowMs: NOW, market: "IN", dayLoader: missing })).rejects.toThrow(
      /^not built$/,
    );
    await expect(
      prepareBatch1(db, { nowMs: Date.now(), market: "US", dayLoader: missing }),
    ).rejects.toThrow(/^not built$/);
  });

  it("a module without both functions is not built either", async () => {
    await expect(loadDayModule("IN", async () => ({ runDay: () => null }))).rejects.toThrow(
      "not built",
    );
    await expect(loadDayModule("IN", async () => null)).rejects.toThrow("not built");
  });

  it("a malformed code never reaches the loader (no path can be built from it)", async () => {
    const loader = vi.fn();
    for (const bad of ["../x", "in", "A/B", "A", "ABCDEFGHI", ""]) {
      await expect(loadDayModule(bad, loader)).rejects.toThrow("not built");
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("the home market and an unknown code never call the loader", async () => {
    const dayLoader = vi.fn();
    // an unknown code reaches the home pipeline, which refuses it before any write: market_missing
    const scratch = await import("@libsql/client");
    const c = scratch.createClient({ url: ":memory:" });
    try {
      const { loadMigrations, migrateUp } = await import("@/lib/db/migrate-core.mjs");
      const { MIGRATIONS } = await import("../db/helpers");
      await migrateUp(c, await loadMigrations(MIGRATIONS("main")));
      const r = await runBatch1(c, { nowMs: NOW, market: "ZZ", barsText: null, dayLoader });
      expect(r).toMatchObject({ exit: 1, status: "failed", reason: "market_missing" });
    } finally {
      c.close();
    }
    expect(dayLoader).not.toHaveBeenCalled();
  });
});
