// @vitest-environment node
// M20 IN1 (D-1109, D-1163, A5 review note): the band lock wired into the close-books night, mirroring `halted`:
// an ENTRY on a band-locked session is cancelled `band_locked`; an EXIT stays pending and fills the next session.
import { afterEach, describe, expect, it } from "vitest";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { bandLimits } from "@/lib/cortex/states/bands";
import { marketMoney } from "@/lib/arena/marketMoney";
import { cleanupTempDbs } from "../../db/helpers";
import { buildInNight, IN, IN_NOW, M, placeOrder, type InCode } from "./inNight";

afterEach(cleanupTempDbs);

const table = marketMoney(IN).tickTable;
/** flat bars at the previous close, except INAA on `lockIdx`, which closes at its 2 % upper limit. */
const barsWithLock = (lockIdx: number) => (c: InCode, i: number, prev: bigint) => {
  if (c.code === "INAA" && i === lockIdx) {
    const up = bandLimits(prev, 2, table).upperMicro;
    return [prev, up, prev, up] as [bigint, bigint, bigint, bigint];
  }
  return [prev, prev, prev, prev] as [bigint, bigint, bigint, bigint];
};

const orderRow = async (db: import("@libsql/client").Client, id: string) =>
  (
    await db.execute({
      sql: "SELECT status, reject_reason FROM arena_order WHERE id = ?",
      args: [id],
    })
  ).rows[0]!;

describe("band-locked sessions in the close-books night", () => {
  it("an entry on a locked session is cancelled band_locked", async () => {
    const n = await buildInNight({ barOf: barsWithLock(2), bands: [["INAA", 2, 2]] });
    const [d0, d1, d2] = n.dates;
    const close = (d: string) => closeBooksDay(n.db, { market: IN, d, replay: true, now: IN_NOW });
    await close(d0!);
    await close(d1!);
    await placeOrder(n.db, {
      id: "E1",
      cohortId: n.cohortIds[0]!,
      decidedD: d1!,
      code: "INAA",
      kind: "entry",
      qty: 90,
      stop: 24n * M,
    });
    await close(d2!);
    const r = await orderRow(n.db, "E1");
    expect(String(r.status)).toBe("cancelled");
    expect(String(r.reject_reason)).toBe("band_locked");
  });

  it("an exit on a locked session stays pending and fills when the lock lifts", async () => {
    const n = await buildInNight({ barOf: barsWithLock(4), bands: [["INAA", 4, 2]] });
    const [d0, d1, d2, d3, d4, d5] = n.dates;
    const cohortId = n.cohortIds[0]!;
    const close = (d: string) => closeBooksDay(n.db, { market: IN, d, replay: true, now: IN_NOW });
    await close(d0!);
    await close(d1!);
    await placeOrder(n.db, {
      id: "E1",
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
    await close(d4!); // the exit would fill here; the session is band-locked
    expect(String((await orderRow(n.db, "X1")).status)).toBe("pending");
    await close(d5!);
    expect(String((await orderRow(n.db, "X1")).status)).toBe("filled");
  });

  it("with no band row nothing is refused (a missing file never blocks a fill)", async () => {
    const n = await buildInNight({ barOf: barsWithLock(2) }); // locked close, but no price_band row
    const [d0, d1, d2] = n.dates;
    const close = (d: string) => closeBooksDay(n.db, { market: IN, d, replay: true, now: IN_NOW });
    await close(d0!);
    await close(d1!);
    await placeOrder(n.db, {
      id: "E1",
      cohortId: n.cohortIds[0]!,
      decidedD: d1!,
      code: "INAA",
      kind: "entry",
      qty: 90,
      stop: 24n * M,
    });
    await close(d2!);
    expect(String((await orderRow(n.db, "E1")).status)).toBe("filled");
  });
});
