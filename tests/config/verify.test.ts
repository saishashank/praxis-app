import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { VERIFY_ROWS } from "@/lib/config/verify";

describe("VERIFY_ROWS", () => {
  it("has unique ids", () => {
    expect(new Set(VERIFY_ROWS.map((r) => r.id)).size).toBe(VERIFY_ROWS.length);
  });

  it("marks a row verified only with an https source and a date", () => {
    for (const r of VERIFY_ROWS) {
      if (r.status === "verified") {
        expect(r.sourceUrl, r.id).toMatch(/^https:\/\//);
        expect(r.verifiedOn, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.verifiedBy, r.id).not.toBe("");
      } else {
        expect(r.sourceUrl, r.id).toBe("");
        expect(r.verifiedOn, r.id).toBe("");
        expect(r.verifiedBy, r.id).toBe("");
      }
    }
  });

  it("maps only to keys that exist", () => {
    for (const r of VERIFY_ROWS) {
      if (r.configKey) expect(Object.keys(CONFIG_KEYS), r.id).toContain(r.configKey);
    }
  });
});
