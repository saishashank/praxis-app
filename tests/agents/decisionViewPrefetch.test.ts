// @vitest-environment node
// D-910: the batched prefetch answers bars / shortInterest / insiderNotices / insiderCoverage with
// exactly the rows the per-code queries return, falls back to the query when its range is too short,
// and keeps the look-ahead guards (no row after D, no instant at or after the cut-off). Synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LookAheadError, createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { cleanupTempDbs, freshDb } from "../db/helpers";

vi.setConfig({ testTimeout: 60000 });
afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const D = "2026-10-15";
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);
const DAYS = ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
type V = string | number | null;

async function world(): Promise<Client> {
  const db = await freshDb("main");
  const run = (sql: string, args: V[]) => db.execute({ sql, args });
  for (const code of ["AAA", "BBB", "CCC"]) {
    for (const [i, d] of DAYS.entries()) {
      if (code === "BBB" && i === 2) continue; // a missing bar
      const c = 10 + i;
      await run(
        `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
         VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
        [code, d, c, c, c, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
      );
      await run(
        `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
         VALUES ('AU', ?, ?, ?, ?, ?, 0, 't')`,
        [code, d, 100 + i, `${d}T06:00:00.000Z`, `${d}T06:00:00.000Z`],
      );
    }
    // poison: after D
    await run(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU', ?, '2026-10-16', 999, 999, 999, 999, 1, 'test', '2026-10-16T06:00:00.000Z', '2026-10-16T06:05:00.000Z')`,
      [code],
    );
  }
  await run(
    `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
     VALUES ('AU', 'i1', 'AAA', 'sh_new', NULL, '2026-10-13T01:00:00.000Z', 'v1'),
            ('AU', 'i2', 'AAA', 'sh_new', 5, '2026-10-12T01:00:00.000Z', 'v1'),
            ('AU', 'i3', 'CCC', 'sh_new', NULL, ?, 'v1')`,
    [CUTOFF], // i3 at the cut-off: invisible
  );
  return db;
}

const SINCE = "2026-10-01T00:00:00.000Z";

async function answers(db: Client, prefetch: boolean) {
  let calls = 0;
  const counted = {
    execute: (q: Parameters<Client["execute"]>[0]) => {
      calls += 1;
      return db.execute(q);
    },
  } as Client;
  const v = createDecisionView(counted, {
    market: "AU",
    d: D,
    cutoff: CUTOFF,
    liveIngestBound: true,
  });
  if (prefetch)
    await v.prefetch!({
      codes: ["AAA", "BBB", "CCC"],
      barsFromD: "2026-10-09",
      shortFromD: "2026-10-09",
      insiderSinceIso: SINCE,
    });
  const before = calls;
  const out: unknown[] = [];
  for (const code of ["AAA", "BBB", "CCC", "ZZZ"]) {
    out.push(await v.bars(code, 4));
    out.push(await v.bars(code, 6)); // longer than the prefetched range: falls back
    out.push(await v.bars(code, 1, "2026-10-13"));
    out.push(await v.shortInterest(code, 3));
    out.push(await v.insiderNotices(code, SINCE));
  }
  out.push(await v.insiderCoverage());
  return { out, queries: calls - before };
}

describe("DecisionView prefetch (D-910)", () => {
  it("returns exactly what the per-code queries return", async () => {
    const db = await world();
    const plain = await answers(db, false);
    const fast = await answers(db, true);
    expect(fast.out).toEqual(plain.out);
    // bars(code, 4), shortInterest, insiderNotices of the 3 prefetched codes and the coverage answer
    // from memory; the longer bars, the other upTo and the unprefetched ZZZ still query
    expect(plain.queries - fast.queries).toBe(10);
  });

  it("keeps the look-ahead guards", async () => {
    const view = createDecisionView(await freshDb("main"), { market: "AU", d: D, cutoff: CUTOFF });
    const req = { codes: ["AAA"], barsFromD: D, shortFromD: D, insiderSinceIso: SINCE };
    await expect(view.prefetch!({ ...req, barsFromD: "2026-10-16" })).rejects.toThrow(
      LookAheadError,
    );
    await expect(view.prefetch!({ ...req, insiderSinceIso: CUTOFF })).rejects.toThrow(
      LookAheadError,
    );
  });
});
