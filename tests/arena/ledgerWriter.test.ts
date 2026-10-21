// @vitest-environment node
// DB writers/loaders for cash_ledger, nav_daily, nav_daily_pos (M3 T6) against a real migrated
// database, in bigint mode (decision 18). HIGH-RISK (ledger integrity): atomic, idempotent,
// conflicts raise, and a stored cohort round-trips into the same invariants and the same bytes.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { writeFill } from "@/lib/arena/fillWriter";
import { checkCohortBooks, replayIdentical } from "@/lib/arena/invariants";
import { fillTxns, seedTxn, txnRows, type LedgerFill } from "@/lib/arena/ledger";
import {
  LedgerWriteError,
  loadLedgerFills,
  loadLedgerRows,
  loadNavDays,
  toBig,
  writeLedgerTxn,
  writeNavDay,
} from "@/lib/arena/ledgerWriter";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { simulate, type Sim } from "./ledgerHarness";

afterEach(cleanupTempDbs);

async function freshBigintDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute(
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('E01', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')`,
  );
  await db.execute(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed)
     VALUES ('K1', 'E01', '2026-01-05', 600000000, 'rv1', '{}', 1, 42)`,
  );
  return db;
}

async function store(db: Client, sim: Sim): Promise<void> {
  for (const f of sim.fills) {
    const sf = sim.simFills.get(f.id);
    if (sf === undefined) throw new Error("fill not simulated");
    await db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
            VALUES (?, 'K1', ?, ?, ?, ?, ?)`,
      args: [`O-${f.id}`, f.d, f.code, f.side, f.side === "buy" ? "entry" : "exit_cs", f.qty],
    });
    await writeFill(db, {
      fillId: f.id,
      orderId: `O-${f.id}`,
      cohortId: "K1",
      d: f.d,
      code: f.code,
      fill: sf,
    });
  }
  for (const t of sim.txns) await writeLedgerTxn(db, "K1", t);
  for (const day of sim.days) await writeNavDay(db, day);
}

const dump = async (db: Client): Promise<string> => {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM fill ORDER BY id",
    "SELECT * FROM cash_ledger ORDER BY id",
    "SELECT * FROM nav_daily ORDER BY cohort_id, d",
    "SELECT * FROM nav_daily_pos ORDER BY cohort_id, d, code",
  ]) {
    const rs = await db.execute(sql);
    for (const r of rs.rows) parts.push(JSON.stringify(Object.values(r).map(String)));
  }
  return parts.join("\n");
};

const count = async (db: Client, table: string): Promise<bigint> =>
  toBig((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

const failWith = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe("round trip: store a simulated cohort, load it, check it, replay it", () => {
  for (const mode of ["matched", "conservative"] as const) {
    it(`${mode}: loaded books pass every invariant and equal what was simulated`, async () => {
      const sim = simulate({ seed: 31, days: 25, mode });
      expect(sim.fills.length).toBeGreaterThan(5);
      const db = await freshBigintDb();
      await store(db, sim);

      const rows = await loadLedgerRows(db, "K1");
      const fills = await loadLedgerFills(db, "K1");
      const days = await loadNavDays(db, "K1");
      expect(rows).toEqual(sim.rows);
      expect(fills).toEqual(sim.fills);
      expect(days).toEqual(sim.days);
      expect(
        checkCohortBooks(
          { ...sim.books, rows, fills },
          {
            mode,
            calendar: sim.calendar,
            dates: sim.dates,
            stored: days,
            seedMicro: sim.seedMicro,
          },
        ),
      ).toEqual([]);

      // a second, independent database fed the same inputs holds the same bytes (AT-13)
      const again = simulate({ seed: 31, days: 25, mode });
      const db2 = await freshBigintDb();
      await store(db2, again);
      expect(await dump(db2)).toBe(await dump(db));
      expect(
        replayIdentical(
          { rows, days },
          { rows: await loadLedgerRows(db2, "K1"), days: await loadNavDays(db2, "K1") },
        ),
      ).toBe(true);
    }, 60_000);
  }

  it("works through a client in the default (number) int mode too", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const sim = simulate({ seed: 8, days: 20, mode: "matched" });
    for (const t of sim.txns) await writeLedgerTxn(db, "K1", t);
    for (const day of sim.days) await writeNavDay(db, day);
    expect(await loadLedgerRows(db, "K1")).toEqual(sim.rows);
    expect(await loadNavDays(db, "K1")).toEqual(sim.days);
  });

  it("loadLedgerRows can stop at a date", async () => {
    const db = await freshBigintDb();
    const sim = simulate({ seed: 31, days: 30, mode: "matched" });
    for (const t of sim.txns) await writeLedgerTxn(db, "K1", t);
    const upTo = sim.dates[10];
    const part = await loadLedgerRows(db, "K1", upTo);
    expect(part).toEqual(sim.rows.filter((r) => r.d <= upTo));
    expect(part.length).toBeLessThan(sim.rows.length);
  });
});

describe("writeLedgerTxn", () => {
  const sale: LedgerFill = {
    id: "F1",
    d: "2026-10-13",
    code: "ZZA",
    side: "sell",
    qty: 10n,
    valueMicro: 99_900_000n,
    brokerageMicro: 5_000_000n,
  };

  it("writes all postings in one transaction and is idempotent on replay", async () => {
    const db = await freshBigintDb();
    const [trade, fee] = fillTxns(sale, 90_000_000n);
    expect(await writeLedgerTxn(db, "K1", trade)).toEqual({ written: true });
    expect(await writeLedgerTxn(db, "K1", fee)).toEqual({ written: true });
    expect(await count(db, "cash_ledger")).toBe(5n);
    expect(await writeLedgerTxn(db, "K1", fee)).toEqual({ written: false });
    expect(await count(db, "cash_ledger")).toBe(5n);
    const stored = await db.execute("SELECT delta_micro, account FROM cash_ledger ORDER BY id");
    expect(stored.rows.map((r) => [r.account, r.delta_micro])).toEqual([
      ["cash_recv", 99_900_000n],
      ["position_cost", -90_000_000n],
      ["equity", -9_900_000n],
      ["cash_recv", -5_000_000n],
      ["fees_paid", 5_000_000n],
    ]);
  });

  it("the same txn id with different amounts, date or accounts is a conflict and writes nothing", async () => {
    const db = await freshBigintDb();
    const [, fee] = fillTxns(sale, 90_000_000n);
    await writeLedgerTxn(db, "K1", fee);
    const variants = [
      { ...fee, postings: fee.postings.map((p) => ({ ...p, deltaMicro: p.deltaMicro * 2n })) },
      { ...fee, d: "2026-10-14" },
      {
        ...fee,
        postings: [fee.postings[0], { account: "cash_pay" as const, deltaMicro: 5_000_000n }],
      },
      { ...fee, postings: fee.postings, kind: "settle" as const },
    ];
    for (const v of variants) {
      const error = await failWith(writeLedgerTxn(db, "K1", v));
      expect(error).toBeInstanceOf(LedgerWriteError);
      expect((error as LedgerWriteError).code).toBe("txn_conflict");
    }
    const fewer = {
      ...fee,
      postings: [
        fee.postings[0],
        { account: "fees_paid" as const, deltaMicro: 4_000_000n },
        { account: "equity" as const, deltaMicro: 1_000_000n },
      ],
    };
    expect(((await failWith(writeLedgerTxn(db, "K1", fewer))) as LedgerWriteError).code).toBe(
      "txn_conflict",
    );
    expect(await count(db, "cash_ledger")).toBe(2n);
  });

  it("a replayed seed (no references) is also a no-op", async () => {
    const db = await freshBigintDb();
    const seed = seedTxn("2026-10-12", 600_000_000n);
    expect(await writeLedgerTxn(db, "K1", seed)).toEqual({ written: true });
    expect(await writeLedgerTxn(db, "K1", seed)).toEqual({ written: false });
    expect(await count(db, "cash_ledger")).toBe(2n);
  });

  it("another cohort may reuse the txn id", async () => {
    const db = await freshBigintDb();
    await writeLedgerTxn(db, "K1", seedTxn("2026-10-12", 600_000_000n));
    expect(await writeLedgerTxn(db, "K2", seedTxn("2026-10-12", 600_000_000n))).toEqual({
      written: true,
    });
  });

  it("an unbalanced txn never reaches the database", async () => {
    const db = await freshBigintDb();
    const bad = { ...seedTxn("2026-10-12", 600_000_000n), postings: [] };
    expect(await failWith(writeLedgerTxn(db, "K1", bad))).toBeInstanceOf(RangeError);
    expect(await count(db, "cash_ledger")).toBe(0n);
  });

  it("append-only: a refusing trigger on the second posting rolls the first one back", async () => {
    const db = await freshBigintDb();
    await db.execute(
      `CREATE TRIGGER t_refuse BEFORE INSERT ON cash_ledger WHEN NEW.account = 'fees_paid'
       BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
    );
    const [, fee] = fillTxns(sale, 90_000_000n);
    const error = await failWith(writeLedgerTxn(db, "K1", fee));
    expect(error).toBeInstanceOf(LedgerWriteError);
    expect((error as LedgerWriteError).code).toBe("trigger_refused");
    expect(await count(db, "cash_ledger")).toBe(0n);
  });

  it("a row that collides on its unique key without being seen first is a conflict", async () => {
    const db = await freshBigintDb();
    await db.execute(
      `CREATE TRIGGER t_collide BEFORE INSERT ON cash_ledger WHEN NEW.account = 'fees_paid'
       BEGIN
         INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
         VALUES (NEW.cohort_id, NEW.d, NEW.txn_id, NEW.account, 0, NEW.kind);
       END`,
    );
    const [, fee] = fillTxns(sale, 90_000_000n);
    const error = await failWith(writeLedgerTxn(db, "K1", fee));
    expect((error as LedgerWriteError).code).toBe("txn_conflict");
    expect(await count(db, "cash_ledger")).toBe(0n);
  });

  it("a constraint refusal is typed; an unrelated failure is passed through", async () => {
    const db = await freshBigintDb();
    const wrongKind = { ...seedTxn("2026-10-12", 600n), kind: "nonsense" as never };
    const refused = await failWith(writeLedgerTxn(db, "K1", wrongKind));
    expect((refused as LedgerWriteError).code).toBe("constraint_refused");
    await db.execute("DROP TABLE cash_ledger");
    const other = await failWith(writeLedgerTxn(db, "K1", seedTxn("2026-10-12", 600n)));
    expect(other).not.toBeInstanceOf(LedgerWriteError);
    expect(String(other)).toContain("cash_ledger");
  });
});

describe("writeNavDay", () => {
  const sim = simulate({ seed: 31, days: 40, mode: "matched" });
  const withPositions = sim.days.find((d) => d.positions.length > 0);
  const flat = sim.days[0];

  it("writes the row and its position rows; a replay is a no-op", async () => {
    expect(withPositions).toBeDefined();
    const db = await freshBigintDb();
    const day = withPositions ?? flat;
    expect(await writeNavDay(db, day)).toEqual({ written: true });
    expect(await count(db, "nav_daily_pos")).toBe(BigInt(day.positions.length));
    expect(await writeNavDay(db, day)).toEqual({ written: false });
    expect(await count(db, "nav_daily")).toBe(1n);
    expect(await loadNavDays(db, "K1")).toEqual([day]);
  });

  it("keeps a zero verdict flag and a haircut flag exactly", async () => {
    const db = await freshBigintDb();
    const day = {
      row: { ...flat.row, d: "2026-02-02", invariantsOk: 0 as const, openPositions: 1n },
      positions: [
        {
          cohortId: "K1",
          d: "2026-02-02",
          code: "ZZA",
          qty: 3n,
          closeMicro: 1_000_001n,
          valueMicro: 1_500_002n,
          haircut: 1 as const,
        },
      ],
    };
    await writeNavDay(db, day);
    expect(await loadNavDays(db, "K1")).toEqual([day]);
  });

  it("a different day under the same key is a conflict (never an overwrite)", async () => {
    const db = await freshBigintDb();
    await writeNavDay(db, flat);
    const changed = {
      row: { ...flat.row, navMicro: flat.row.navMicro + 1n },
      positions: flat.positions,
    };
    const error = await failWith(writeNavDay(db, changed));
    expect((error as LedgerWriteError).code).toBe("nav_conflict");
    const stored = await db.execute("SELECT nav_micro FROM nav_daily");
    expect(stored.rows[0].nav_micro).toBe(flat.row.navMicro);
  });

  it("a CHECK failure rolls the whole day back and is typed", async () => {
    const db = await freshBigintDb();
    const bad = { row: { ...flat.row, openPositions: -1n }, positions: [] };
    const error = await failWith(writeNavDay(db, bad));
    expect((error as LedgerWriteError).code).toBe("constraint_refused");
    expect(await count(db, "nav_daily")).toBe(0n);
  });

  it("an unrelated failure is passed through", async () => {
    const db = await freshBigintDb();
    await db.execute("DROP TABLE nav_daily_pos");
    const day = withPositions ?? flat;
    const error = await failWith(writeNavDay(db, day));
    expect(error).not.toBeInstanceOf(LedgerWriteError);
    expect(await count(db, "nav_daily")).toBe(0n);
  });

  it("loadNavDays of an unknown cohort is empty", async () => {
    const db = await freshBigintDb();
    expect(await loadNavDays(db, "K9")).toEqual([]);
  });
});

describe("toBig", () => {
  it("accepts bigint and safe integers only", () => {
    expect(toBig(5n)).toBe(5n);
    expect(toBig(7)).toBe(7n);
    expect(() => toBig(1.5)).toThrow(TypeError);
    expect(() => toBig("7")).toThrow(TypeError);
    expect(() => toBig(null)).toThrow(TypeError);
  });
});

describe("txnRows are what the writer stores", () => {
  it("one row per posting", () => {
    expect(txnRows(seedTxn("2026-10-12", 5n))).toHaveLength(2);
  });
});
