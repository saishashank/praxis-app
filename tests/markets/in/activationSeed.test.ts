// @vitest-environment node
// M20 IN1 (ARN-119, D-1107, S1 hand-off b): the first posting of an India book is its FX-converted seed, taken from the
// activation row the switch to `full` stored (`market_switch.checklist_json.seed`), posted once on the next close-books
// run's cohort start, dated at the next trading day; with no stored seed nothing is guessed.
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
const activation = (d: Awaited<ReturnType<typeof db>>, seed: unknown) =>
  d.execute({
    sql: `INSERT INTO market_switch (market, from_mode, to_mode, enabled_after, actor, at, checklist_json)
          VALUES ('IN', 'data_only', 'full', 1, 'owner', '2026-11-12T00:00:00.000Z', ?)`,
    args: [JSON.stringify({ seed })],
  });

describe("activation seed", () => {
  it("opens the IN books with Rs 33,000 from the stored FX close, once, dated the next session", async () => {
    const d = await db();
    await activation(d, { rate: "55.123", date: "2026-11-11", source: "FXRINR" });
    const r = await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 });
    expect(r.opened).toBeGreaterThan(0);
    expect(r.startD).toBe("2026-11-13");
    const seed = (
      await d.execute(
        "SELECT DISTINCT d, delta_micro FROM cash_ledger WHERE kind = 'seed' AND account = 'cash_settled'",
      )
    ).rows;
    expect(seed.map((x) => [String(x.d), String(x.delta_micro)])).toEqual([
      ["2026-11-13", String(33_000n * 1_000_000n)],
    ]);
    const again = await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 });
    expect(again.opened).toBe(0); // exactly once
  });

  it("the ledger-record spelling of the seed is accepted too", async () => {
    const d = await db();
    await activation(d, { fx_rate: "55.123", fx_date: "2026-11-11", fx_source: "FXRINR" });
    expect(
      (await ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 })).opened,
    ).toBeGreaterThan(0);
  });

  it("no stored seed: nothing is opened and nothing is guessed", async () => {
    const d = await db();
    await expect(ensureCohorts(d, { market: "IN", d: D, controlsPerFamily: 1 })).rejects.toThrow(
      RangeError,
    );
    expect(Number((await d.execute("SELECT COUNT(*) AS n FROM cohort")).rows[0]!.n)).toBe(0);
  });
});
