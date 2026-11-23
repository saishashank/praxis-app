// @vitest-environment node
// D-1856: late bars only on the Owner's dated rerun. On Fri 20 Nov 2026 the day's bars were stored
// after the 18:10 cut-off, so the live decision view hid them (GL look-ahead guard) and the night had
// no strategy signals. A scheduled night keeps that guard unchanged; only a manual
// `arena-signals.yml` dispatch naming a past date (`--date D --rerun`) reads such bars, and even then
// never a bar dated after D.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const seen: { rerun: unknown; d: unknown }[] = [];
vi.mock("@/lib/agents/batch2b", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agents/batch2b")>();
  return {
    ...real,
    signalsDay: vi.fn(async (_db: unknown, o: { rerun?: unknown; d: unknown }) => {
      seen.push({ rerun: o.rerun, d: o.d });
      throw new Error("stop after the call (the arguments are the test)");
    }),
  };
});

import { barsIngestBound, lateIndexBars } from "@/lib/agents/candidates";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { signalsMain } from "@/lib/arena/cli";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const D = "2026-11-20"; // Friday, AEDT
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff); // 18:10 Melbourne = 07:10Z
const bar = (db: Client, d: string, c: number, ingested: string) =>
  db.execute({
    sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
          VALUES ('AU', 'AAA', ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
    args: [d, c, c, c, c, `${d}T06:00:00.000Z`, ingested],
  });

describe("barsIngestBound", () => {
  it("a scheduled live night hides late bars; a dated rerun and a replay read them", () => {
    expect(barsIngestBound({ replay: false })).toBe(true);
    expect(barsIngestBound({ replay: false, lateBars: false })).toBe(true);
    expect(barsIngestBound({ replay: false, lateBars: true })).toBe(false);
    expect(barsIngestBound({ replay: true })).toBe(false);
  });
});

describe("decision view of Fri 20 Nov with the bars stored late", () => {
  async function world() {
    const db = await freshDb("main");
    await bar(db, "2026-11-19", 10, "2026-11-19T06:05:00.000Z");
    await bar(db, D, 12, "2026-11-20T13:30:00.000Z"); // stored 00:30 Sat Melbourne, after the cut-off
    await bar(db, "2026-11-23", 999, "2026-11-23T06:05:00.000Z"); // Monday: after D, never visible
    return db;
  }

  it("scheduled night: Friday's own late bar is hidden (guard unchanged)", async () => {
    const view = createDecisionView(await world(), {
      market: "AU",
      d: D,
      cutoff: CUTOFF,
      liveIngestBound: barsIngestBound({ replay: false }),
    });
    expect((await view.bars("AAA", 10)).map((b) => b.d)).toEqual(["2026-11-19"]);
  });

  it("dated rerun: Friday's late bar is read; Monday's bar is still never read", async () => {
    const view = createDecisionView(await world(), {
      market: "AU",
      d: D,
      cutoff: CUTOFF,
      liveIngestBound: barsIngestBound({ replay: false, lateBars: true }),
    });
    const bars = await view.bars("AAA", 10);
    expect(bars.map((b) => b.d)).toEqual(["2026-11-19", D]);
    expect(bars.at(-1)!.close).toBe(12_000_000n);
  });
});

describe("D-1857: Fri 20 Nov's index bar was published after the cut-off too", () => {
  const ix = (db: Client, d: string, c: number, published: string) =>
    db.execute({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [d, c, c, c, c, published, published],
    });
  async function world() {
    const db = await freshDb("main");
    await ix(db, "2026-11-19", 8_000_000_000, "2026-11-19T06:30:00.000Z");
    await ix(db, D, 8_100_000_000, "2026-11-20T13:30:00.000Z"); // after the 07:10Z cut-off
    await ix(db, "2026-11-23", 9_999_000_000, "2026-11-23T06:30:00.000Z"); // after D: never read
    return db;
  }
  const view = async (late: boolean) =>
    createDecisionView(await world(), {
      market: "AU",
      d: D,
      cutoff: CUTOFF,
      liveIngestBound: barsIngestBound({ replay: false, lateBars: late }),
      lateIndexBars: lateIndexBars({ replay: false, lateBars: late }),
    });

  it("lateIndexBars only on a dated live rerun, never on a scheduled night or a replay", () => {
    expect(lateIndexBars({ replay: false })).toBe(false);
    expect(lateIndexBars({ replay: false, lateBars: true })).toBe(true);
    expect(lateIndexBars({ replay: true, lateBars: true })).toBe(false);
  });

  it("scheduled night: the late index bar is hidden, so the regime cannot be read for D", async () => {
    expect((await (await view(false)).indexBars("AXJO", 10)).map((b) => b.d)).toEqual([
      "2026-11-19",
    ]);
  });

  it("dated rerun: the late index bar is read; Monday's is still never read", async () => {
    const bars = await (await view(true)).indexBars("AXJO", 10);
    expect(bars.map((b) => b.d)).toEqual(["2026-11-19", D]);
    expect(bars.at(-1)!.close).toBe(8_100_000_000n);
  });
});

describe("signals CLI passes `rerun` to batch 2b only on a dated rerun", () => {
  // 11:00 Sun 22 Nov Melbourne: Friday is still the latest session
  const NOW = Date.parse("2026-11-22T00:00:00.000Z");

  async function call(argv: string[]) {
    const url = tempDbUrl();
    const db = track(createClient({ url }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    seen.length = 0;
    const lines: string[] = [];
    const code = await signalsMain(
      argv,
      { TURSO_MAIN_URL: url },
      {
        nowMs: () => NOW,
        out: (s) => lines.push(s),
        sleep: async () => {},
        openDb: (u) => createClient({ url: u, intMode: "bigint" }),
      },
    );
    return { code, lines, seen: [...seen] };
  }

  it("--date 2026-11-20 --rerun: rerun true", async () => {
    const r = await call(["--date", D, "--rerun", "--phase", "2b"]);
    expect(r.seen).toEqual([{ rerun: true, d: D }]);
  });

  it("a scheduled night (no flags) and a plain --date: rerun false", async () => {
    expect((await call(["--phase", "2b"])).seen.map((s) => s.rerun)).toEqual([false]);
    expect((await call(["--date", D, "--phase", "2b"])).seen.map((s) => s.rerun)).toEqual([false]);
  });

  it("a refused rerun never reaches batch 2b", async () => {
    const r = await call(["--date", "2026-11-19", "--rerun", "--phase", "2b"]);
    expect(r.code).toBe(2);
    expect(r.seen).toEqual([]);
  });
});
