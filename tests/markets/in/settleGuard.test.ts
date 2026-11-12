// @vitest-environment node
// M20 IN1 (D-1154 item 6, AT-69 T+1 clause): the guard test. An India night buys, then sells; the sale settles on
// D+1 in the LEDGER and in the Cortex `BookState.pending`. If either read the home T+2 lag the two would disagree
// silently and Cortex would believe the proceeds arrive a session later than the books do.
import { afterEach, describe, expect, it } from "vitest";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { loadLedgerRows } from "@/lib/arena/ledgerWriter";
import { loadBookStates } from "@/lib/cortex/stage";
import { cleanupTempDbs } from "../../db/helpers";
import { buildInNight, IN, IN_NOW, M, placeOrder } from "./inNight";

afterEach(cleanupTempDbs);

describe("settlement lag: ledger and Cortex agree (India T+1)", () => {
  it("a sale on D settles on D+1 in the ledger and in BookState.pending", async () => {
    const n = await buildInNight();
    const [d0, d1, d2, d3, d4, d5, d6] = n.dates;
    const cohortId = n.cohortIds[0]!;
    const close = (d: string) => closeBooksDay(n.db, { market: IN, d, replay: true, now: IN_NOW });

    await close(d0!);
    await close(d1!);
    // entry decided on d1 fills at the d2 open; exit decided on d3 fills at the d4 open
    await placeOrder(n.db, {
      id: "O1",
      cohortId,
      decidedD: d1!,
      code: "INAA",
      kind: "entry",
      qty: 90,
      stop: 24n * M,
    });
    await close(d2!);
    await close(d3!);
    await placeOrder(n.db, {
      id: "X1",
      cohortId,
      decidedD: d3!,
      code: "INAA",
      kind: "exit_cs",
      qty: 90,
    });
    await close(d4!);

    const sell = (
      await n.db.execute({
        sql: "SELECT id, d FROM fill WHERE cohort_id = ? AND side = 'sell'",
        args: [cohortId],
      })
    ).rows[0]!;
    expect(String(sell.d)).toBe(d4);

    // Cortex: the book as of the d4 close carries the sale as pending, settling on d5 (D+1), not d6 (D+2)
    const books = await loadBookStates(n.db, { market: IN, d: d4!, calendar: n.calendar });
    expect(books).toHaveLength(1);
    const pendingSale = books[0]!.pending!.find((p) => p.side === "sell");
    expect(pendingSale?.tradeD).toBe(d4);
    expect(pendingSale?.settleD).toBe(d5);

    // Ledger: nothing is posted for the sale on d4; the settle posting is dated d5
    const settleRows = async () =>
      (await loadLedgerRows(n.db, cohortId)).filter(
        (r) => r.kind === "settle" && r.refId === String(sell.id),
      );
    expect(await settleRows()).toHaveLength(0);
    await close(d5!);
    const posted = await settleRows();
    expect(posted.length).toBeGreaterThan(0);
    expect(new Set(posted.map((r) => r.d))).toEqual(new Set([d5]));
    expect(d6).toBeDefined();
  });
});
