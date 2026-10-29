// @vitest-environment node
// Main DB migration 0007_arena (M3 T4, docs/M3_design.md section 3, D-069). HIGH-RISK (ledger
// integrity): up/down/up, every append-only refusal, every allowed and refused one-way transition,
// CHECK constraints, integer-only money, forever retention, backup round trip.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { dumpDatabase, FOREVER_TABLES, restoreDatabase } from "../../scripts/backup/core.mjs";
import {
  ARENA_APPEND_ONLY_TABLES,
  ARENA_COLUMNS,
  ARENA_FOREVER_TABLES,
  ARENA_MONEY_COLUMNS,
  ARENA_ONE_WAY_TABLES,
  ARENA_TABLES,
} from "@/lib/arena/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const q = async (db: Client, sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const run = (db: Client, sql: string, args: (string | number)[] = []) => db.execute({ sql, args });

async function arenaDb(): Promise<Client> {
  return freshDb("main");
}

// ---- row builders (all values synthetic) ----
const execution = (id = "E01", extra = "") =>
  `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
   VALUES ('${id}', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')${extra}`;
const cohort = (id = "K1") =>
  `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
     cost_profile_version, rng_seed)
   VALUES ('${id}', 'E01', '2026-10-12', 600000000, 'rv1', '{}', 1, 42)`;
const order = (id = "O1", status = "pending", code = "ZZAA", side = "buy", qty = 10) =>
  `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status${
    status === "rejected" ? ", reject_reason" : ""
  })
   VALUES ('${id}', 'K1', '2026-10-12', '${code}', '${side}', 'entry', ${qty}, '${status}'${
     status === "rejected" ? ", 'parcel'" : ""
   })`;
const fill = (id = "F1", orderId = "O1", side = "buy", qty = 10, code = "ZZAA") =>
  `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
     slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
     bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
   VALUES ('${id}', '${orderId}', 'K1', '2026-10-13', '${code}', '${side}', ${qty}, 'open',
     1000000, 5000, 1005000, ${qty * 1005000}, 30000000, 'P5', 1000000, 1100000, 900000, 1050000)`;

/** A cohort with a filled buy order and its fill. */
async function withBuyFill(db: Client) {
  await run(db, execution());
  await run(db, cohort());
  await run(db, order());
  await run(db, fill());
  await run(db, "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = 'O1'");
}
async function seedAppendOnly(db: Client) {
  await withBuyFill(db);
  await run(
    db,
    "INSERT INTO cohort_event (cohort_id, seq, kind, d) VALUES ('K1', 1, 'start', '2026-10-12')",
  );
  await run(
    db,
    `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
     VALUES ('K1', '2026-10-12', 'X1', 'cash_settled', 600000000, 'seed')`,
  );
  await run(
    db,
    `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro,
       positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro,
       fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok)
     VALUES ('K1', '2026-10-12', 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1)`,
  );
  await run(
    db,
    `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro)
     VALUES ('K1', '2026-10-12', 'ZZAA', 10, 1000000, 10000000)`,
  );
  await run(
    db,
    `INSERT INTO sleeve_state (cohort_id, seq, state, d, mode)
     VALUES ('K1', 1, 'locked', '2026-10-12', 'REC-2')`,
  );
  await run(
    db,
    `INSERT INTO cost_profile (code, version, tiers_json, slippage_json, source, effective_from)
     VALUES ('P5', 1, '[]', '[]', 'test [VERIFY]', '2026-10-01')`,
  );
  await run(
    db,
    `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by)
     VALUES ('market', 'AU', 'paused', '2026-10-12T00:00:00.000Z', 'owner')`,
  );
}

const trade = (id = "T1", entry = "F1") =>
  `INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro)
   VALUES ('${id}', 'K1', 'ZZAA', '${entry}', 900000)`;

describe("main migration 0007_arena: shape", () => {
  it("is the seventh main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[6]).toMatchObject({ version: 7, name: "arena" });
  });

  it("creates exactly the 13 tables of schema.ts with the columns in order; no position table", async () => {
    const db = await arenaDb();
    const tables = Object.values(ARENA_TABLES);
    expect(tables).toHaveLength(13);
    for (const t of tables) {
      const cols = (await q(db, `PRAGMA table_info(${t})`)).map((r) => r.name);
      expect(cols, t).toEqual([...ARENA_COLUMNS[t]]);
    }
    const names = (await q(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (r) => r.name,
    );
    for (const banned of ["position", "positions", "order"]) expect(names).not.toContain(banned);
  });

  it("every table is STRICT and no column is REAL", async () => {
    const db = await arenaDb();
    for (const t of Object.values(ARENA_TABLES)) {
      const row = (await q(db, `SELECT strict FROM pragma_table_list('${t}')`))[0];
      expect(row.strict, t).toBe(1);
      for (const c of await q(db, `PRAGMA table_info(${t})`)) {
        expect(["INTEGER", "TEXT"], `${t}.${c.name}`).toContain(c.type);
      }
    }
  });

  it("money columns are exactly the *_micro columns, all INTEGER, and are listed in schema.ts", async () => {
    const db = await arenaDb();
    for (const t of Object.values(ARENA_TABLES)) {
      const micro = (await q(db, `PRAGMA table_info(${t})`))
        .filter((c) => String(c.name).endsWith("_micro"))
        .map((c) => c.name);
      expect([...ARENA_MONEY_COLUMNS[t]], t).toEqual(micro);
      for (const c of micro) {
        const type = (await q(db, `PRAGMA table_info(${t})`)).find((x) => x.name === c)!.type;
        expect(type, `${t}.${c}`).toBe("INTEGER");
      }
    }
    // Sanity: the money surface is not empty.
    expect(ARENA_MONEY_COLUMNS.fill).toContain("fill_price_micro");
    expect(ARENA_MONEY_COLUMNS.cash_ledger).toEqual(["delta_micro"]);
  });

  it("the table sets in schema.ts cover every table once (append-only + one-way + state-only)", () => {
    const covered = [...ARENA_APPEND_ONLY_TABLES, ...ARENA_ONE_WAY_TABLES].sort();
    expect(covered).toEqual([...ARENA_FOREVER_TABLES].sort());
  });

  it("has the three hot indexes", async () => {
    const db = await arenaDb();
    const idx = (await q(db, "SELECT name FROM sqlite_master WHERE type = 'index'")).map(
      (r) => r.name,
    );
    expect(idx).toEqual(
      expect.arrayContaining([
        "idx_fill_cohort_d",
        "idx_arena_order_cohort_status",
        "idx_cash_ledger_cohort_d",
      ]),
    );
  });

  it("seeds nothing", async () => {
    const db = await arenaDb();
    for (const t of Object.values(ARENA_TABLES)) {
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(0);
    }
  });
});

describe("main migration 0007_arena: up / down / up", () => {
  it("down removes every arena table, trigger and index and touches nothing else; up restores an identical schema", async () => {
    const db = await arenaDb();
    const ms = await loadMigrations(MIGRATIONS("main"));
    const full = await schemaOf(db);
    await migrateDown(db, ms, 10); // 0017, 0016, 0015, 0014, 0013, 0012, 0011, 0010, 0009 and 0008 sit on top: take the schema as of 0007
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 6 });
    const mid = await schemaOf(db);
    for (const t of Object.values(ARENA_TABLES)) {
      expect(
        mid.some((s) => s.startsWith(`table:${t}:`)),
        t,
      ).toBe(false);
    }
    // Everything that was not arena is still there, unchanged.
    const arenaNames = new Set<string>(Object.values(ARENA_TABLES));
    const nonArena = before.filter((s) => {
      const [type, name] = s.split(":");
      if (type === "table") return !arenaNames.has(name);
      return !/^(execution|cohort|arena_order|arena_control|fill|trade|cash_ledger|nav_daily|nav_daily_pos|sleeve_trade|sleeve_state|cost_profile|idx_(cohort|arena|fill|trade|cash_ledger|sleeve_trade))/.test(
        name,
      );
    });
    expect(mid).toEqual(nonArena);
    expect(await migrateUp(db, ms)).toEqual({ applied: 11, version: 17 });
    expect(await schemaOf(db)).toEqual(full);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 17 });
  });

  it("a fresh database and a down/up database have the same schema (up/down/up identical)", async () => {
    const a = await arenaDb();
    const b = await arenaDb();
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateDown(b, ms, 1);
    await migrateUp(b, ms);
    expect(await schemaOf(b)).toEqual(await schemaOf(a));
  });
});

describe("main migration 0007_arena: append-only tables refuse UPDATE and DELETE", () => {
  // One harmless-looking UPDATE per table that would change a single column.
  const UPDATES: Record<string, string> = {
    cohort_event: "UPDATE cohort_event SET detail_json = '{\"x\":1}'",
    fill: "UPDATE fill SET slip_micro = 0",
    cash_ledger: "UPDATE cash_ledger SET delta_micro = 1",
    nav_daily: "UPDATE nav_daily SET nav_micro = 2",
    nav_daily_pos: "UPDATE nav_daily_pos SET qty = 11",
    sleeve_state: "UPDATE sleeve_state SET state = 'unlocked'",
    cost_profile: "UPDATE cost_profile SET verified = 1",
    arena_control: "UPDATE arena_control SET state = 'enabled'",
  };

  it("covers every append-only table", () => {
    expect(Object.keys(UPDATES).sort()).toEqual([...ARENA_APPEND_ONLY_TABLES].sort());
  });

  for (const t of ARENA_APPEND_ONLY_TABLES) {
    it(`${t}: UPDATE and DELETE abort, the row is unchanged`, async () => {
      const db = await arenaDb();
      await seedAppendOnly(db);
      const before = await q(db, `SELECT * FROM ${t}`);
      await expect(run(db, UPDATES[t])).rejects.toThrow(/append-only/);
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/append-only/);
      expect(await q(db, `SELECT * FROM ${t}`)).toEqual(before);
    });
  }

  it("a primary-key change on an append-only table is also refused", async () => {
    const db = await arenaDb();
    await seedAppendOnly(db);
    await expect(run(db, "UPDATE cash_ledger SET id = 99")).rejects.toThrow(/append-only/);
    await expect(run(db, "UPDATE fill SET id = 'F9'")).rejects.toThrow(/append-only/);
  });

  it("duplicate keys are refused, not replaced (ledger uniqueness)", async () => {
    const db = await arenaDb();
    await seedAppendOnly(db);
    await expect(
      run(
        db,
        `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
         VALUES ('K1', '2026-10-12', 'X1', 'cash_settled', 5, 'seed')`,
      ),
    ).rejects.toThrow(/UNIQUE/);
    // Same txn, other account: fine (double entry).
    await run(
      db,
      `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
       VALUES ('K1', '2026-10-12', 'X1', 'fees_paid', -600000000, 'seed')`,
    );
  });
});

describe("main migration 0007_arena: execution (status and rule_version only)", () => {
  it("allows status and rule_version; refuses every other column; refuses delete", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, "UPDATE execution SET status = 'paused', rule_version = 'rv2' WHERE id = 'E01'");
    expect(await q(db, "SELECT status, rule_version FROM execution")).toEqual([
      { status: "paused", rule_version: "rv2" },
    ]);
    for (const col of [
      "id = 'E99'",
      "market = 'US'",
      "kind = 'C1'",
      "family = 'F2'",
      "variant = 'L'",
      "twin_group = 'T9'",
      "cost_profile = 'P4'",
    ]) {
      await expect(run(db, `UPDATE execution SET ${col}`), col).rejects.toThrow(
        /only status and rule_version/,
      );
    }
    await expect(run(db, "DELETE FROM execution")).rejects.toThrow(/forever table/);
  });

  it("NULL columns count as unchanged (IS), and setting a NULL column is refused", async () => {
    const db = await arenaDb();
    await run(
      db,
      "INSERT INTO execution (id, market, kind, rule_version, cost_profile) VALUES ('C1', 'AU', 'C1', 'rv1', 'P5')",
    );
    await run(db, "UPDATE execution SET status = 'retired' WHERE id = 'C1'");
    await expect(run(db, "UPDATE execution SET family = 'F1' WHERE id = 'C1'")).rejects.toThrow(
      /only status/,
    );
  });

  it("CHECKs: kind and variant enums, E needs family and variant, status non-empty", async () => {
    const db = await arenaDb();
    await expect(
      run(
        db,
        "INSERT INTO execution (id, market, kind, rule_version, cost_profile) VALUES ('X', 'AU', 'Z', 'r', 'P5')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        db,
        "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('X', 'AU', 'E', 'F1', 'Q', 'r', 'P5')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        db,
        "INSERT INTO execution (id, market, kind, rule_version, cost_profile) VALUES ('X', 'AU', 'E', 'r', 'P5')",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(db, execution("E02", "").replace("'rv1', 'P5')", "'rv1', 'P5')")),
    ).resolves.toBeTruthy();
    await expect(run(db, "UPDATE execution SET status = ''")).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0007_arena: cohort (terminal set once, live 1 to 0)", () => {
  const TERMINAL =
    "terminal_kind = 'target', terminal_d = '2026-11-01', ttd_sessions = 14, ttd_days = 20, outcome_micro = 150000000";

  it("terminal columns go NULL to a full value once; afterwards they cannot change", async () => {
    const db = await arenaDb();
    await run(db, cohort());
    await run(db, `UPDATE cohort SET ${TERMINAL} WHERE id = 'K1'`);
    expect(await q(db, "SELECT terminal_kind, ttd_sessions, outcome_micro FROM cohort")).toEqual([
      { terminal_kind: "target", ttd_sessions: 14, outcome_micro: 150000000 },
    ]);
    for (const set of [
      "terminal_kind = 'bust'",
      "terminal_d = '2026-11-02'",
      "ttd_sessions = 15",
      "ttd_days = 21",
      "outcome_micro = 1",
      "terminal_kind = NULL, terminal_d = NULL, ttd_sessions = NULL, ttd_days = NULL, outcome_micro = NULL",
    ]) {
      await expect(run(db, `UPDATE cohort SET ${set}`), set).rejects.toThrow();
    }
    // The same values written again are an identical update and harmless.
    await run(db, `UPDATE cohort SET ${TERMINAL}`);
  });

  it("a partial terminal state is refused by CHECK (all five together or none)", async () => {
    const db = await arenaDb();
    await run(db, cohort());
    await expect(run(db, "UPDATE cohort SET terminal_kind = 'target'")).rejects.toThrow(/CHECK/);
    await expect(
      run(db, "UPDATE cohort SET terminal_d = '2026-11-01', ttd_sessions = 1"),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(db, TERMINAL.replace("'target'", "'weird'").replace(/^/, "UPDATE cohort SET ")),
    ).rejects.toThrow(/CHECK/);
  });

  it("each terminal kind is accepted", async () => {
    const db = await arenaDb();
    for (const [i, kind] of (["target", "bust", "stalled", "timeout"] as const).entries()) {
      await run(db, cohort(`K${i}`));
      await run(
        db,
        `UPDATE cohort SET terminal_kind = '${kind}', terminal_d = '2026-11-01', ttd_sessions = 1,
           ttd_days = 1, outcome_micro = -5 WHERE id = 'K${i}'`,
      );
    }
  });

  it("live may go 1 to 0 (shadow), never back; all identity and config columns are immutable", async () => {
    const db = await arenaDb();
    await run(db, cohort());
    await run(db, "UPDATE cohort SET live = 0");
    await expect(run(db, "UPDATE cohort SET live = 1")).rejects.toThrow(/cohort:/);
    for (const set of [
      "id = 'K2'",
      "execution_id = 'E02'",
      "control_idx = 3",
      "start_d = '2026-10-13'",
      "seed_micro = 1",
      "rule_version = 'rv9'",
      "params_json = '{\"a\":1}'",
      "cost_profile_version = 2",
      "sleeve_json = '{}'",
      "data_snapshot_id = 's1'",
      "rng_seed = 7",
      "twin_group = 'T2'",
      "restart_of = 'K0'",
    ]) {
      await expect(run(db, `UPDATE cohort SET ${set}`), set).rejects.toThrow(/cohort:/);
    }
    await expect(run(db, "DELETE FROM cohort")).rejects.toThrow(/forever table/);
  });

  it("a live cohort may be marked shadow in the same update that sets the terminal state", async () => {
    const db = await arenaDb();
    await run(db, cohort());
    await run(db, `UPDATE cohort SET live = 0, ${TERMINAL}`);
  });

  it("CHECKs: seed positive, control_idx at least 1 (no upper cap: ch.15 tunable), json valid", async () => {
    const db = await arenaDb();
    const base = cohort("KX");
    await expect(run(db, base.replace("600000000", "0"))).rejects.toThrow(/CHECK/);
    await expect(run(db, base.replace("600000000", "-5"))).rejects.toThrow(/CHECK/);
    await expect(
      run(db, base.replace("rng_seed)", "rng_seed, control_idx)").replace(", 42)", ", 42, 0)")),
    ).rejects.toThrow(/CHECK/);
    await run(
      db,
      base.replace("rng_seed)", "rng_seed, control_idx)").replace(", 42)", ", 42, 25)"),
    );
    await expect(run(db, base.replace("'{}'", "'{bad'").replace("'KX'", "'KY'"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      run(
        db,
        base
          .replace("cost_profile_version", "cost_profile_version")
          .replace(", 1, 42", ", 0, 42")
          .replace("'KX'", "'KZ'"),
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0007_arena: orders (pending to one terminal status)", () => {
  it("pending to filled, rejected or cancelled each work once; terminal rows then freeze", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    // filled needs a fill row first
    await run(db, order("O1"));
    await expect(
      run(db, "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = 'O1'"),
    ).rejects.toThrow(/no fill row/);
    await run(db, fill("F1", "O1"));
    await run(
      db,
      "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = 'O1'",
    );
    // rejected
    await run(db, order("O2", "pending", "ZZBB"));
    await run(
      db,
      "UPDATE arena_order SET status = 'rejected', reject_reason = 'cash' WHERE id = 'O2'",
    );
    // cancelled
    await run(db, order("O3", "pending", "ZZCC"));
    await run(
      db,
      "UPDATE arena_order SET status = 'cancelled', reject_reason = 'halted' WHERE id = 'O3'",
    );
    for (const id of ["O1", "O2", "O3"]) {
      for (const set of [
        "status = 'pending'",
        "status = 'rejected', reject_reason = 'parcel'",
        "status = 'cancelled'",
        "reject_reason = 'x'",
        "fill_d = '2030-01-01'",
        "qty = 99",
      ]) {
        await expect(
          run(db, `UPDATE arena_order SET ${set} WHERE id = '${id}'`),
          `${id} ${set}`,
        ).rejects.toThrow(/order:/);
      }
    }
  });

  it("pending to pending is refused; identity columns are immutable even at the transition", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    await run(db, order("O1"));
    await expect(run(db, "UPDATE arena_order SET qty = 5 WHERE id = 'O1'")).rejects.toThrow(
      /order:/,
    );
    for (const set of [
      "id = 'O9'",
      "cohort_id = 'K2'",
      "decided_d = '2026-10-14'",
      "code = 'ZZXX'",
      "side = 'sell'",
      "kind = 'exit_cs'",
      "qty = 5",
      "ref_stop_micro = 5",
      "tier = 'U1'",
      "untradeable_flag = 1",
    ]) {
      await expect(
        run(db, `UPDATE arena_order SET status = 'rejected', reject_reason = 'parcel', ${set}`),
        set,
      ).rejects.toThrow(/order:/);
    }
    expect((await q(db, "SELECT status FROM arena_order"))[0].status).toBe("pending");
  });

  it("an order cannot be inserted as filled; a rejected order can be inserted directly", async () => {
    const db = await arenaDb();
    await expect(run(db, order("O1", "filled"))).rejects.toThrow(/filled is reached by update/);
    await run(db, order("O2", "rejected"));
    await expect(run(db, "UPDATE arena_order SET status = 'cancelled'")).rejects.toThrow(/order:/);
  });

  it("DELETE is refused", async () => {
    const db = await arenaDb();
    await run(db, order("O1"));
    await expect(run(db, "DELETE FROM arena_order")).rejects.toThrow(/forever table/);
  });

  it("CHECKs: side/kind/status/tier enums, qty >= 0, stop > 0, reject_reason tied to status, one row per signal", async () => {
    const db = await arenaDb();
    const ins = (cols: string, vals: string) =>
      run(
        db,
        `INSERT INTO arena_order (id, cohort_id, decided_d, code, ${cols}) VALUES ('${Math.random()}', 'K1', '2026-10-12', 'ZZAA', ${vals})`,
      );
    await expect(ins("side, kind, qty", "'hold', 'entry', 1")).rejects.toThrow(/CHECK/);
    await expect(ins("side, kind, qty", "'buy', 'bogus', 1")).rejects.toThrow(/CHECK/);
    await expect(ins("side, kind, qty", "'buy', 'entry', -1")).rejects.toThrow(/CHECK/);
    await expect(ins("side, kind, qty, status", "'buy', 'entry', 1, 'done'")).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins("side, kind, qty, tier", "'buy', 'entry', 1, 'U9'")).rejects.toThrow(/CHECK/);
    await expect(ins("side, kind, qty, ref_stop_micro", "'buy', 'entry', 1, 0")).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins("side, kind, qty, untradeable_flag", "'buy', 'entry', 1, 2")).rejects.toThrow(
      /CHECK/,
    );
    // rejected needs a reason; pending/filled must not carry one; empty reason refused
    await expect(ins("side, kind, qty, status", "'buy', 'entry', 1, 'rejected'")).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins("side, kind, qty, status, reject_reason", "'buy', 'entry', 1, 'pending', 'parcel'"),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins("side, kind, qty, status, reject_reason", "'buy', 'entry', 1, 'rejected', ''"),
    ).rejects.toThrow(/CHECK/);
    // qty 0 is allowed (a whole-share rejection of a tiny allocation)
    await ins(
      "side, kind, qty, status, reject_reason",
      "'buy', 'entry', 0, 'rejected', 'whole_share'",
    );
  });

  it("UNIQUE (cohort, decided day, code, kind): a second signal for the same key is refused", async () => {
    const db = await arenaDb();
    await run(db, order("O1"));
    await expect(run(db, order("O2"))).rejects.toThrow(/UNIQUE/);
    await run(db, order("O3", "pending", "ZZBB"));
  });

  it("stall query works: orders rejected only for parcel / whole_share", async () => {
    const db = await arenaDb();
    await run(db, order("O1", "rejected", "ZZAA"));
    await run(db, order("O2", "rejected", "ZZBB").replace("'parcel'", "'whole_share'"));
    await run(db, order("O3", "rejected", "ZZCC").replace("'parcel'", "'cash'"));
    const r = await q(
      db,
      "SELECT COUNT(*) AS n FROM arena_order WHERE status='rejected' AND reject_reason IN ('parcel','whole_share')",
    );
    expect(r[0].n).toBe(2);
  });
});

describe("main migration 0007_arena: fills (append-only, tied to a pending order)", () => {
  it("a fill needs a pending order of the same cohort, code and side with qty not above the order", async () => {
    const db = await arenaDb();
    await run(db, order("O1")); // buy 10 ZZAA
    await expect(run(db, fill("F1", "NOPE"))).rejects.toThrow(/fill:/);
    await expect(run(db, fill("F1", "O1", "sell"))).rejects.toThrow(/fill:/);
    await expect(run(db, fill("F1", "O1", "buy", 11))).rejects.toThrow(/fill:/);
    await expect(run(db, fill("F1", "O1", "buy", 10, "ZZBB"))).rejects.toThrow(/fill:/);
    await run(db, fill("F1", "O1", "buy", 4)); // participation-capped partial fill is fine
  });

  it("a fill for an order that is not pending is refused (filled / rejected / cancelled)", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    await run(db, order("O1"));
    await run(db, fill("F1", "O1"));
    await run(
      db,
      "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = 'O1'",
    );
    await expect(run(db, fill("F2", "O1"))).rejects.toThrow(/fill:/);
    await run(db, order("O2", "rejected", "ZZBB"));
    await expect(run(db, fill("F3", "O2", "buy", 10, "ZZBB"))).rejects.toThrow(/fill:/);
  });

  it("one fill per order (UNIQUE order_id) and the fill id is unique", async () => {
    const db = await arenaDb();
    await run(db, order("O1"));
    await run(db, order("O2", "pending", "ZZBB"));
    await run(db, fill("F1", "O1"));
    await expect(run(db, fill("F2", "O1"))).rejects.toThrow(/UNIQUE/);
    await expect(run(db, fill("F1", "O2", "buy", 10, "ZZBB"))).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("CHECKs: qty > 0, prices > 0, slippage and costs >= 0, rule enum, bars >= 0", async () => {
    const db = await arenaDb();
    await run(db, order("O1"));
    const bad = (from: string, to: string) =>
      expect(run(db, fill("F1", "O1").replace(from, to)), `${from} -> ${to}`).rejects.toThrow(
        /CHECK/,
      );
    await bad("'buy', 10,", "'buy', 0,");
    await bad("'open',", "'vwap',");
    await bad("1000000, 5000, 1005000", "0, 5000, 1005000");
    await bad("1000000, 5000, 1005000", "1000000, -1, 1005000");
    await bad("1000000, 5000, 1005000", "1000000, 5000, 0");
    await bad("30000000, 'P5'", "-1, 'P5'");
    await bad("1000000, 1100000, 900000, 1050000", "-1, 1100000, 900000, 1050000");
  });
});

describe("main migration 0007_arena: trades (one-way close)", () => {
  it("opens with a buy fill of the same cohort and code, no exit", async () => {
    const db = await arenaDb();
    await withBuyFill(db);
    await expect(run(db, trade("T0", "NOPE"))).rejects.toThrow(/trade:/);
    await run(db, order("O2", "pending", "ZZBB", "sell"));
    await run(db, fill("F2", "O2", "sell", 10, "ZZBB"));
    await expect(run(db, trade("T0", "F2"))).rejects.toThrow(/trade:/); // sell fill / wrong code
    await expect(
      run(
        db,
        trade("T0", "F1")
          .replace("stop_micro)", "stop_micro, exit_type)")
          .replace("900000)", "900000, 'CS')"),
      ),
    ).rejects.toThrow(/trade:/);
    await run(db, trade("T1", "F1"));
    expect(await q(db, "SELECT exit_type, exit_fill_id, legacy FROM trade")).toEqual([
      { exit_type: null, exit_fill_id: null, legacy: 0 },
    ]);
  });

  async function openTradeWithSell(db: Client) {
    await withBuyFill(db);
    await run(db, trade());
    await run(db, order("O2", "pending", "ZZAA", "sell").replace("'entry'", "'exit_is'"));
    await run(db, fill("F2", "O2", "sell"));
  }

  it("closes once with each exit type IS / CS / terminal (needs a sell fill); then freezes", async () => {
    for (const type of ["IS", "CS", "terminal"]) {
      const db = await arenaDb();
      await openTradeWithSell(db);
      await run(db, `UPDATE trade SET exit_type = '${type}', exit_fill_id = 'F2' WHERE id = 'T1'`);
      for (const set of [
        "exit_type = 'CS'",
        "exit_fill_id = NULL, exit_type = NULL",
        "stop_micro = 1",
        "legacy = 1",
      ]) {
        await expect(run(db, `UPDATE trade SET ${set}`), set).rejects.toThrow();
      }
      await expect(run(db, "DELETE FROM trade")).rejects.toThrow(/forever table/);
    }
  });

  it("a close without exit fill (except legacy), with a buy fill, or with a foreign fill is refused", async () => {
    const db = await arenaDb();
    await openTradeWithSell(db);
    await expect(run(db, "UPDATE trade SET exit_type = 'IS'")).rejects.toThrow(/CHECK/);
    await expect(run(db, "UPDATE trade SET exit_fill_id = 'F2'")).rejects.toThrow(/trade:|CHECK/);
    await expect(run(db, "UPDATE trade SET exit_type = 'IS', exit_fill_id = 'F1'")).rejects.toThrow(
      /trade:/,
    ); // F1 is a buy
    await expect(
      run(db, "UPDATE trade SET exit_type = 'IS', exit_fill_id = 'NOPE'"),
    ).rejects.toThrow(/trade:/);
    expect((await q(db, "SELECT exit_type FROM trade"))[0].exit_type).toBeNull();
  });

  it("legacy close: no exit fill, legacy flag = 1, tied to exit_type", async () => {
    const db = await arenaDb();
    await openTradeWithSell(db);
    await expect(
      run(db, "UPDATE trade SET exit_type = 'legacy', exit_fill_id = 'F2', legacy = 1"),
    ).rejects.toThrow(/CHECK/);
    await expect(run(db, "UPDATE trade SET exit_type = 'legacy'")).rejects.toThrow(/CHECK/); // legacy flag missing
    await expect(run(db, "UPDATE trade SET legacy = 1")).rejects.toThrow(/CHECK|trade:/);
    await run(db, "UPDATE trade SET exit_type = 'legacy', legacy = 1");
    await expect(
      run(db, "UPDATE trade SET exit_type = 'IS', exit_fill_id = 'F2', legacy = 0"),
    ).rejects.toThrow(/trade:/);
  });

  it("identity columns never change, even at the close", async () => {
    const db = await arenaDb();
    await openTradeWithSell(db);
    for (const set of [
      "id = 'T9'",
      "cohort_id = 'K9'",
      "code = 'ZZBB'",
      "entry_fill_id = 'F2'",
      "stop_micro = 5",
    ]) {
      await expect(
        run(db, `UPDATE trade SET exit_type = 'IS', exit_fill_id = 'F2', ${set}`),
        set,
      ).rejects.toThrow(/trade:/);
    }
  });

  it("one trade per entry fill and per exit fill; stop must be positive", async () => {
    const db = await arenaDb();
    await withBuyFill(db);
    await run(db, trade("T1", "F1"));
    await expect(run(db, trade("T2", "F1"))).rejects.toThrow(/UNIQUE/);
    await run(db, order("O2", "pending", "ZZBB"));
    await run(db, fill("F2", "O2", "buy", 10, "ZZBB"));
    await expect(
      run(db, trade("T3", "F2").replace("'ZZAA'", "'ZZBB'").replace("900000", "0")),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0007_arena: sleeve trades (one-way close, shadow)", () => {
  const sleeve = (id = "S1", entry = "'F1'", extra = "") =>
    `INSERT INTO sleeve_trade (id, cohort_id, code, margin_micro, leverage, notional_micro, entry_fill_id, open_d, entry_price_micro${
      extra ? ", shadow" : ""
    })
     VALUES ('${id}', 'K1', 'ZZAA', 60000000, 10, 600000000, ${entry}, '2026-10-12', 10000000${extra})`;
  const CLOSE =
    "closed_by = 'exit', price_pl_micro = -12000000, financing_micro = 1500000, exit_fill_id = 'F2', close_d = '2026-10-13', exit_price_micro = 9000000, costs_micro = 10000000";

  async function openSleeveWithSell(db: Client) {
    await withBuyFill(db);
    await run(db, order("O2", "pending", "ZZAA", "sell").replace("'entry'", "'sleeve_close'"));
    await run(db, fill("F2", "O2", "sell"));
    await run(db, sleeve());
  }

  it("opens unclosed with an entry fill; closes once with closed_by, P/L, financing and exit fill together", async () => {
    const db = await arenaDb();
    await openSleeveWithSell(db);
    await run(db, `UPDATE sleeve_trade SET ${CLOSE} WHERE id = 'S1'`);
    expect(await q(db, "SELECT closed_by, price_pl_micro FROM sleeve_trade")).toEqual([
      { closed_by: "exit", price_pl_micro: -12000000 },
    ]);
    for (const set of [
      "closed_by = 'closeout'",
      "price_pl_micro = 0",
      "financing_micro = 0",
      "closed_by = NULL, price_pl_micro = NULL, financing_micro = NULL, exit_fill_id = NULL, close_d = NULL, exit_price_micro = NULL, costs_micro = NULL",
    ]) {
      await expect(run(db, `UPDATE sleeve_trade SET ${set}`), set).rejects.toThrow();
    }
    await expect(run(db, "DELETE FROM sleeve_trade")).rejects.toThrow(/forever table/);
  });

  it("an incomplete close is refused by CHECK; an open trade cannot change anything else", async () => {
    const db = await arenaDb();
    await openSleeveWithSell(db);
    await expect(run(db, "UPDATE sleeve_trade SET closed_by = 'exit'")).rejects.toThrow(/CHECK/);
    await expect(
      run(
        db,
        "UPDATE sleeve_trade SET closed_by = 'exit', price_pl_micro = 1, financing_micro = 1, close_d = '2026-10-13', exit_price_micro = 1, costs_micro = 0",
      ),
    ).rejects.toThrow(/CHECK/); // live trade needs the exit fill
    await expect(run(db, "UPDATE sleeve_trade SET price_pl_micro = 1")).rejects.toThrow();
    await expect(run(db, "UPDATE sleeve_trade SET closed_by = 'bogus'")).rejects.toThrow(/CHECK/);
    for (const set of [
      "id = 'S9'",
      "cohort_id = 'K9'",
      "code = 'ZZBB'",
      "margin_micro = 1",
      "leverage = 5",
      "notional_micro = 1",
      "entry_fill_id = 'F2'",
      "shadow = 1",
      "open_d = '2026-10-11'",
      "entry_price_micro = 9999",
    ]) {
      await expect(run(db, `UPDATE sleeve_trade SET ${CLOSE}, ${set}`), set).rejects.toThrow();
    }
  });

  it("the exit fill must belong to the same cohort and code", async () => {
    const db = await arenaDb();
    await openSleeveWithSell(db);
    await expect(
      run(db, `UPDATE sleeve_trade SET ${CLOSE.replace("'F2'", "'NOPE'")}`),
    ).rejects.toThrow(/sleeve_trade:/);
  });

  it("a shadow trade has no fills and closes without them", async () => {
    const db = await arenaDb();
    await run(db, sleeve("SH", "NULL", ", 1"));
    await run(
      db,
      "UPDATE sleeve_trade SET closed_by = 'closeout', price_pl_micro = -60000000, financing_micro = 0, close_d = '2026-10-12', exit_price_micro = 9000000, costs_micro = 10000000 WHERE id = 'SH'",
    );
    // A live trade without an entry fill is refused.
    await expect(run(db, sleeve("S2", "NULL"))).rejects.toThrow(/CHECK/);
  });

  it("entry fill must exist for the same cohort and code; open insert only", async () => {
    const db = await arenaDb();
    await withBuyFill(db);
    await expect(run(db, sleeve("S1", "'NOPE'"))).rejects.toThrow(/sleeve_trade:/);
    await expect(
      run(db, sleeve("S1").replace("'ZZAA', 60000000", "'ZZBB', 60000000")),
    ).rejects.toThrow(/sleeve_trade:/);
    await expect(
      run(
        db,
        "INSERT INTO sleeve_trade (id, cohort_id, code, margin_micro, leverage, notional_micro, entry_fill_id, closed_by, price_pl_micro, financing_micro, exit_fill_id, open_d, entry_price_micro, close_d, exit_price_micro, costs_micro) VALUES ('S3','K1','ZZAA',1,10,10,'F1','exit',0,0,'F1','2026-10-12',1,'2026-10-12',1,0)",
      ),
    ).rejects.toThrow(/sleeve_trade:/);
  });

  it("CHECKs: margin > 0, notional > 0, leverage >= 1", async () => {
    const db = await arenaDb();
    await withBuyFill(db);
    await expect(run(db, sleeve().replace("60000000", "0"))).rejects.toThrow(/CHECK/);
    await expect(run(db, sleeve().replace("600000000", "0"))).rejects.toThrow(/CHECK/);
    await expect(run(db, sleeve().replace("10,", "0,"))).rejects.toThrow(/CHECK/);
  });

  it("CHECKs: notional = margin x leverage; a close needs close_d >= open_d, exit price and costs", async () => {
    const db = await arenaDb();
    await openSleeveWithSell(db);
    await expect(run(db, sleeve("S2").replace("600000000", "590000000"))).rejects.toThrow(/CHECK/);
    for (const set of [
      CLOSE.replace("close_d = '2026-10-13'", "close_d = '2026-10-11'"),
      CLOSE.replace(", costs_micro = 10000000", ""),
      CLOSE.replace(", exit_price_micro = 9000000", ""),
      CLOSE.replace("financing_micro = 1500000", "financing_micro = -1"),
    ]) {
      await expect(run(db, `UPDATE sleeve_trade SET ${set}`), set).rejects.toThrow();
    }
  });
});

describe("main migration 0007_arena: remaining CHECK constraints", () => {
  it("cohort_event kind enum (incl. ca_adjust, data_event) and seq >= 1; json valid", async () => {
    const db = await arenaDb();
    const ev = (seq: number, kind: string, detail = "'{}'") =>
      run(
        db,
        `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json) VALUES ('K1', ${seq}, '${kind}', '2026-10-12', ${detail})`,
      );
    let seq = 1;
    for (const k of [
      "start",
      "terminal",
      "liquidated",
      "restart",
      "shadow_continue",
      "lock",
      "unlock",
      "ca_adjust",
      "data_event",
    ]) {
      await ev(seq++, k);
    }
    await expect(ev(20, "other")).rejects.toThrow(/CHECK/);
    await expect(ev(0, "start")).rejects.toThrow(/CHECK/);
    await expect(ev(21, "start", "'{bad'")).rejects.toThrow(/CHECK/);
    await expect(ev(1, "start")).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("cash_ledger: account and kind enums, signed delta, same account at most once per txn", async () => {
    const db = await arenaDb();
    const row = (account: string, kind: string, delta: number, txn = "X1") =>
      run(
        db,
        `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind) VALUES ('K1', '2026-10-12', '${txn}', '${account}', ${delta}, '${kind}')`,
      );
    await row("cash_settled", "buy", -10_050_000);
    await row("cash_pay", "buy", 10_050_000);
    await row("position_cost", "buy", 1, "X4");
    await row("equity", "seed", -1, "X4");
    await expect(row("bank", "buy", 1)).rejects.toThrow(/CHECK/);
    await expect(row("cash_settled", "gift", 1, "X2")).rejects.toThrow(/CHECK/);
    await expect(row("cash_settled", "buy", 5)).rejects.toThrow(/UNIQUE/);
    expect(
      (await q(db, "SELECT SUM(delta_micro) AS s FROM cash_ledger WHERE txn_id = 'X1'"))[0].s,
    ).toBe(0);
    // reversal rows exist for corrections
    await row("cash_settled", "reversal", 10_050_000, "X3");
  });

  it("nav_daily / nav_daily_pos / sleeve_state / cost_profile / arena_control constraints", async () => {
    const db = await arenaDb();
    const nav = (open: number, ok: number) =>
      run(
        db,
        `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok) VALUES ('K1', '2026-10-1${open}', 0, 0, 0, 0, 0, 0, 0, 0, -5, -5, ${open}, ${ok})`,
      );
    await nav(0, 0);
    await expect(nav(-1, 1)).rejects.toThrow(/CHECK/);
    await expect(nav(1, 2)).rejects.toThrow(/CHECK/);
    const pos = (qty: number, haircut = 0) =>
      run(
        db,
        `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro, haircut) VALUES ('K1', '2026-10-12', 'C${qty}', ${qty}, 1, 1, ${haircut})`,
      );
    await expect(pos(0)).rejects.toThrow(/CHECK/);
    await expect(pos(-3)).rejects.toThrow(/CHECK/);
    await expect(pos(3, 2)).rejects.toThrow(/CHECK/);
    await pos(3, 1);
    const sl = (seq: number, state: string, loss: number, mode: string) =>
      run(
        db,
        `INSERT INTO sleeve_state (cohort_id, seq, state, d, loss_to_recover_micro, mode) VALUES ('K1', ${seq}, '${state}', '2026-10-12', ${loss}, '${mode}')`,
      );
    await sl(1, "locked", 5, "REC-2");
    await expect(sl(2, "frozen", 0, "REC-2")).rejects.toThrow(/CHECK/);
    await expect(sl(2, "locked", -1, "REC-2")).rejects.toThrow(/CHECK/);
    await expect(sl(2, "locked", 0, "REC-9")).rejects.toThrow(/CHECK/);
    const cp = (version: number, verified: number, tiers = "'[]'") =>
      run(
        db,
        `INSERT INTO cost_profile (code, version, tiers_json, slippage_json, source, verified, effective_from) VALUES ('P5', ${version}, ${tiers}, '[]', 's', ${verified}, '2026-10-01')`,
      );
    await cp(1, 0);
    await cp(2, 1); // approval = a new version row
    await expect(cp(0, 0)).rejects.toThrow(/CHECK/);
    await expect(cp(3, 2)).rejects.toThrow(/CHECK/);
    await expect(cp(3, 0, "'nope'")).rejects.toThrow(/CHECK/);
    await expect(cp(1, 1)).rejects.toThrow(/UNIQUE|PRIMARY/);
    const ctl = (scope: string, state: string) =>
      run(
        db,
        `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('${scope}', 'AU', '${state}', '2026-10-12T00:00:00.000Z', 'owner')`,
      );
    await ctl("family", "killed");
    await expect(ctl("galaxy", "paused")).rejects.toThrow(/CHECK/);
    await expect(ctl("market", "dead")).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0007_arena: money is integer only", () => {
  it("a fractional micro amount is refused by the engine (STRICT), not rounded or stored as REAL", async () => {
    const db = await arenaDb();
    let n = 0;
    const ins = (v: string) =>
      run(
        db,
        `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind) VALUES ('K1', '2026-10-12', 'X${++n}', 'cash_settled', ${v}, 'seed')`,
      );
    await expect(ins("1.5")).rejects.toThrow();
    await expect(ins("'12'")).resolves.toBeTruthy(); // text that is a whole number converts losslessly
    await expect(ins("'1.5'")).rejects.toThrow();
    await expect(ins("'abc'")).rejects.toThrow();
    await expect(ins("1e3")).resolves.toBeTruthy(); // exactly 1000, converted
    const types = await q(db, "SELECT typeof(delta_micro) AS t FROM cash_ledger");
    expect(types.every((r) => r.t === "integer")).toBe(true);
  });

  it("every *_micro column of every table rejects 0.5 and stores integers as integer", async () => {
    const db = await arenaDb();
    // fill: the richest table; mutate each money column in turn
    await run(db, order("O1"));
    const good = fill("F1", "O1");
    for (const col of ARENA_MONEY_COLUMNS.fill) {
      // build an insert in which this column holds 0.5 via named replace on column order
      const cols = ARENA_COLUMNS.fill;
      const vals = [
        "'F1'",
        "'O1'",
        "'K1'",
        "'2026-10-13'",
        "'ZZAA'",
        "'buy'",
        "10",
        "'open'",
        "1000000",
        "5000",
        "1005000",
        "10050000",
        "30000000",
        "'P5'",
        "1000000",
        "1100000",
        "900000",
        "1050000",
      ];
      vals[cols.indexOf(col)] = "0.5";
      await expect(
        run(db, `INSERT INTO fill (${cols.join(",")}) VALUES (${vals.join(",")})`),
        col,
      ).rejects.toThrow();
    }
    await run(db, good);
    const t = await q(db, "SELECT typeof(value_micro) AS a, typeof(qty) AS b FROM fill");
    expect(t).toEqual([{ a: "integer", b: "integer" }]);
  });

  it("quantities are integers too; text in an integer column is refused", async () => {
    const db = await arenaDb();
    await expect(
      run(db, order("O1", "pending", "ZZAA", "buy", 1.5 as unknown as number)),
    ).rejects.toThrow();
    await expect(
      run(db, order("O2").replace("10, 'pending'", "'ten', 'pending'")),
    ).rejects.toThrow();
  });

  it("round-trips values beyond 2^53 exactly in bigint mode", async () => {
    const url = tempDbUrl();
    const db = track(createClient({ url, intMode: "bigint" }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const big = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a double
    await db.execute({
      sql: "INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind) VALUES ('K1', '2026-10-12', 'B', 'cash_settled', ?, 'seed')",
      args: [big],
    });
    const r = await db.execute("SELECT delta_micro FROM cash_ledger");
    expect(r.rows[0].delta_micro).toBe(big);
  });
});

describe("main migration 0007_arena: forever retention and backup", () => {
  it("no arena table allows DELETE of any kind", async () => {
    const db = await arenaDb();
    await seedAppendOnly(db);
    await run(db, trade());
    await run(db, order("O2", "pending", "ZZAA", "sell").replace("'entry'", "'sleeve_close'"));
    await run(db, fill("F2", "O2", "sell"));
    await run(
      db,
      "INSERT INTO sleeve_trade (id, cohort_id, code, margin_micro, leverage, notional_micro, entry_fill_id, open_d, entry_price_micro) VALUES ('S1', 'K1', 'ZZAA', 6, 10, 60, 'F1', '2026-10-12', 1000000)",
    );
    for (const t of Object.values(ARENA_TABLES)) {
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, `${t} seeded`).toBeGreaterThan(
        0,
      );
      await expect(run(db, `DELETE FROM ${t}`), t).rejects.toThrow(/forever table|append-only/);
    }
    // Also a delete restricted to old rows (a retention-style prune) is refused.
    await expect(run(db, "DELETE FROM fill WHERE d < '2100-01-01'")).rejects.toThrow(/append-only/);
    await expect(run(db, "DELETE FROM cohort WHERE start_d < '2100-01-01'")).rejects.toThrow(
      /forever table/,
    );
  });

  it("every arena table is in FOREVER_TABLES of the backup core", () => {
    for (const t of Object.values(ARENA_TABLES)) expect(FOREVER_TABLES, t).toContain(t);
  });

  it("dump labels them forever and a restore reproduces rows, triggers and guards", async () => {
    const db = await arenaDb();
    await withBuyFill(db);
    await run(db, trade());
    await run(
      db,
      `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
       VALUES ('K1', '2026-10-12', 'X1', 'cash_settled', 600000000, 'seed')`,
    );
    const d = await dumpDatabase(db, { name: "main", createdAt: "2026-10-11T00:00:00.000Z" });
    for (const t of Object.values(ARENA_TABLES)) {
      expect(d.meta.forever, t).toContain(t);
      expect(d.meta.ephemeral).not.toContain(t);
    }
    expect(d.counts.fill).toBe(1);
    expect(d.counts.cash_ledger).toBe(1);
    const target = track(createClient({ url: tempDbUrl() }));
    const r = await restoreDatabase(target, d.text);
    expect(r.sha256).toEqual(d.sha256);
    expect(await schemaOf(target)).toEqual(await schemaOf(db));
    // Guards survived the restore.
    await expect(run(target, "UPDATE fill SET slip_micro = 0")).rejects.toThrow(/append-only/);
    await expect(run(target, "DELETE FROM cash_ledger")).rejects.toThrow(/append-only/);
    await expect(run(target, "UPDATE arena_order SET qty = 1")).rejects.toThrow(/order:/);
    await expect(run(target, "UPDATE trade SET stop_micro = 1")).rejects.toThrow(/trade:/);
    // The restored database is at version 8 (0008 agents on top of 0007): nothing more to apply.
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(target, ms)).toEqual({ applied: 0, version: 17 });
  });
});

describe("fill_insert_guard: quantity above the order only across a split or bonus issue (M4 T8)", () => {
  afterEach(cleanupTempDbs);

  it("refuses a larger fill with no corporate action between decision and fill", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    await run(db, order("O1", "pending", "ZZAA", "buy", 10));
    await expect(run(db, fill("F1", "O1", "buy", 20))).rejects.toThrow(/fill: needs a matching/);
  });

  it("allows it when a split went ex after the decision and on or before the fill", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    await run(db, order("O1", "pending", "ZZAA", "buy", 10));
    await run(
      db,
      `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
       VALUES ('AU', 'ZZAA', 'split', '2026-10-13', '{"new":2,"old":1}')`,
    );
    await run(db, fill("F1", "O1", "buy", 20));
  });

  it("a dividend between decision and fill does not lift the limit", async () => {
    const db = await arenaDb();
    await run(db, execution());
    await run(db, cohort());
    await run(db, order("O1", "pending", "ZZAA", "buy", 10));
    await run(
      db,
      `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
       VALUES ('AU', 'ZZAA', 'dividend', '2026-10-13', '{"dps":0.1}')`,
    );
    await expect(run(db, fill("F1", "O1", "buy", 20))).rejects.toThrow(/fill: needs a matching/);
  });
});
