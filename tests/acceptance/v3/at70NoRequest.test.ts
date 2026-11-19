// @vitest-environment node
// M20 US1 (AT-70, AT-38; D-1094, MKT-110): under the PRODUCTION seed (the US off, mode off) the US batch-1 and its fetch
// step make ZERO requests to EDGAR, FINRA or Nasdaq. Every entry refuses before any client call: the day module's
// `assertMarketEnabled`, the EDGAR client's own market check (before it reads the contact), the fetch step, the CLI. A
// spy on the global `fetch` proves no request leaves; a static scan proves no file under sources/us/ calls the global
// `fetch` directly (everything goes through the polite client). The CI `recorded-day` job's `assert-net` is the
// second proof on the real pipeline.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareBatch1, runBatch1 } from "@/lib/data/pipeline/batch1-core.mjs";
import { createEdgarClient, submissionsUrl } from "@/lib/data/sources/us/edgar.mjs";
import { createPoliteFetch, PoliteFetchRefused } from "@/lib/data/sources/politeFetch.mjs";
import { isMarketNotEnabled } from "@/lib/market/guard.mjs";
import { cleanupTempDbs, freshDb, ROOT } from "../../db/helpers";
import { run as runUs } from "../../../scripts/ingest/us/run.mjs";
import { fetchNight } from "../../../scripts/ingest/us/fetch.mjs";

afterEach(cleanupTempDbs);

let spy: ReturnType<typeof vi.fn>;
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  spy = vi.fn(async () => new Response("", { status: 200 }));
  globalThis.fetch = spy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("AT-70: no EDGAR, FINRA or Nasdaq request under the production seed", () => {
  it("the seed is the production shape: the US is off", async () => {
    const db = await freshDb("main");
    const r = await db.execute("SELECT enabled, mode FROM market WHERE code = 'US'");
    expect(r.rows[0]).toMatchObject({ enabled: 0, mode: "off" });
  });

  it("the EDGAR client refuses with MarketNotEnabled before it reads the contact, and makes no request", async () => {
    const db = await freshDb("main");
    const env = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error("the contact was read while the market is off");
      },
    });
    const c = createEdgarClient({ db, market: "US", env });
    await expect(c.getJson(submissionsUrl(9990001))).rejects.toSatisfy(isMarketNotEnabled);
    await expect(c.getText("https://www.sec.gov/files/company_tickers.json")).rejects.toSatisfy(
      isMarketNotEnabled,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("the polite client refuses an EDGAR, FINRA and Nasdaq host while the market is off", async () => {
    const db = await freshDb("main");
    const p = createPoliteFetch({ db });
    for (const [url, source] of [
      ["https://data.sec.gov/submissions/CIK0009990001.json", "us_edgar"],
      ["https://cdn.finra.org/equity/regsho/daily/CNMSshvol20261102.txt", "us_finra_short"],
      ["https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", "us_nasdaq_halts"],
    ] as const) {
      // an unregistered source row is refused first; either way, no request
      await expect(p.fetch(url, { source, userAgent: "Praxis/1 (x)" })).rejects.toBeInstanceOf(
        PoliteFetchRefused,
      );
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("the fetch step refuses before any request", async () => {
    const db = await freshDb("main");
    await expect(
      fetchNight({
        db,
        market: "US",
        env: { PRAXIS_EDGAR_CONTACT: "x" },
        request: { codes: ["ZZA"], end: "2026-11-02" },
      }),
    ).rejects.toSatisfy(isMarketNotEnabled);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the batch-1 day refuses before any write or request (prepare and run)", async () => {
    const db = await freshDb("main");
    await expect(
      prepareBatch1(db, { nowMs: Date.parse("2026-11-02T23:30:00Z"), market: "US" }),
    ).rejects.toSatisfy(isMarketNotEnabled);
    await expect(
      runBatch1(db, {
        nowMs: () => Date.parse("2026-11-02T23:30:00Z"),
        market: "US",
        barsText: "[]",
      }),
    ).rejects.toSatisfy(isMarketNotEnabled);
    const rr = await db.execute("SELECT COUNT(*) AS n FROM run_record WHERE market = 'US'");
    expect(Number(rr.rows[0]!.n)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("the CLI exits 2 with the fixed refusal line, before reading anything", async () => {
    const lines: string[] = [];
    const env = { TURSO_MAIN_URL: "file:unused" };
    for (const cmd of [
      ["prepare", "--market", "US", "--request", "r.json"],
      ["run", "--market", "US", "--bars", "b.json"],
    ]) {
      const db = await freshDb("main"); // the CLI closes its database
      const code = await runUs(cmd, env, { openDb: () => db, out: (s: string) => lines.push(s) });
      expect(code).toBe(2);
    }
    expect(lines.every((l) => l.includes("refused: market not enabled"))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("static: nothing under sources/us/ or scripts/ingest/us/ calls the global fetch (the polite client is the only way out)", () => {
    const dirs = [path.join(ROOT, "src/lib/data/sources/us"), path.join(ROOT, "scripts/ingest/us")];
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => /\.(mjs|ts)$/.test(x))) {
        const text = readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
          .join("\n");
        expect(/(?<![.\w])fetch\(/.test(text), `${f} calls the global fetch`).toBe(false);
        expect(
          /new XMLHttpRequest|axios|node-fetch|undici|https?\.request\(/.test(text),
          `${f} uses another client`,
        ).toBe(false);
      }
    }
  });
});
