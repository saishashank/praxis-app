// @vitest-environment node
// D-290: GSPC and VIX are accepted index codes under the existing Yahoo source (no new source row).
import { describe, expect, it } from "vitest";
import {
  INDEX_CODE,
  INDEX_CODES,
  INDEX_SOURCE,
  US_INDEX_YAHOO_SYMBOLS,
  validateIndexRow,
} from "@/lib/data/index/indexBars.mjs";

const raw = (code: string) => ({
  code,
  date: "2030-03-05",
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  source: "yahoo",
  fetched_at: "2030-03-06T01:00:00Z",
});

describe("INDEX_CODES", () => {
  it("lists AXJO first, then GSPC and VIX, on the same Yahoo source", () => {
    expect(INDEX_CODES).toEqual([INDEX_CODE, "GSPC", "VIX"]);
    expect(US_INDEX_YAHOO_SYMBOLS).toEqual({ GSPC: "^GSPC", VIX: "^VIX" });
    expect(INDEX_SOURCE).toBe("yahoo_eod");
  });

  it.each(["AXJO", "GSPC", "VIX"])("validates a %s row", (code) => {
    const v = validateIndexRow(raw(code));
    expect("row" in v && v.row).toMatchObject({ index_code: code, c_micro: 101_000_000 });
  });

  it("still refuses an unknown code", () => {
    expect(validateIndexRow(raw("DJI"))).toEqual({ reason: "bad_code" });
  });
});
