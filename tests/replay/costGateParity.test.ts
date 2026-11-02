// @vitest-environment node
// FAM-005 parity (M14 review fix 2, D-282): the live cost-gate table (`loadCostGateTable`) and the
// replay runner's (`costGateTableOf`) are built by one rule: the stored split, development rows by
// ENTRY date, no rows while the split is deferred.
import type { Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { costGateRowsOf, loadCostGateTable } from "@/lib/agents/costGate";
import { defaultAgentParams } from "@/lib/agents/params";
import { costGateTableOf } from "@/lib/replay/runner";
import type { LedgerResult } from "@/lib/replay/ledger";
import { splitFromRow } from "@/lib/stats/splits";
import { freshReplayDb } from "../agents/batch2bHarness";

const params = defaultAgentParams();
type R = { entry: string; exit: string | null };

// 30 rows entered inside development (the last exits after dev_end), 3 entered after it, 1 open.
const ROWS: R[] = [
  ...Array.from({ length: 29 }, (_, i) => ({
    entry: `2030-03-${String(i + 1).padStart(2, "0")}`,
    exit: `2030-04-${String((i % 28) + 1).padStart(2, "0")}`,
  })),
  { entry: "2030-09-25", exit: "2030-10-05" }, // entered in development, exited after dev_end_d
  { entry: "2030-10-10", exit: "2030-10-15" },
  { entry: "2030-10-11", exit: "2030-10-16" },
  { entry: "2030-11-11", exit: "2030-11-16" },
  { entry: "2030-09-20", exit: null },
];

async function seed(db: Client, deferred: boolean): Promise<void> {
  await db.execute({
    sql: "INSERT INTO lineage (id, created_d, parent) VALUES ('AU:F4', '2030-01-01', NULL)",
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len,
            validation_len, purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d,
            validation_end_d, dev_end_d, deferred_until_d, reason, measured_on_run)
          VALUES ('AU:F4', 1, 5, 100, 100, 50, '2030-12-31', ?, ?, ?, ?, ?, ?, 'create', NULL)`,
    args: deferred
      ? [null, null, null, null, null, "2031-06-30"]
      : ["2030-12-01", "2030-12-31", "2030-10-01", "2030-11-30", "2030-09-30", null],
  });
  for (const [i, r] of ROWS.entries()) {
    const id = `sig:AU:${r.entry}:F4:F4.v1:F4:ZZ${i}`;
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime,
              rank_score, rules_json, evidence_json, classes, group_key, partial, schema_version,
              agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F4', 'F4.v1', 'F4', ?, 'RISK-ON', '0', '[]', '{}', NULL, NULL,
              0, 1, 'a', 'r', ?)`,
      args: [id, r.entry, `ZZ${i}`, `${r.entry}T07:00:00.000Z`],
    });
    await db.execute({
      sql: `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, qty, fill_in_micro,
              brok_in_micro, stress_in_micro, timed, forward)
            VALUES (?, ?, NULL, ?, 100, 1000000, 0, 1000000, 1, 0)`,
      args: [`lr:${id}`, id, r.entry],
    });
    if (r.exit !== null) {
      await db.execute({
        sql: `UPDATE ledger_row SET exit_d = ?, exit_tag = 'CS', fill_out_micro = 1010000,
                brok_out_micro = 0, stress_out_micro = 1000000, qty_out = 100, dividend_micro = 0,
                gross_num = ?, gross_den = 100 WHERE id = ?`,
        args: [r.exit, i + 1, `lr:${id}`],
      });
    }
  }
}

const ledgerOf = (): LedgerResult =>
  ({
    entries: ROWS.map((r, i) => ({
      family: "F4",
      ruleVersion: "F4.v1",
      variant: "F4",
      row: {
        entry_d: r.entry,
        exit_d: r.exit,
        gross_num: r.exit === null ? null : BigInt(i + 1),
        gross_den: r.exit === null ? null : 100n,
      },
    })),
  }) as unknown as LedgerResult;

async function both(deferred: boolean) {
  const db = await freshReplayDb();
  await seed(db, deferred);
  const live = await loadCostGateTable(db, "AU");
  const stored = await db.execute("SELECT * FROM lineage_split");
  const splits = stored.rows.map((r) => splitFromRow(r as Record<string, unknown>));
  const replay = costGateTableOf(ledgerOf(), [], params, "run", splits);
  return { live, replay };
}

describe("cost-gate table: live and replay agree (FAM-005, D-282)", () => {
  it("frozen split: a row entered in development and exited after dev_end counts, key for key", async () => {
    const { live, replay } = await both(false);
    expect([...live.entries()]).toEqual([...replay.entries()]);
    const e = [...live.values()][0]!;
    expect(e.rows).toBe(30);
    expect(e.median).not.toBeNull();
  });

  it("deferred split: no rows in either (unmeasured)", async () => {
    const { live, replay } = await both(true);
    expect([...live.entries()]).toEqual([]);
    expect([...replay.entries()]).toEqual([]);
  });

  it("costGateRowsOf returns nothing without a split", () => {
    expect(costGateRowsOf([], null)).toEqual([]);
  });
});
