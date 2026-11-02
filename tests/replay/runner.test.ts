// @vitest-environment node
// T16 replay run end to end on a small synthetic snapshot (ZZ codes, invented numbers): modes light,
// full and evidence produce the migration 0008 rows and write-once files, the compute report is
// within budget, an over-budget run stops with `paused_budget` and keeps no partial statistics, the
// CLI persists the rows idempotently into a migrated database, and null/injected modes write their
// size and power rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSnapshot } from "@/lib/replay/snapshot";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayMain } from "@/lib/replay/cli";
import { runReplay } from "@/lib/replay/runner";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";

const params = defaultAgentParams();
const CODES = Array.from({ length: 12 }, (_, i) => `ZZ${String.fromCharCode(65 + i)}`);
const SESSIONS = 640;

function snapshotBytes(): Uint8Array {
  const cal = weekdayCalendar(SESSIONS, "2027-01-04");
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const bars: Record<string, unknown>[] = [];
  const universe: Record<string, unknown>[] = [];
  for (const code of CODES) {
    let c = 5 + rnd() * 5;
    universe.push({
      d: cal[0],
      code,
      status: "active",
      tier: "U1",
      mcap_est: 1e9,
      adv: 5e6,
      halted: 0,
    });
    for (const d of cal) {
      const o = c;
      c = Math.max(0.5, c * (1 + (rnd() - 0.48) * 0.04));
      const h = Math.max(o, c) * 1.005;
      const l = Math.min(o, c) * 0.995;
      bars.push({
        code,
        d,
        o: Number(o.toFixed(2)),
        h: Number(h.toFixed(2)),
        l: Number(l.toFixed(2)),
        c: Number(c.toFixed(2)),
        volume: Math.round(500_000 * (0.5 + rnd())),
      });
    }
  }
  let idx = 7000;
  const index_bars = cal.map((d) => {
    idx *= 1 + (rnd() - 0.48) * 0.01;
    const m = Math.round(idx * 1e6);
    return { index_code: "AXJO", d, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
  });
  const calendar = cal.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  return buildSnapshot({
    from: cal[0]!,
    to: cal[cal.length - 1]!,
    inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
  }).bytes;
}

let bytes: Uint8Array;
let tick = 0;
const clock = (stepMs: number) => () => (tick += stepMs);
beforeAll(() => {
  bytes = snapshotBytes();
}, 60_000);
afterAll(cleanupTempDbs);

const base = (mode: "light" | "full" | "evidence", over = {}) => ({
  mode,
  d: "2029-06-29",
  params,
  commitSha: "a".repeat(40),
  nodeVersion: "v22",
  snapshotBytes: bytes,
  now: Date.now,
  ...over,
});

describe("replay runs", () => {
  it("full: rows, files, compute report within budget, deterministic", () => {
    const a = runReplay(base("full"));
    expect(a.report.status).toBe("complete");
    expect(a.report.within).toBe(true);
    expect(a.report.stages.map((s) => s.stage)).toEqual([
      "world",
      "ledger",
      "cohorts",
      "stats",
      "stats",
    ]);
    expect(a.run.kind).toBe("full");
    expect(a.run.commit_sha).toBe("a".repeat(40));
    expect(a.stats.some((s) => s.scope === "run" && s.metric === "compute_report")).toBe(true);
    expect(a.files.map((f) => f.name).every((n) => /^replay-[a-z0-9-]+\.jsonl\.gz$/.test(n))).toBe(
      true,
    );
    expect(a.validation).toHaveLength(0);
  }, 120_000);

  it("is deterministic (digest excludes the clock)", () => {
    const x = runReplay(base("light", { since: "2029-03-01" }));
    const y = runReplay(base("light", { since: "2029-03-01" }));
    expect(y.run.files_json).toBe(x.run.files_json);
  }, 120_000);

  it("light: starts from `since` and is cheaper", () => {
    const since = "2029-03-01";
    const l = runReplay(base("light", { since }));
    expect(l.run.kind).toBe("light");
    expect(l.report.status).toBe("complete");
  }, 120_000);

  it("evidence: trial rows precede results; every group gets a label (insufficient or deferred here)", () => {
    const e = runReplay(base("evidence"));
    expect(e.run.kind).toBe("evidence");
    expect(e.report.stages.map((s) => s.stage)).toContain("validation");
    for (const v of e.validation) {
      expect(e.trials.some((t) => t.lineage_id === v.lineage_id)).toBe(true);
    }
    const groups = new Set(e.labels.map((l) => `${l.execution_id}|${l.variant}`));
    expect(groups.size).toBe(e.labels.length);
  }, 180_000);

  it("over budget: stops cleanly, records paused_budget, keeps no partial statistics", () => {
    tick = 0;
    const p = runReplay(base("full", { now: clock(60_000), budgetMinutes: 1 }));
    expect(p.report.status).toBe("paused_budget");
    expect(p.report.within).toBe(false);
    expect(p.report.pausedAt).not.toBeNull();
    expect(p.files).toHaveLength(0);
    expect(p.stats.map((s) => s.metric).sort()).toEqual(["compute_report", "status"]);
  }, 60_000);
});

describe("null and injected modes", () => {
  it("null (synthetic): size and uniformity rows; injected: power row", () => {
    const n = runReplay({
      ...base("full"),
      mode: "null",
      snapshotBytes: null,
      synthetic: true,
      nullRuns: 30,
    });
    expect(n.validation.filter((v) => v.test === "size")).toHaveLength(2);
    expect(n.validation.some((v) => v.test === "ks")).toBe(true);
    expect(n.size?.n).toBe(30);
    const i = runReplay({ ...base("full"), mode: "injected", snapshotBytes: null, nullRuns: 5 });
    expect(i.validation[0]!.test).toBe("i");
    expect(i.validation[0]!.outcome).toBe("detected");
  }, 120_000);
});

describe("null runs on a snapshot (production path, decision 31)", () => {
  it("runs random-signal ledgers with controls and records a size report", () => {
    const n = runReplay({ ...base("full"), mode: "null", nullRuns: 2 });
    expect(n.run.kind).toBe("null");
    expect(n.report.stages.map((s) => s.stage)).toEqual(["world", "null"]);
    expect(n.size).not.toBeNull();
    expect(n.stats.some((s) => s.scope === "null" && s.metric === "size_report")).toBe(true);
  }, 120_000);
});

describe("CLI", () => {
  it("persists into a migrated database, once", async () => {
    const db = await freshDb("main");
    const lines: string[] = [];
    const deps = {
      openDb: () =>
        new Proxy(db, {
          get: (t, k) => {
            if (k === "close") return () => undefined;
            const v = Reflect.get(t, k) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        }),
      out: (s: string) => lines.push(s),
      params,
      prepareSnapshot: async () => bytes,
      nodeVersion: "v22",
    };
    const argv = ["--mode", "full", "--date", "2029-06-29"];
    const env = { TURSO_MAIN_URL: "file:test", COMMIT_SHA: "b".repeat(40) };
    expect(await replayMain(argv, env, { ...deps })).toBe(0);
    expect(lines[0]).toMatch(/^replay full: complete minutes=/);
    const runs = await db.execute("SELECT kind, commit_sha FROM replay_run");
    expect(runs.rows).toHaveLength(1);
    const stats = await db.execute("SELECT COUNT(*) AS n FROM replay_stat");
    expect(Number(stats.rows[0]!.n)).toBeGreaterThan(5);
    expect(await replayMain(argv, env, { ...deps })).toBe(0);
    expect(lines[1]).toBe("replay full: already recorded");
    expect(await replayMain(["--mode", "nope"], env, deps)).toBe(2);
  }, 180_000);
});
