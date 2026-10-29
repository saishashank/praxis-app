// @vitest-environment node
// Golden replay of the daily orchestrator (M3 T10; AT-12 golden replay, AT-13 byte-identical,
// TST-102 reproducibility, TST-109 no look-ahead). Three synthetic years (780 sessions, ZZ codes
// only) are replayed through the REAL migrations and the REAL closeBooksDay twice, into two
// separate database files; the engine rows must serialise byte for byte the same, every stored
// day must satisfy the ARN-101 invariants, and every terminal state must occur.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { replaySessions } from "@/lib/arena/replay";
import { LookAheadError, createMarketData } from "@/lib/arena/marketData";
import { cleanupTempDbs } from "../db/helpers";
import {
  MARKET,
  NOW,
  dumpTables,
  makeStrategy,
  paramOverridesFor,
  setupReplay,
  verifyCohort,
  type FullSetup,
} from "./replayHarness";

afterEach(cleanupTempDbs);

const THREE_YEARS = {
  startD: "2030-01-07",
  sessions: 780,
  seed: 11,
  dividendAt: 120,
  splitAt: 400,
  haltFrom: 250,
  haltTo: 290,
  gateFailEvery: 61,
};

// A deliberate engine change updates this value in the same commit (it is the golden replay).
const GOLDEN_DIGEST = "243a3cd1084399c90835f875afc0adc03f01a8294764e270c07498b4608fde50";

async function runReplay(): Promise<FullSetup & { statuses: string[] }> {
  const setup = await setupReplay(THREE_YEARS);
  const results = await replaySessions(setup.db, {
    market: MARKET,
    from: setup.ds.dates[0],
    to: setup.ds.dates[setup.ds.dates.length - 1],
    now: NOW,
    afterClose: makeStrategy(setup.db, setup.ds),
    restartParams: paramOverridesFor,
  });
  return { ...setup, statuses: results.map((r) => r.status) };
}

const digest = (tables: Record<string, string>): string =>
  createHash("sha256")
    .update(
      Object.entries(tables)
        .map(([k, v]) => `${k}\n${v}`)
        .join("\n--\n"),
    )
    .digest("hex");

const count = async (db: FullSetup["db"], sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0].n);

describe("AT-12 / AT-13: three-year golden replay of the daily orchestrator", () => {
  it("two replays give byte-identical rows; invariants hold on every day; every terminal state occurs", async () => {
    const a = await runReplay();
    const b = await runReplay();

    // every one of the 780 sessions closed cleanly in both runs
    expect(a.statuses).toHaveLength(780);
    expect(new Set(a.statuses)).toEqual(new Set(["success"]));
    expect(b.statuses).toEqual(a.statuses);

    // AT-13 / ARN-102: fill, cash_ledger, nav_daily, nav_daily_pos, cohort, cohort_event
    const da = await dumpTables(a.db);
    const db2 = await dumpTables(b.db);
    for (const table of Object.keys(da)) {
      expect(db2[table].length, table).toBe(da[table].length);
      expect(db2[table] === da[table], `${table} differs between the two replays`).toBe(true);
    }
    expect(da.nav_daily.split("\n").length).toBeGreaterThan(1000);
    expect(da.fill.split("\n").length).toBeGreaterThan(150);
    expect(da.cash_ledger.split("\n").length).toBeGreaterThan(1500);
    expect(digest(da)).toBe(GOLDEN_DIGEST);

    // AT-12: ARN-101 every day, no error logged, no run failed or degraded
    expect(await count(a.db, "SELECT COUNT(*) AS n FROM nav_daily WHERE invariants_ok = 0")).toBe(
      0,
    );
    expect(await count(a.db, "SELECT COUNT(*) AS n FROM app_log WHERE level = 'error'")).toBe(0);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM run_record WHERE status <> 'success'"),
    ).toBe(0);

    // AT-12: terminal states occur, each with its terminal and liquidation records
    const kinds = (await a.db.execute("SELECT DISTINCT terminal_kind AS k FROM cohort")).rows
      .map((r) => String(r.k))
      .sort();
    expect(kinds).toEqual(expect.arrayContaining(["bust", "stalled", "target", "timeout"]));
    expect(
      await count(
        a.db,
        `SELECT COUNT(*) AS n FROM cohort c WHERE terminal_kind IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM cohort_event e WHERE e.cohort_id = c.id AND e.kind = 'terminal')`,
      ),
    ).toBe(0);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM cohort_event WHERE kind = 'liquidated'"),
    ).toBeGreaterThan(5);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM cohort WHERE restart_of IS NOT NULL"),
    ).toBeGreaterThan(5);
    // a successor of an ENDED cohort starts at the open after the liquidation open (ARN-053);
    // the successor of a cohort that went to shadow starts then too, while the shadow runs on
    const ended = await a.db.execute(
      `SELECT c.id AS id, c.start_d AS start_d, p.terminal_d AS terminal_d FROM cohort c
         JOIN cohort p ON p.id = c.restart_of
         WHERE EXISTS (SELECT 1 FROM cohort_event e WHERE e.cohort_id = p.id AND e.kind = 'restart'
                       AND json_extract(e.detail_json, '$.new_cohort_id') = c.id)`,
    );
    expect(ended.rows.length).toBeGreaterThan(3);
    for (const r of ended.rows) {
      const after = a.ds.dates.slice(a.ds.dates.indexOf(String(r.terminal_d)) + 2)[0];
      expect(String(r.start_d), String(r.id)).toBe(after);
    }
    const shadows = await a.db.execute(
      `SELECT c.start_d AS s, p.terminal_d AS t FROM cohort c JOIN cohort p ON p.id = c.restart_of
         WHERE EXISTS (SELECT 1 FROM cohort_event e WHERE e.cohort_id = p.id AND e.kind = 'shadow_continue')`,
    );
    expect(shadows.rows.length).toBeGreaterThan(3);

    // the mechanisms the golden replay is meant to exercise all happened
    const rules = (await a.db.execute("SELECT DISTINCT rule AS r FROM fill")).rows.map((r) =>
      String(r.r),
    );
    expect(rules).toEqual(expect.arrayContaining(["open", "close_signal", "level"]));
    const exits = (await a.db.execute("SELECT DISTINCT exit_type AS t FROM trade")).rows.map((r) =>
      String(r.t),
    );
    expect(exits).toEqual(expect.arrayContaining(["CS", "IS", "terminal"]));
    expect(
      await count(
        a.db,
        "SELECT COUNT(*) AS n FROM arena_order WHERE reject_reason = 'gate' AND status = 'cancelled'",
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM sleeve_trade WHERE closed_by = 'closeout'"),
    ).toBeGreaterThan(0);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM sleeve_state WHERE state = 'locked'"),
    ).toBeGreaterThan(0);
    expect(
      await count(a.db, "SELECT COUNT(*) AS n FROM cash_ledger WHERE kind = 'settle'"),
    ).toBeGreaterThan(100);

    // ARN-101 over the whole stored history of the busiest cohorts, rebuilt from the ledger alone
    const busiest = (
      await a.db.execute(
        "SELECT cohort_id AS id FROM nav_daily GROUP BY cohort_id ORDER BY COUNT(*) DESC, cohort_id LIMIT 3",
      )
    ).rows.map((r) => String(r.id));
    for (const id of busiest) {
      const violations = await verifyCohort(a.db, a.ds, id);
      expect(
        violations.filter((v) => v.fatal !== false),
        id,
      ).toEqual([]);
    }
  }, 300_000);
});

describe("TST-109: closing day D reads nothing dated after D", () => {
  const SMALL = {
    startD: "2030-01-07",
    sessions: 90,
    seed: 5,
    dividendAt: 20,
    splitAt: 45,
    gateFailEvery: 17,
  };

  it("the guarded market data refuses a date after the closing day", async () => {
    const { db, ds } = await setupReplay({ ...SMALL, sessions: 30 });
    const data = createMarketData(db, MARKET, ds.dates[10]);
    await expect(data.bar("ZZA", ds.dates[10])).resolves.not.toBeNull();
    await expect(data.bar("ZZA", ds.dates[11])).rejects.toBeInstanceOf(LookAheadError);
    await expect(data.lastClose("ZZA", ds.dates[11])).rejects.toBeInstanceOf(LookAheadError);
    await expect(data.adv("ZZA", ds.dates[11])).rejects.toBeInstanceOf(LookAheadError);
    await expect(data.halted("ZZE", ds.dates[11])).rejects.toBeInstanceOf(LookAheadError);
    await expect(data.ingestedAt(ds.dates[11])).rejects.toBeInstanceOf(LookAheadError);
  });

  it("wildly different future bars change nothing: same rows as a database without a future", async () => {
    const cut = 50;
    const poisoned = await setupReplay({ ...SMALL, poisonAfter: cut });
    const clean = await setupReplay({ ...SMALL, stopAfter: cut });
    const run = async (s: FullSetup) =>
      replaySessions(s.db, {
        market: MARKET,
        from: s.ds.dates[0],
        to: s.ds.dates[cut],
        now: NOW,
        afterClose: makeStrategy(s.db, s.ds),
        restartParams: paramOverridesFor,
      });
    const [ra, rb] = [await run(poisoned), await run(clean)];
    expect(ra.map((r) => r.status)).toEqual(rb.map((r) => r.status));
    const da = await dumpTables(poisoned.db);
    const db2 = await dumpTables(clean.db);
    for (const t of Object.keys(da)) expect(db2[t] === da[t], t).toBe(true);
    expect(da.nav_daily.length).toBeGreaterThan(100);
  }, 120_000);

  it("every price_bar / universe_snapshot read while closing day D is bounded by D", async () => {
    const { db, ds } = await setupReplay({ ...SMALL, sessions: 60 });
    const seen: { sql: string; dates: string[]; closing: string }[] = [];
    let closing = ds.dates[0];
    const spy = new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return (stmt: string | { sql: string; args?: unknown[] }) => {
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            const args = typeof stmt === "string" ? [] : (stmt.args ?? []);
            seen.push({
              sql,
              closing,
              dates: args.filter(
                (a): a is string => typeof a === "string" && a.length === 10 && a[4] === "-",
              ),
            });
            return target.execute(stmt as never);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { closeBooksDay } = await import("@/lib/arena/closeBooks");
    const strategy = makeStrategy(db, ds);
    for (const d of ds.dates.slice(0, 41)) {
      closing = d;
      const r = await closeBooksDay(spy, { market: MARKET, d, replay: true, now: NOW });
      expect(r.status).toBe("success");
      await strategy(d, r);
    }
    const market = seen.filter((s) => /FROM (price_bar|universe_snapshot)/.test(s.sql));
    expect(market.length).toBeGreaterThan(20);
    for (const q of market) {
      expect(q.sql).toMatch(/d <= \?/);
      expect(q.dates.length).toBeGreaterThan(0);
      for (const date of q.dates) expect(date <= q.closing, `${date} > ${q.closing}`).toBe(true);
    }
  }, 120_000);
});
