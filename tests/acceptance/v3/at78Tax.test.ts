// @vitest-environment node
// AT-78 (M21 B3; ARN-122, D-1222): "the tax report reproduces hand-computed specific-lot and FIFO figures for a fixture
// book and carries the fixed words". The fixture is tests/tax/fixtureBook.ts; every figure is worked out by hand in
// tests/tax/report.test.ts (the CSV route is GET /api/reports/tax). Here: the headline figures, the words, and the CSV parsing back to the same figures.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { reportCsv } from "@/lib/tax/csv";
import { taxReport } from "@/lib/tax/report";
import type { TaxReport } from "@/lib/tax/types";
import { seedBook } from "../../tax/fixtureBook";
import { microFromText, parseCsv, unguard } from "../../tax/csvParse";

afterAll(cleanupTempDbs);

let db: Client;
let r: TaxReport;

beforeAll(async () => {
  db = await freshDb("main");
  await seedBook(db);
  r = await taxReport(db, { market: "AU", fy: 2026, source: "book" });
}, 60_000);

describe("AT-78 tax report", () => {
  it("reproduces the hand-computed specific-lot and FIFO figures", () => {
    // strategy E01, specific lot: cost 1_673_000_000, proceeds 2_201_500_000, gain 528_500_000
    // the two ZZAA lots: specific lot 376_000_000 + 136_500_000, FIFO 237_500_000 + 188_000_000 + 87_000_000 (same 512_500_000)
    const e01 = r.executions.find((e) => e.id === "E01")!;
    expect(e01.specific.totals.gainMicro).toBe(528_500_000n);
    const aa = (m: "specific" | "fifo") =>
      e01[m].disposals.filter((d) => d.code === "ZZAA").map((d) => d.gainMicro);
    expect(aa("specific")).toEqual([136_500_000n, 376_000_000n]);
    expect(aa("fifo")).toEqual([237_500_000n, 188_000_000n, 87_000_000n]);
    expect(r.total.specific.gainMicro).toBe(540_500_000n);
    expect(r.total.fifo.gainMicro).toBe(540_500_000n);
  });

  it("carries the fixed words, in the report and on the first line of the CSV", () => {
    expect(r.words).toBe("Paper results, not tax advice");
    expect(parseCsv(reportCsv(r))[0]).toEqual(["Paper results, not tax advice"]);
  });

  it("the CSV parses back to the same figures", () => {
    const rows = parseCsv(reportCsv(r));
    for (const [method, key] of [
      ["specific lot", "specific"],
      ["fifo", "fifo"],
    ] as const) {
      const fromCsv = rows.filter((x) => x[0] === "gain" && x[2] === method);
      const fromReport = r.executions.flatMap((e) => e[key].disposals.map((d) => ({ e: e.id, d })));
      expect(fromCsv).toHaveLength(fromReport.length);
      fromReport.forEach(({ e, d }, i) => {
        const c = fromCsv[i]!;
        expect([c[1], unguard(c[3]!), c[4], c[5], c[6]]).toEqual([
          e,
          d.code,
          d.buyD,
          d.sellD,
          d.qty.toString(),
        ]);
        expect([
          microFromText(unguard(c[7]!)),
          microFromText(unguard(c[8]!)),
          microFromText(unguard(c[9]!)),
        ]).toEqual([d.costMicro, d.proceedsMicro, d.gainMicro]);
        expect(c[10]).toBe(d.over12Months ? "over 12 months" : "12 months or less");
      });
      const total = rows.find((x) => x[0] === "total" && x[2] === method)!;
      expect(microFromText(unguard(total[9]!))).toBe(r.total[key].gainMicro);
    }
    const div = rows.filter((x) => x[0] === "dividend");
    expect(div.reduce((a, x) => a + microFromText(unguard(x[8]!)), 0n)).toBe(r.dividendTotalMicro);
  });
});
