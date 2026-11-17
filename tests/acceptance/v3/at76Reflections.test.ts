// @vitest-environment node
// AT-76 (reflections): pick reflections write only `pick_reflection` (and the call log), queue under the budget, and the AT-32
// hash is identical with reflections ON and OFF (M22 C3; AGT-146, D-1424, D-1426). On the golden ZZ world of AT-32 a settled
// pick is added (it is part of the hashed complement in every run), then the stage runs OFF (nothing written), rules-only
// (a not_written row) and ON with a mock writer (a written row); after each run the dump of every table outside the steelman
// own-set (which holds `pick_reflection`, `llm_call` and `llm_cache`) is byte for byte what it was. Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DbStore } from "@/lib/llm/store";
import { reflectNight } from "@/lib/steelman/reflect";
import { cleanupTempDbs } from "../../db/helpers";
import { goodAnswer, reflectLlm, reflectOptions, scripted } from "../../steelman/reflectHarness";
import { at32World, combineTables, dump, STEELMAN_OWN } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const PICK_D = "2030-01-02";
const SETTLED = "2030-01-09";
const SHA = "d".repeat(64);

async function addSettledPick(db: Client): Promise<void> {
  const w = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });
  await w(
    `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label, reference_micro,
       buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm, typical_ppm, good_ppm, time_frame_sessions,
       size_micro, risk_micro, factors_json, based_on_json, pick_sha, created_at)
     VALUES ('AU', ?, 'balanced', 1, 'ZZR', 'F1', 'U1', 'F1.v1', 's-r', 'UNVALIDATED', 10000000, 10050000, '2030-01-31',
       9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, '2030-01-02T07:00:00Z')`,
    [PICK_D, SHA],
  );
  await w(
    `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
     VALUES ('AU', ?, 'balanced', 1, 'pick', 'ZZR', ?, 'waiting', ?)`,
    [PICK_D, SHA, PICK_D],
  );
  await w(
    `UPDATE pick_outcome SET state = 'bought', entry_d = '2030-01-03', entry_micro = 10020000, updated_d = '2030-01-03'
      WHERE d = ? AND kind = 'pick'`,
    [PICK_D],
  );
  await w(
    `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 11000000, exit_reason = 'aim', net_micro = 980000,
            net_ppm = 97000, updated_d = ? WHERE d = ? AND kind = 'pick'`,
    [SETTLED, SETTLED, PICK_D],
  );
  await w(
    `INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d, index_code, basis, index_from_micro,
       index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed, settled_d)
     VALUES ('AU', ?, 'balanced', 1, 'pick', '2030-01-03', ?, 'ZZI', 'price_only', 1000000, 1012000, 12000, 97000, 85000, 0, ?)`,
    [PICK_D, SETTLED, SETTLED],
  );
}

const count = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);

describe("AT-76 reflections: the AT-32 complement with reflections on and off", () => {
  it("the stage writes only its own tables and leaves the hashed complement exactly as it was", async () => {
    const db = await at32World();
    await addSettledPick(db);
    const before = await dump(db);
    expect(before.rows.pick).toBe(1);
    expect(Object.keys(before.perTable)).not.toContain("pick_reflection");
    for (const t of STEELMAN_OWN) expect(Object.keys(before.perTable), t).not.toContain(t);

    const llm = () => reflectLlm([scripted("alpha", goodAnswer)], new DbStore(db));
    const o = (over: Parameters<typeof reflectOptions>[1] = {}) =>
      reflectOptions(llm(), { d: SETTLED, now: "2030-01-09T08:00:00.000Z", ...over });

    // OFF: nothing is written anywhere
    const off = await reflectNight(db, o({ enabled: false }));
    expect(off.status).toBe("off");
    expect(await count(db, "pick_reflection")).toBe(0);
    expect(await count(db, "llm_call")).toBe(0);
    const afterOff = await dump(db);
    expect(afterOff.perTable).toEqual(before.perTable);

    // ON: a written row, the call logged, the complement untouched
    const on = await reflectNight(db, o());
    expect(on).toMatchObject({ settled: 1, written: 1 });
    expect(await count(db, "pick_reflection")).toBe(1);
    expect(await count(db, "llm_call")).toBeGreaterThan(0);
    const afterOn = await dump(db);
    expect(afterOn.perTable).toEqual(before.perTable);
    expect(afterOn.rows).toEqual(before.rows);
    const names = Object.keys(before.perTable).sort();
    expect(combineTables(afterOn.perTable, names)).toBe(combineTables(before.perTable, names));
  });

  it("a rules-only night also leaves the complement untouched (a not_written row only)", async () => {
    const db = await at32World();
    await addSettledPick(db);
    const before = await dump(db);
    const res = await reflectNight(
      db,
      reflectOptions(reflectLlm([scripted("alpha", goodAnswer)], new DbStore(db), "rules-only"), {
        d: SETTLED,
        now: "2030-01-09T08:00:00.000Z",
      }),
    );
    expect(res).toMatchObject({ settled: 1, written: 0, notWritten: 1 });
    expect(
      (await db.execute("SELECT state, reason FROM pick_reflection")).rows.map((r) => ({ ...r })),
    ).toEqual([{ state: "not_written", reason: "not available tonight" }]);
    expect((await dump(db)).perTable).toEqual(before.perTable);
  });

  it("is not vacuous: a row in a hashed table the stage does not own changes its hash", async () => {
    const db = await at32World();
    await addSettledPick(db);
    const before = await dump(db);
    await db.execute(
      `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
       VALUES ('AU', '${PICK_D}', 'balanced', 1, '2030-01-03', 1, NULL, '2030-01-03T00:00:00Z')`,
    );
    const after = await dump(db);
    expect(
      Object.keys(before.perTable).filter((t) => before.perTable[t] !== after.perTable[t]),
    ).toEqual(["pick_check"]);
  });
});
