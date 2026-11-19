// @vitest-environment node
// M20 IN1 (ARN-119, D-1107, D-1157): the first posting of an India book is its FX-converted seed, taken from the
// activation row the switch to `full` stored (`market_switch.checklist_json.seed` = { seed_micro, fx_rate, fx_date,
// fx_source, activation_day }), recomputed and compared with the stored amount, posted once on the next close-books run's
// cohort start, dated at the next trading day. With no stored seed the night is a noop with an S2 incident, not a throw.
import { afterEach, describe, expect, it } from "vitest";
import { ensureCohorts } from "@/lib/arena/cohortStart";
import { allowMarket, cleanupTempDbs } from "../../db/helpers";
import { freshReplayDb } from "../../arena/replayHarness";

afterEach(cleanupTempDbs);

const D = "2026-11-12"; // Thursday; the next session is Friday 2026-11-13

async function db() {
  const d = await freshReplayDb();
  await allowMarket(d, "IN");
  await d.execute("UPDATE market SET mode = 'full' WHERE code = 'IN'");
  return d;
}
const seed = (micro: string) => ({
  seed_micro: micro,
  fx_rate: "55.123",
  fx_date: "2026-11-11",
  fx_source: "FXRINR",
  activation_day: "2026-11-12",
});
const activation = (d: Awaited<ReturnType<typeof db>>, s: unknown) =>
  d.execute({
    sql: `INSERT INTO market_switch (market, from_mode, to_mode, enabled_after, actor, at, checklist_json)
          VALUES ('IN', 'data_only', 'full', 1, 'owner', '2026-11-12T00:00:00.000Z', ?)`,
    args: [JSON.stringify({ seed: s })],
  });

describe("activation seed", () => {
  it("opens the IN books with Rs 33,000 from the stored seed, once, dated the next session", async () => {
    const d = await db();
    await activation(d, seed(String(33_000n * 1_000_000n)));
    const r = await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 });
    expect(r.opened).toBeGreaterThan(0);
    expect(r.startD).toBe("2026-11-13");
    const rows = (
      await d.execute(
        "SELECT DISTINCT d, delta_micro FROM cash_ledger WHERE kind = 'seed' AND account = 'cash_settled'",
      )
    ).rows;
    expect(rows.map((x) => [String(x.d), String(x.delta_micro)])).toEqual([
      ["2026-11-13", String(33_000n * 1_000_000n)],
    ]);
    expect((await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 })).opened).toBe(0);
  });

  it("a stored amount that differs from the recomputed seed throws", async () => {
    const d = await db();
    await activation(d, seed(String(34_000n * 1_000_000n)));
    await expect(ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 })).rejects.toThrow(
      /mismatch/,
    );
  });

  it("no stored seed: a noop with an incident, nothing opened, no throw", async () => {
    const d = await db();
    const r = await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 });
    expect([r.status, r.reason]).toEqual(["noop", "seed_missing"]);
    expect(Number((await d.execute("SELECT COUNT(*) AS n FROM cohort")).rows[0]!.n)).toBe(0);
    expect(
      Number(
        (await d.execute("SELECT COUNT(*) AS n FROM incident WHERE kind = 'seed_missing'")).rows[0]!
          .n,
      ),
    ).toBeGreaterThan(0);
  });
});
