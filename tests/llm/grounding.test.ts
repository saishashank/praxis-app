// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkGrounding, normalizeNumber } from "@/lib/llm/grounding";

const ctx = { code: "ABC", ar: 3.2, day0: "2026-03-04", text: "Revenue 1,250 up 4.10 percent" };

describe("numeric grounding (LLM-034)", () => {
  it("accepts numbers, dates and tickers present in the context", () => {
    const r = checkGrounding({ note: "ABC rose 3.2 on 2026-03-04; revenue 1250, up 4.1%." }, ctx);
    expect(r).toEqual({ ok: true, missing: [] });
  });

  it("rejects a number that is not in the context", () => {
    const r = checkGrounding({ note: "ABC rose 7.9." }, ctx);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["number:7.9"]);
  });

  it("rejects an invented date and an invented ticker", () => {
    const r = checkGrounding({ note: "XYZ moved on 2026-03-09" }, ctx);
    expect(r.missing).toEqual(["date:2026-03-09", "ticker:XYZ"]);
  });

  it("ignores listed non-ticker uppercase words and role labels", () => {
    expect(checkGrounding({ note: "ASX item for R2" }, ctx).ok).toBe(true);
  });

  it("normalises separators and trailing zeros", () => {
    expect(normalizeNumber("1,250.00")).toBe("1250");
    expect(normalizeNumber("04.10")).toBe("4.1");
  });

  it("checks nested values and numeric leaves", () => {
    expect(checkGrounding({ a: [{ n: 3.2 }] }, ctx).ok).toBe(true);
    expect(checkGrounding({ a: [{ n: 9 }] }, ctx).ok).toBe(false);
  });
});
