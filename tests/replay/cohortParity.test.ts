// @vitest-environment node
// Parity of the in-memory cohort replay with the database engine (M4 T14; design 4.7, decision 30):
// the golden nights of batch 2b (real migrations, closeBooksDay + signalsDay) are replayed against a
// local file, and the same bars go through replayCohorts. Every stored NAV, liquidation NAV and
// open-position count of the chosen cohorts must agree session by session -- entries, IS and CS
// exits, C2/C3 matched controls, the leverage sleeve with its lock and shadow trades, and (second
// scenario) a cash dividend and a 2-for-1 split in the hold.
// D-091 follow-up: a held code that halts for more than 20 sessions (ARN-026 suspension mark with the
// haircut from session 21, no fill, no exit), an entry blocked by the data-quality gate, and a terminal
// wind-down with a halted holding (liquidation at the next open, legacy move, `liquidated` outcome)
// give the same NAV, liquidation NAV, stored positions and outcome in the replay and the engine.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  NO_TERMINAL,
  addAction,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { MASTER_SEED } from "../arena/replayHarness";
import { buildGolden, FILLERS } from "../agents/batch2bScenario";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";
import { replayCohorts, type CohortDayTrace } from "@/lib/replay/cohortReplay";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { ParamOverrides } from "@/lib/arena/cohort";
import { makeRational } from "@/lib/money/rational";
import { entriesAllowed, type EntryDecision } from "@/lib/data/quality/gate";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
afterEach(cleanupTempDbs);

const START = 295;
const END = 322;
const params = testParams();
const CODES = ["ZZD1", "ZZD2", "ZZD3", "ZZUP", ...FILLERS];

type Stored = Map<string, Map<string, { nav: bigint; liq: bigint; open: bigint; pos: string }>>;

async function storedNav(db: Client): Promise<Stored> {
  const stored: Stored = new Map();
  const rs = await db.execute(
    "SELECT cohort_id, d, nav_micro, liq_nav_micro, open_positions FROM nav_daily ORDER BY cohort_id, d",
  );
  const ps = await db.execute(
    "SELECT cohort_id, d, code, qty, close_micro, value_micro, haircut FROM nav_daily_pos ORDER BY cohort_id, d, code",
  );
  const posOf = new Map<string, string[]>();
  for (const r of ps.rows) {
    const k = `${r.cohort_id}|${r.d}`;
    const list = posOf.get(k) ?? [];
    list.push(`${r.code}:${r.qty}:${r.close_micro}:${r.value_micro}:${r.haircut}`);
    posOf.set(k, list);
  }
  for (const r of rs.rows) {
    const m = stored.get(String(r.cohort_id)) ?? new Map();
    m.set(String(r.d), {
      nav: BigInt(r.nav_micro as never),
      liq: BigInt(r.liq_nav_micro as never),
      open: BigInt(r.open_positions as never),
      pos: (posOf.get(`${r.cohort_id}|${r.d}`) ?? []).join(";"),
    });
    stored.set(String(r.cohort_id), m);
  }
  return stored;
}

type Scenario = {
  /** Last session run (default END). */
  readonly end?: number;
  /** A code halted (universe flag, no bar) on the sessions `from..to` inclusive. */
  readonly halts?: readonly { code: string; from: number; to: number }[];
  /** A data-quality flag that blocks entries of the code on the session. */
  readonly blocks?: readonly { code: string; at: number }[];
  /** Cohort parameter overrides (terminal rules) for both sides. */
  readonly overrides?: ParamOverrides;
};

type ParityResult = {
  entries: number;
  cohorts: number;
  accruals: number;
  rebases: number;
  /** Entries of the same replay without the gate source (all pass). */
  entriesUngated: number;
  haircutDays: number;
  liquidated: {
    id: string;
    d: string;
    realised: bigint;
    legacy: bigint;
    /** The liquidation NAV at the terminal close (what the old replay took as the outcome). */
    terminalLiq: bigint;
    /** Positions held at the terminal close. */
    held: number;
  }[];
  heldOnHalt: number;
  gateBlocked: number;
};

async function parity(
  keep: readonly string[],
  actions: readonly { code: string; type: string; ex: number; payload: Record<string, unknown> }[],
  splitAt?: number,
  scn: Scenario = {},
): Promise<ParityResult> {
  const end = scn.end ?? END;
  const db = await freshReplayDb();
  await buildGolden(db, {}, splitAt);
  // price_bar and universe_snapshot are append-only: lift the guards of this scratch database to
  // turn the halted sessions into a universe flag without a bar
  for (const h of scn.halts ?? []) {
    await db.execute("DROP TRIGGER IF EXISTS price_bar_prune_only");
    await db.execute("DROP TRIGGER IF EXISTS universe_snapshot_no_update");
    await db.execute({
      sql: "DELETE FROM price_bar WHERE code = ? AND d >= ? AND d <= ?",
      args: [h.code, DATES[h.from]!, DATES[h.to]!],
    });
    await db.execute({
      sql: "UPDATE universe_snapshot SET halted = 1 WHERE code = ? AND d >= ? AND d <= ?",
      args: [h.code, DATES[h.from]!, DATES[h.to]!],
    });
  }
  for (const b of scn.blocks ?? []) {
    await db.execute({
      sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, blocks_entries)
            VALUES ('AU', ?, ?, 'synthetic', 'high', ?, 1)`,
      args: [b.code, DATES[b.at]!, `${DATES[b.at]!}T07:00:00.000Z`],
    });
  }
  await setMode(db, "full");
  const ids = await startCohortsAt(db, START, keep, scn.overrides ?? {});
  for (const a of actions) await addAction(db, a.code, a.type, a.ex, a.payload);
  await runNights(db, params, START, end);
  const stored = await storedNav(db);
  const count = async (sql: string): Promise<number> => Number((await db.execute(sql)).rows[0]!.n);
  const accruals = await count("SELECT COUNT(*) AS n FROM cash_ledger WHERE kind = 'div_accrue'");
  const rebases = await count("SELECT COUNT(*) AS n FROM cohort_event WHERE kind = 'ca_adjust'");
  const events = await db.execute(
    "SELECT cohort_id, d, detail_json FROM cohort_event WHERE kind = 'liquidated' ORDER BY cohort_id",
  );
  const terminals = await db.execute(
    "SELECT id, terminal_kind, terminal_d FROM cohort WHERE terminal_kind IS NOT NULL ORDER BY id",
  );

  // the gate of every code on every session, as the engine reads it
  const gates = new Map<string, EntryDecision>();
  for (let i = START; i <= end; i += 1) {
    for (const c of CODES) gates.set(`${c}|${DATES[i]}`, await entriesAllowed(db, c, DATES[i]!));
  }
  const gateBlocked = [...gates.values()].filter((g) => !g.allowed).length;
  const halted = new Set<string>();
  const rows = await db.execute("SELECT code, d FROM universe_snapshot WHERE halted = 1");
  for (const r of rows.rows) halted.add(`${r.code}|${r.d}`);

  const series = await seriesFromHarness(
    db,
    DATES,
    Object.fromEntries(CODES.map((c) => [c, { tier: "U1" as const }])),
  );
  const records: CorpActionRecord[] = actions.map((a, i) => ({
    id: String(i + 1),
    code: a.code,
    type: a.type,
    exDate: DATES[a.ex]!,
    payload: a.payload,
  }));
  const supplied = {
    halted: (code: string, d: string): boolean | null => halted.has(`${code}|${d}`),
    qualityGate: (code: string, d: string): EntryDecision => gates.get(`${code}|${d}`)!,
  };
  const run = (gated: boolean, trace?: (e: CohortDayTrace) => void) =>
    replayCohorts(
      buildCohortWorld(DATES, series, params, { actions: records, ...(gated ? supplied : {}) }),
      {
        params,
        from: DATES[START],
        to: DATES[end],
        step: 1000,
        masterSeed: MASTER_SEED,
        controlsPerFamily: 1,
        executions: keep,
        realityLeverage: null,
        cohortParams: () => ({ ...NO_TERMINAL, ...scn.overrides, costProfile: "P5" }),
        ...(trace === undefined ? {} : { trace }),
      },
    );
  const traces: CohortDayTrace[] = [];
  const result = run(true, (e) => traces.push(e));
  expect(result.qualityGate).toBe("supplied");
  expect(result.cohorts.map((c) => c.id).sort()).toEqual([...ids].sort());
  let haircutDays = 0;
  let heldOnHalt = 0;
  for (const t of traces) {
    const want = stored.get(t.cohortId)?.get(t.d);
    expect(want, `${t.cohortId} ${t.d}`).toBeDefined();
    const pos = t.positions
      .map((p) => `${p.code}:${p.qty}:${p.closeMicro}:${p.valueMicro}:${p.haircut}`)
      .join(";");
    expect(
      { nav: t.navMicro, liq: t.liqNavMicro, open: BigInt(t.openPositions), pos },
      `${t.cohortId} ${t.d}`,
    ).toEqual(want);
    haircutDays += t.positions.filter((p) => p.haircut === 1).length;
    heldOnHalt += t.positions.filter((p) => halted.has(`${p.code}|${t.d}`)).length;
  }
  // the replay stops a cohort when the engine does (wound down), never earlier
  if (scn.overrides === undefined) expect(traces.length).toBe(ids.length * (end - START + 1));

  // terminal state, liquidation session and realised value
  const liquidated: ParityResult["liquidated"] = [];
  for (const t of terminals.rows) {
    const o = result.cohorts.find((c) => c.id === String(t.id))!;
    expect(o.terminalKind, String(t.id)).toBe(String(t.terminal_kind));
    expect(o.endD, String(t.id)).toBe(String(t.terminal_d));
  }
  expect(result.cohorts.filter((c) => !c.censored).length).toBe(terminals.rows.length);
  for (const e of events.rows) {
    const detail = JSON.parse(String(e.detail_json)) as {
      realised_nav_micro: string;
      legacy_value_micro: string;
    };
    const o = result.cohorts.find((c) => c.id === String(e.cohort_id))!;
    expect(o.liquidatedD, String(e.cohort_id)).toBe(String(e.d));
    expect(o.outcomeMicro, String(e.cohort_id)).toBe(BigInt(detail.realised_nav_micro));
    expect(o.legacyValueMicro, String(e.cohort_id)).toBe(BigInt(detail.legacy_value_micro));
    liquidated.push({
      id: o.id,
      d: String(e.d),
      realised: BigInt(detail.realised_nav_micro),
      legacy: BigInt(detail.legacy_value_micro),
      terminalLiq: o.terminalLiqNavMicro,
      held: traces.find((t) => t.cohortId === o.id && t.d === o.endD)!.positions.length,
    });
  }
  expect(result.cohorts.filter((c) => c.liquidatedD !== null).length).toBe(events.rows.length);

  const ungated = run(false);
  expect(ungated.qualityGate).toBe("assumed_all_pass");
  return {
    entries: result.cohorts.reduce((s, c) => s + c.entries, 0),
    cohorts: result.cohorts.length,
    accruals,
    rebases,
    entriesUngated: ungated.cohorts.reduce((s, c) => s + c.entries, 0),
    haircutDays,
    liquidated,
    heldOnHalt,
    gateBlocked,
  };
}

describe("replayCohorts equals the database engine on the golden nights", () => {
  it("entries, IS and CS exits, matched controls and the sleeve (lock, shadow trades)", async () => {
    const r = await parity(["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"], []);
    expect(r.cohorts).toBe(6);
    expect(r.entries).toBeGreaterThan(5);
  });

  it("a cash dividend and a 2-for-1 split inside the hold", async () => {
    const r = await parity(
      ["E07", "E08", "C2-F4"],
      [
        {
          code: "ZZD1",
          type: "cash_dividend",
          ex: 302,
          payload: { dps: "0.05", pay_date: DATES[306]! },
        },
        { code: "ZZD1", type: "split", ex: 302, payload: { new: 2, old: 1 } },
      ],
      302,
    );
    expect(r.entries).toBeGreaterThan(0);
    // the actions really hit a held position in the database engine this test is compared with
    expect(r.accruals).toBeGreaterThan(0);
    expect(r.rebases).toBeGreaterThan(0);
  });
});

describe("D-091 follow-up: suspension haircut, quality gate and terminal wind-down", () => {
  const keep = ["E07", "E08", "C2-F4"];
  // ZZD1 (bought at the open of 301) halts from 302 to the end: halted session 21 is 322
  const halts = [{ code: "ZZD1", from: 302, to: 329 }];
  // the matched control entry ZZ32 at the open of 301 is blocked by a data-quality flag
  const blocks = [{ code: "ZZ32", at: 301 }];

  it("a code halted for more than 20 sessions is marked with the haircut from session 21; a blocked entry is cancelled", async () => {
    const r = await parity(keep, [], undefined, { end: 329, halts, blocks });
    expect(r.heldOnHalt).toBeGreaterThan(0); // a halted ZZD1 really is held
    expect(r.haircutDays).toBeGreaterThan(0); // and the haircut applied (sessions 322..329)
    expect(r.gateBlocked).toBeGreaterThan(0);
    expect(r.entriesUngated).toBeGreaterThan(r.entries); // the gate removed an entry
  });

  it("a terminal wind-down with a halted holding: liquidation at the next open, legacy move, realised outcome", async () => {
    const r = await parity(keep, [], undefined, {
      end: 329,
      halts,
      blocks,
      overrides: {
        terminal: {
          targetMultiple: makeRational(100n),
          bustFraction: makeRational(1n, 100n),
          timeoutSessions: 30,
          stallFloorMicro: 1n,
        },
      },
    });
    expect(r.liquidated.length).toBeGreaterThan(0);
    expect(r.liquidated.some((l) => l.legacy > 0n)).toBe(true); // the halted holding went to legacy
    expect(r.haircutDays).toBeGreaterThan(0);
  });

  it("a terminal wind-down without a halt: every holding sold at the next open, the outcome is the realised NAV", async () => {
    // ZZUP is held on 312..315; a timeout at session 314 ends the cohorts with it in the book
    const r = await parity(keep, [], undefined, {
      end: 329,
      overrides: {
        terminal: {
          targetMultiple: makeRational(100n),
          bustFraction: makeRational(1n, 100n),
          timeoutSessions: 20,
          stallFloorMicro: 1n,
        },
      },
    });
    expect(r.liquidated.length).toBeGreaterThan(0);
    expect(r.liquidated.every((l) => l.legacy === 0n)).toBe(true);
    // a cohort was holding at the terminal close and sold at the next open (synthetic opens equal
    // the previous close, so the realised value equals the liquidation NAV here)
    expect(r.liquidated.some((l) => l.held > 0)).toBe(true);
  });
});
