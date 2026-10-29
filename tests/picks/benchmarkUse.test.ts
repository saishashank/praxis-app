// DAT-235 (M14 WP2): every comparison against the market uses the total-return series of
// `picks/benchmark.ts`, never the `^AXJO` price index. Two parts: a source guard (no reader outside the
// allowlist reads `index_bar` or the index code, so a new comparison has to come through
// `loadTotalReturnSeries`) and a database check that the series carries the dividends.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTotalReturnSeries } from "@/lib/picks/benchmark";
import { setConfig } from "@/lib/config/store";
import {
  parseVendorActionsText,
  writeVendorActions,
} from "../../src/lib/data/vendorActions/vendorActions.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { pipelineDb } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const SRC = path.resolve(__dirname, "../../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(n) ? [p] : [];
  });
const rel = (p: string): string => path.relative(SRC, p).split(path.sep).join("/");

// Readers of raw index levels that are NOT comparisons: the ingest and snapshot plumbing, the
// regime / A3 input of the agents, the index strip of the company page (a level and its change).
const NON_COMPARISON_READERS = new Set([
  "lib/picks/benchmark.ts",
  "lib/agents/candidates.ts",
  "lib/agents/decisionView.ts",
  "lib/agents/schema.ts",
  "lib/data/backfill/snapshotCore.mjs",
  "lib/data/backfill/snapshotLoad.mjs",
  "lib/data/index/indexBars.mjs",
  "lib/replay/snapshotWorld.ts",
  "lib/ui/loaders/company.ts",
]);

describe("DAT-235: market comparisons use the total-return series", () => {
  it("no other source file reads index_bar: a comparison goes through picks/benchmark", () => {
    const readers = walk(SRC)
      .filter((p) => /\bindex_bar\b/.test(readFileSync(p, "utf8")))
      .map(rel)
      .filter((r) => !NON_COMPARISON_READERS.has(r));
    expect(readers).toEqual([]);
  });

  it("the series reinvests the ETF dividends when vendor coverage reaches the window start", async () => {
    const db = await pipelineDb();
    await setConfig(db, {
      key: "c1_etf_code",
      value: "ZZETF",
      userId: null,
      now: "2030-01-01T00:00:00.000Z",
    });
    const days = ["2030-01-02", "2030-01-03", "2030-01-04"];
    for (const d of days) {
      await db.execute({
        sql: "INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at) VALUES ('AU','AXJO',?,?,?,?,?,'yahoo_index',?,?)",
        args: [
          d,
          100_000_000,
          100_000_000,
          100_000_000,
          100_000_000,
          `${d}T07:00:00.000Z`,
          `${d}T07:00:00.000Z`,
        ],
      });
      await db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU','ZZETF',?,50,50,50,50,1000,'yahoo_eod',?,?)`,
        args: [d, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
      });
    }
    const rows = parseVendorActionsText(
      JSON.stringify([
        {
          code: "ZZETF",
          ex_date: "2029-12-15",
          kind: "dividend",
          amount: 0.5,
          currency: "AUD",
          source: "yahoo",
          fetched_at: "2030-01-01T07:30:00.000Z",
        },
        {
          code: "ZZETF",
          ex_date: "2030-01-03",
          kind: "dividend",
          amount: 0.5,
          currency: "AUD",
          source: "yahoo",
          fetched_at: "2030-01-04T07:30:00.000Z",
        },
      ]),
    ).rows;
    await writeVendorActions(db, { rows });
    const r = await loadTotalReturnSeries(db, "AU", "AXJO", "2030-01-02", "2030-01-04");
    expect(r.basis).toBe("total_return");
    // flat index; 0.5 on a 50 ETF close is +1% on the ex-date session, held after
    expect(r.series.map((p) => p.levelMicro)).toEqual([100_000_000n, 101_000_000n, 101_000_000n]);
  });
});
