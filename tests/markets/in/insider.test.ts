// @vitest-environment node
// M20 IN1 (DAT-243 e, D-1115): SEBI PIT/SAST notices. A promoter or director buy or sell is a director trade (the split
// is unblocked for India); pledges and the like are not directional and are skipped; an acquirer row is a substantial-
// holder notice; the disclosure reference is the notice id, so a re-run inserts nothing.
import { describe, expect, it } from "vitest";
import {
  insiderRows,
  parseInsiderNotices,
  PARSER_VERSION,
} from "@/lib/data/sources/in/insider.mjs";

const T = [
  "symbol,person_category,transaction_type,value_inr,intimation_dt,ref",
  "AAA,Promoter Group,Buy,2500000.50,12-Nov-2026 18:05:00,PIT-1",
  "BBB,Director,Sell,900000,12-Nov-2026 09:10:00,PIT-2",
  "CCC,Promoter,Pledge,100,12-Nov-2026 09:10:00,PIT-3",
  "DDD,Acquirer,Acquisition,,12-Nov-2026 10:00:00,SAST-1",
  "EEE,Acquirer,Disposal,5000000,12-Nov-2026 10:00:00,SAST-2",
  "FFF,Director,Buy,1,not-a-date,PIT-4",
].join("\n");

describe("parseInsiderNotices", () => {
  const r = parseInsiderNotices(T, { market: "IN" });
  it("classifies directional notices and skips the rest", () => {
    expect(r.rows.map((x: { code: string; kind: string }) => [x.code, x.kind])).toEqual([
      ["AAA", "director_buy"],
      ["BBB", "director_sell"],
      ["DDD", "sh_increase"],
      ["EEE", "sh_decrease"],
    ]);
    expect(r.skipped).toBe(2);
  });

  it("value in micro-rupees (NULL when absent) and the known time in UTC", () => {
    expect(r.rows[0]).toMatchObject({
      valueMicro: 2_500_000_500_000n,
      publishedAt: "2026-11-12T12:35:00.000Z",
    });
    expect(r.rows[2]!.valueMicro).toBeNull();
  });

  it("insider_notice rows: ann_id carries the source and the reference", () => {
    const row = insiderRows(r.rows.slice(0, 1))[0]!;
    expect(row).toEqual([
      "IN",
      "in_sebi_pit_sast:PIT-1",
      "AAA",
      "director_buy",
      2_500_000_500_000n,
      "2026-11-12T12:35:00.000Z",
      PARSER_VERSION,
    ]);
  });
});
