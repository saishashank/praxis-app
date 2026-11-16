// @vitest-environment node
// D-1078: `snapshotFeatureSource`, the feature nights a warm start rebuilds from a snapshot world: a night
// outside the world or before any frozen passport gives null; otherwise the fixed Cortex's features of
// that evening, with one replay shared by the nights that have the same angle statuses; and the CLI path
// (`--mode cortex-warm-start`) that builds it from a snapshot only when a night was never stored. ZZ data.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { angleById } from "@/lib/cortex/angles/registry";
import { insertPassport } from "@/lib/cortex/store";
import { createCortexReplay } from "@/lib/replay/cortexReplay";
import { buildSnapshot, loadSnapshot } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import { replayMain } from "@/lib/replay/cli";
import { snapshotFeatureSource } from "@/lib/replay/warmStartSource";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";

vi.mock("@/lib/replay/cortexReplay", async (orig) => {
  const m = await orig<typeof import("@/lib/replay/cortexReplay")>();
  return { ...m, createCortexReplay: vi.fn(m.createCortexReplay) };
});

const params = defaultAgentParams();
const CODES = Array.from({ length: 24 }, (_, i) => `ZZ${String(i + 1).padStart(2, "0")}`);
const CAL = weekdayCalendar(420, "2026-01-05");
const N1 = CAL[400]!;
const N2 = CAL[401]!;
const N3 = CAL[410]!;
const SWITCH = `${CAL[405]!}T00:00:00.000Z`; // a later passport version frozen between N2 and N3
const IDS = ["A-D1-02", "A-D2-01", "A-D1-06"];

function snapshotBytes(): Uint8Array {
  let seed = 4242;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const bars: Record<string, unknown>[] = [];
  const universe: Record<string, unknown>[] = [];
  CODES.forEach((code, k) => {
    let c = 5 + rnd() * 5;
    universe.push({
      d: CAL[0],
      code,
      status: "active",
      tier: "U1",
      mcap_est: 1e9,
      adv: 5e7,
      halted: 0,
    });
    for (const d of CAL) {
      const o = c;
      c = Math.max(0.5, c * (1 + 0.0025 * (1 + (k % 5)) + (rnd() - 0.5) * 0.02));
      bars.push({
        code,
        d,
        o: Number(o.toFixed(3)),
        h: Number((Math.max(o, c) * 1.004).toFixed(3)),
        l: Number((Math.min(o, c) * 0.996).toFixed(3)),
        c: Number(c.toFixed(3)),
        volume: Math.round(5_000_000 * (0.5 + rnd())),
      });
    }
  });
  let idx = 7000;
  const index_bars = CAL.map((d) => {
    idx *= 1 + (rnd() - 0.48) * 0.01;
    const m = Math.round(idx * 1e6);
    return { index_code: "AXJO", d, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
  });
  const calendar = CAL.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  return buildSnapshot({
    from: CAL[0]!,
    to: CAL[CAL.length - 1]!,
    inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
  }).bytes;
}

let world: SnapshotWorld;
beforeAll(() => {
  world = new SnapshotWorld(loadSnapshot(snapshotBytes()), { params, tierSource: "bars" });
}, 60_000);
afterAll(cleanupTempDbs);

async function passport(db: Client, id: string, version: number, status: string, frozenAt: string) {
  const a = angleById(id)!;
  await insertPassport(db, {
    market: "AU",
    angleId: id,
    version,
    domain: a.domain,
    cluster: a.cluster as never,
    orientation: a.orientation,
    kind: "score",
    inputs: [...a.inputs],
    historyFields: {},
    status: status as never,
    horizonSessions: a.horizonSessions,
    evidence: {},
    measured: null,
    frozenAt,
  });
}

const deps = (db: Client, w: SnapshotWorld = world) => ({ db, world: w, params, market: "AU" });
const built = () => vi.mocked(createCortexReplay).mock.calls.length;

describe("snapshotFeatureSource", () => {
  it("a night the snapshot world has no session for is null, without reading passports", async () => {
    const db = await freshDb("main");
    const src = await snapshotFeatureSource(deps(db));
    expect(await src("2020-01-01")).toBeNull();
    expect(await src("2026-01-03")).toBeNull(); // a Saturday: not a session
  });

  it("no frozen passports as of the night is null", async () => {
    const db = await freshDb("main");
    const src = await snapshotFeatureSource(deps(db));
    expect(await src(N1)).toBeNull();
  });

  it("builds the night's features from the passports, one replay per distinct set", async () => {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const src = await snapshotFeatureSource(deps(db));
    const before = built();

    const a = await src(N1);
    expect(a).not.toBeNull();
    expect(a!.d).toBe(N1);
    expect(a!.rows.length).toBeGreaterThan(10);
    expect(Object.keys(a!.rows[0]!.features).length).toBeGreaterThan(0);
    expect(built() - before).toBe(1);

    // the same angle set the next evening: the replay is reused and the active set is the same
    const b = await src(N2);
    expect(b!.d).toBe(N2);
    expect(built() - before).toBe(1);
    expect(b!.rows[0]!.activeSetHash).toBe(a!.rows[0]!.activeSetHash);

    // asking for the first night again is stable
    expect(await src(N1)).toEqual(a);
    expect(built() - before).toBe(1);

    // a later version retires an angle: a different set builds another replay
    await passport(db, "A-D1-02", 2, "retired", SWITCH);
    const c = await src(N3);
    expect(c).not.toBeNull();
    expect(built() - before).toBe(2);
    expect(c!.rows[0]!.activeSetHash).not.toBe(a!.rows[0]!.activeSetHash);
  }, 120_000);
});

describe("replay --mode cortex-warm-start, set-up and failures", () => {
  const keepOpen = (db: Client): Client =>
    new Proxy(db, {
      get: (t, p) => {
        if (p === "close") return () => undefined;
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const NOW_MS = Date.parse("2026-11-12T09:30:00.000Z");
  const run = async (
    argv: string[],
    env: Record<string, string | undefined>,
    deps: Parameters<typeof replayMain>[2],
  ) => {
    const lines: string[] = [];
    const code = await replayMain(["--mode", "cortex-warm-start", ...argv], env, {
      out: (l) => void lines.push(l),
      nowMs: () => NOW_MS,
      ...deps,
    });
    return { code, lines };
  };
  const LAST = CAL.slice(-30); // the database holds the last 30 sessions of the snapshot's calendar

  /** The database side: universe, passports and bars for the last 30 sessions; no stored features. */
  async function seedDb(): Promise<Client> {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const stmts: { sql: string; args: (string | number)[] }[] = CODES.map((c) => ({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [LAST[0]!, c],
    }));
    CODES.forEach((c, k) =>
      LAST.forEach((d, i) => {
        const px = 10 + k * 0.1 + Math.sin(i + k) * 0.3;
        stmts.push({
          sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
                VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'zz', 't', 't')`,
          args: [c, d, px, px * 1.01, px * 0.99, px],
        });
      }),
    );
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
    return db;
  }

  it("without a database URL, or a remote one without a token, it is not configured", async () => {
    const db = await freshDb("main");
    for (const env of [{}, { TURSO_MAIN_URL: "" }, { TURSO_MAIN_URL: "libsql://x.example.test" }]) {
      expect(await run([], env, { openDb: () => keepOpen(db) })).toEqual({
        code: 1,
        lines: ["replay: failed (database not configured)"],
      });
    }
  });

  it("a database that cannot be read fails at the set-up stage, naming the kind of error only", async () => {
    const bare = keepOpen(await freshDb("main"));
    const broken = new Proxy(bare, {
      get: (t, p) =>
        p === "execute" || p === "batch"
          ? async () => {
              throw new RangeError("secret detail https://example.test/x");
            }
          : (t as never)[p],
    });
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      { openDb: () => broken },
    );
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^replay cortex-warm-start: failed \(RangeError\) stage=setup/);
    expect(r.lines[0]).not.toContain("secret");
    expect(r.lines[0]).not.toContain("example.test");
  });

  it("an empty database has no night to plan and never asks for a snapshot", async () => {
    const db = await freshDb("main");
    let asked = 0;
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => keepOpen(db),
        prepareSnapshot: async () => {
          asked += 1;
          return new Uint8Array();
        },
      },
    );
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(
      /nights_written=0 skipped_existing=0 skipped_no_data=0 first=none last=none rows=0$/,
    );
    expect(asked).toBe(0);
  });

  it("builds the missing feature nights from the snapshot and writes the nights", async () => {
    const db = await seedDb();
    const bytes = snapshotBytes();
    let opened = 0;
    let range: { from: string; to: string } | null = null;
    const slept: number[] = [];
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => {
          opened += 1;
          return keepOpen(db);
        },
        // no params injected: they are read from the database (the defaults when it holds none)
        prepareSnapshot: async (x) => {
          range = x;
          return bytes;
        },
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(r.code).toBe(0);
    expect(opened).toBe(2); // a fresh connection after the long snapshot build
    expect(range!.to).toBe("2026-11-12");
    expect(range!.from < range!.to).toBe(true);
    expect(slept).toEqual([]); // the reconnect answered at once
    expect(r.lines).toHaveLength(1);
    const m =
      /nights_written=(\d+) skipped_existing=0 skipped_no_data=(\d+) first=(\S+) last=(\S+) rows=(\d+)$/.exec(
        r.lines[0]!,
      );
    expect(m).not.toBeNull();
    expect(Number(m![1]) + Number(m![2])).toBe(3);
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![5])).toBeGreaterThan(0);
  }, 120_000);

  it("uses injected parameters, and a reconnect that fails at first is retried after a pause", async () => {
    const db = await seedDb();
    let opened = 0;
    let selects = 0;
    const flaky = new Proxy(keepOpen(db), {
      get: (t, p) =>
        p === "execute"
          ? async (stmt: unknown) => {
              if (stmt === "SELECT 1" && (selects += 1) === 1) throw new Error("dropped");
              return t.execute(stmt as never);
            }
          : (t as never)[p],
    });
    const slept: number[] = [];
    const r = await run(
      ["--sessions", "2"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => (++opened === 1 ? keepOpen(db) : flaky),
        params,
        prepareSnapshot: async () => snapshotBytes(),
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(r.code).toBe(0);
    expect(slept).toEqual([1000]); // one failed answer, one pause, then fine
    expect(r.lines[0]).toMatch(/^replay cortex-warm-start: nights_written=\d+ /);
  }, 120_000);

  it("names the stage when the snapshot cannot be built or the reconnect never answers", async () => {
    const db = await seedDb();
    const failing = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => keepOpen(db),
        params,
        prepareSnapshot: async () => {
          throw new TypeError("secret detail https://example.test/x");
        },
      },
    );
    expect(failing.code).toBe(1);
    expect(failing.lines[0]).toMatch(
      /^replay cortex-warm-start: failed \(TypeError\) stage=snapshot/,
    );
    expect(failing.lines[0]).not.toContain("secret");

    let opened = 0;
    const dead = new Proxy(keepOpen(db), {
      get: (t, p) =>
        p === "execute"
          ? async (stmt: unknown) => {
              if (stmt === "SELECT 1") throw new Error("down");
              return t.execute(stmt as never);
            }
          : (t as never)[p],
    });
    const slept: number[] = [];
    const never = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => (++opened === 1 ? keepOpen(db) : dead),
        params,
        prepareSnapshot: async () => snapshotBytes(),
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(never.code).toBe(1);
    expect(never.lines[0]).toMatch(/^replay cortex-warm-start: failed \(Error\) stage=compute/);
    expect(slept).toEqual([1000, 2000, 3000]); // PING_TRIES = 4: three pauses, then the error
  }, 120_000);

  it("a snapshot source is required once a night's features were never stored", async () => {
    const db = await seedDb();
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      { openDb: () => keepOpen(db) },
    );
    expect(r).toEqual({ code: 1, lines: ["replay: failed (no snapshot source)"] });
  });
});
