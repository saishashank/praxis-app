// @vitest-environment node
// M6 T12: replay mode `learning` end to end on a small synthetic snapshot (ZZ codes, invented numbers)
// and a migrated database: stage order, rows, ARN-076 and AGT-112 outputs, idempotent per ISO week, a
// budget stop recorded as paused_budget and resumed from the first unfinished stage next run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayMain } from "@/lib/replay/cli";
import { learningRunId, learningWeek } from "@/lib/replay/learningMode";
import { buildSnapshot } from "@/lib/replay/snapshot";
import { RUN_MODES, budgetFor, runReplay } from "@/lib/replay/runner";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { world as learningWorld } from "../learning/challengerFixtures";

const params = defaultAgentParams();
const CODES = Array.from({ length: 12 }, (_, i) => `ZZ${String.fromCharCode(65 + i)}`);
const SESSIONS = 640;
const STAGES = [
  "forward",
  "comparisons",
  "lessons",
  "preregistered",
  "challengers",
  "rolls",
  "arn076",
  "factors",
  "robustness",
  "rankIc",
];

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
beforeAll(() => {
  bytes = snapshotBytes();
}, 60_000);
afterAll(cleanupTempDbs);

const handle = (db: Client) =>
  new Proxy(db, {
    get: (t, k) => {
      if (k === "close") return () => undefined;
      const v = Reflect.get(t, k) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

const COMMIT = "c".repeat(40);
const env = { TURSO_MAIN_URL: "file:test", COMMIT_SHA: COMMIT };
const FRIDAY = "2029-06-29";
const SATURDAY = "2029-06-30";

function deps(db: Client, lines: string[], extra: Record<string, unknown> = {}) {
  return {
    openDb: () => handle(db),
    out: (s: string) => lines.push(s),
    params,
    prepareSnapshot: async () => bytes,
    nodeVersion: "v22",
    ...extra,
  };
}

const rows = async (db: Client, sql: string) => (await db.execute(sql)).rows;
const stageOrder = (line: string): string[] =>
  /stages=([^ ]+)/
    .exec(line)![1]!
    .split(",")
    .map((s) => s.split(":")[0]!);

describe("mode learning is a replay mode with the light budget", () => {
  it("is offered by the runner and CLI; the synchronous runner refuses it", () => {
    expect(RUN_MODES).toContain("learning");
    expect(budgetFor("learning", params)).toBe(params.replay.lightMinutes);
    expect(() =>
      runReplay({
        mode: "learning",
        d: SATURDAY,
        params,
        commitSha: COMMIT,
        nodeVersion: "v22",
        snapshotBytes: bytes,
        now: Date.now,
      }),
    ).toThrow(/runLearning/);
    expect(learningWeek(FRIDAY)).toBe(learningWeek(SATURDAY));
    expect(learningWeek(SATURDAY)).not.toBe(learningWeek("2029-07-07"));
    expect(learningRunId("AU", "2029-26", "a".repeat(64), COMMIT)).toBe(
      "replay:learning:AU:2029-26:aaaaaaaa:cccccccc",
    );
  });
});

describe("weekly learning run", () => {
  it("runs every stage in order, writes ARN-076 and AGT-112 outputs, and is a no-op for the rest of the week", async () => {
    const { db } = await learningWorld(["F1"]);
    const lines: string[] = [];
    const d = deps(db, lines);
    const argv = ["--mode", "learning", "--date", SATURDAY];
    expect(await replayMain(argv, env, d)).toBe(0);
    expect(lines[0]).toMatch(/^replay learning: complete minutes=/);
    expect(stageOrder(lines[0]!)).toEqual(STAGES);

    const run = (await rows(db, "SELECT id, kind FROM replay_run"))[0]!;
    expect(run.kind).toBe("learning");
    expect(String(run.id)).toMatch(/^replay:learning:AU:2029-26:/);
    const markers = await rows(
      db,
      "SELECT metric FROM replay_stat WHERE scope = 'learning' AND metric LIKE 'stage:%' ORDER BY metric",
    );
    expect(markers.map((m) => m.metric)).toEqual(
      STAGES.slice(1)
        .map((s) => `stage:${s}`)
        .sort(),
    );
    expect(
      await rows(db, "SELECT 1 FROM replay_stat WHERE scope = 'learning' AND metric = 'status'"),
    ).toHaveLength(1);

    // ARN-076: F6 classes (a)-(d), F4 with/without the event filter, the other families n/a
    const arn = JSON.parse(
      String(
        (await rows(db, "SELECT value_json FROM replay_stat WHERE metric = 'arn076'"))[0]!
          .value_json,
      ),
    ) as {
      f6: { classes: { class: string }[] };
      f4: { withFilter: { disabled: string | null }; withoutFilter: { disabled: string | null } };
      notApplicable: { family: string; text: string }[];
    };
    expect(arn.f6.classes.map((c) => c.class)).toEqual(["a", "b", "c", "d"]);
    expect(arn.f4.withFilter.disabled).toBeNull();
    expect(arn.f4.withoutFilter.disabled).toBe("event_filter");
    expect(arn.notApplicable.map((n) => n.family)).toEqual(["F1", "F2", "F3", "F5"]);
    expect(new Set(arn.notApplicable.map((n) => n.text))).toEqual(
      new Set(["n/a — one evidence class"]),
    );

    // AGT-112: the stat and the table agree; only F1 has a lineage here
    const fb = JSON.parse(
      String(
        (await rows(db, "SELECT value_json FROM replay_stat WHERE metric = 'factor_buckets'"))[0]!
          .value_json,
      ),
    ) as { rows: number; written: number };
    const stored = Number((await rows(db, "SELECT COUNT(*) AS n FROM factor_bucket_stat"))[0]!.n);
    expect(stored).toBe(fb.written);
    expect(stored).toBe(fb.rows);
    for (const r of await rows(db, "SELECT DISTINCT family FROM factor_bucket_stat")) {
      expect(r.family).toBe("F1");
    }

    // idempotent per ISO week: the same day, and another day of the week, do nothing
    const before = Number((await rows(db, "SELECT COUNT(*) AS n FROM replay_stat"))[0]!.n);
    expect(await replayMain(argv, env, d)).toBe(0);
    expect(await replayMain(["--mode", "learning", "--date", FRIDAY], env, d)).toBe(0);
    expect(lines[1]).toBe("replay learning: already recorded");
    expect(lines[2]).toBe("replay learning: already recorded");
    expect(Number((await rows(db, "SELECT COUNT(*) AS n FROM replay_stat"))[0]!.n)).toBe(before);
  }, 900_000);

  it("a budget stop is recorded as paused_budget, keeps nothing of the cut stage, and the next run resumes", async () => {
    const db = await freshDb("main");
    const lines: string[] = [];
    let t = 0;
    const clock = () => (t += 15_000); // every clock read is 15 s
    const argv = ["--mode", "learning", "--date", SATURDAY];
    expect(
      await replayMain([...argv, "--budget-minutes", "2"], env, deps(db, lines, { nowMs: clock })),
    ).toBe(0);
    expect(lines[0]).toMatch(/^replay learning: paused_budget at lessons /);
    const marks = await rows(
      db,
      "SELECT metric FROM replay_stat WHERE scope = 'learning' AND metric LIKE 'stage:%'",
    );
    expect(marks.map((m) => m.metric)).toEqual(["stage:comparisons"]);
    expect(
      await rows(db, "SELECT 1 FROM replay_stat WHERE scope = 'learning' AND metric = 'status'"),
    ).toHaveLength(0);
    const paused = await rows(
      db,
      "SELECT value_json FROM replay_stat WHERE metric LIKE 'paused:%'",
    );
    expect(paused).toHaveLength(1);
    expect(JSON.parse(String(paused[0]!.value_json))).toEqual({
      status: "paused_budget",
      stage: "lessons",
    });
    // no statistics of the cut-off stage
    expect(await rows(db, "SELECT 1 FROM replay_stat WHERE metric = 'lessons'")).toHaveLength(0);

    // the next run (default budget, real clock) skips comparisons and finishes the week
    const lines2: string[] = [];
    expect(await replayMain(argv, env, deps(db, lines2))).toBe(0);
    expect(lines2[0]).toMatch(/^replay learning: complete /);
    expect(stageOrder(lines2[0]!)).toEqual([
      "forward",
      "lessons",
      "preregistered",
      "challengers",
      "rolls",
      "arn076",
      "factors",
      "robustness",
      "rankIc",
    ]);
    expect(
      await rows(
        db,
        "SELECT metric FROM replay_stat WHERE scope = 'learning' AND metric LIKE 'stage:%'",
      ),
    ).toHaveLength(9);
    expect(
      await rows(db, "SELECT 1 FROM replay_stat WHERE scope = 'learning' AND metric = 'status'"),
    ).toHaveLength(1);
    const lines3: string[] = [];
    expect(await replayMain(argv, env, deps(db, lines3))).toBe(0);
    expect(lines3[0]).toBe("replay learning: already recorded");
  }, 900_000);
});
