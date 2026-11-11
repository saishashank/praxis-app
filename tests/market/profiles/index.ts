// Market-aware test matrix harness (TST-139, D-970; M19 adds the markets, not the harness).
// One JSON file per BUILT market in this folder (`<CODE>.json`); `builtMarketFixtures()` reads them all, so a new
// market is a new file and no code change. `describeEachMarket(name, fn)` runs a suite once per built market, with
// the profile as its argument, and names each run "<name> [<CODE>]". AU, IN and US exist from M19 (IN and US generated from their seeds by
// scripts/market/gen-fixtures.mjs, built and off, never on before the AU confidence step, PRD-040); AT-68 is E2's.
import type { Client } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe } from "vitest";

export type MarketProfileFixture = {
  readonly code: string;
  readonly name: string;
  /** The market table's time zone (the exchange's own). */
  readonly tz: string;
  /** The zone the decision cut-off is written in (the Owner's Melbourne time). */
  readonly decisionTz: string;
  readonly openTime: string;
  readonly closeTime: string;
  readonly cutoffTime: string;
  readonly currency: string;
  /** The mode the market has in production. */
  readonly productionMode: "full" | "data_only" | "off";
  /** The mode a freshly migrated database seeds it with. */
  readonly seededMode: "full" | "data_only" | "off";
  readonly built: boolean;
  readonly note?: string;
};

const DIR = import.meta.dirname;
const CODE = /^[A-Z]{2,5}$/;

/** Every `<CODE>.json` of this folder, sorted by code; a file that does not hold its own code is an error. */
export function builtMarketFixtures(dir: string = DIR): MarketProfileFixture[] {
  const out: MarketProfileFixture[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => /^[A-Z]{2,5}\.json$/.test(x))
    .sort()) {
    const p = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as MarketProfileFixture;
    if (!CODE.test(p.code) || `${p.code}.json` !== f) {
      throw new Error(`market profile ${f} must hold its own code`);
    }
    out.push(p);
  }
  return out;
}

/** Runs `fn` once per built market: `describeEachMarket("the picks page", (m) => { ... })`. */
export function describeEachMarket(
  name: string,
  fn: (market: MarketProfileFixture) => void,
  fixtures: readonly MarketProfileFixture[] = builtMarketFixtures(),
): void {
  for (const m of fixtures) describe(`${name} [${m.code}]`, () => fn(m));
}

/**
 * The production shape (TST-139, D-970): every market named in a run record has a `market` row. Used by the
 * recorded-day job and the market tests; returns the offending codes (empty = ok). Only distinct markets are read.
 * rows-ok: DISTINCT over run_record.market, at most the 180-day window, and only on a local test database.
 */
export async function marketsWithoutRow(db: Pick<Client, "execute">): Promise<string[]> {
  const r = await db.execute(
    `SELECT DISTINCT market FROM run_record WHERE market IS NOT NULL
       AND market NOT IN (SELECT code FROM market) ORDER BY market`,
  );
  return r.rows.map((x) => String(x.market));
}
