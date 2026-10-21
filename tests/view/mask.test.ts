// @vitest-environment node
// The masking module (DAT-124, ROL-107, UX-009; docs/M7_design.md 2.4; D-128). Pure functions: who is
// masked, the letters of an active set, free-text masking and the leak finder. The property test feeds
// seeded random records through the masker and fails if ANY code, company name, price, link or exact
// date survives for a masked context.
import { describe, expect, it } from "vitest";
import {
  findLeaks,
  isGrantLive,
  letterOf,
  LINK_HIDDEN,
  maskContext,
  maskText,
  PRICE_HIDDEN,
  StockAliases,
  UNKNOWN_STOCK,
  weekOnly,
  type MaskLookup,
} from "@/lib/view/mask";

// mulberry32: a small seeded generator, so a failing case is reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("letterOf and StockAliases", () => {
  it("counts A..Z, AA..AZ, BA... (bijective base 26)", () => {
    expect(letterOf(0)).toBe("A");
    expect(letterOf(25)).toBe("Z");
    expect(letterOf(26)).toBe("AA");
    expect(letterOf(27)).toBe("AB");
    expect(letterOf(51)).toBe("AZ");
    expect(letterOf(52)).toBe("BA");
    expect(letterOf(701)).toBe("ZZ");
    expect(letterOf(702)).toBe("AAA");
    expect(() => letterOf(-1)).toThrow();
    expect(() => letterOf(1.5)).toThrow();
  });

  it("assigns letters alphabetically by code, whatever the input order, and ignores duplicates and blanks", () => {
    const a = new StockAliases(["ZZB", "ZZA", "zzc", "ZZA", "  ", null, undefined, "ZZB"]);
    expect(a.size).toBe(3);
    expect(a.label("ZZA")).toBe("Stock A");
    expect(a.label("ZZB")).toBe("Stock B");
    expect(a.label("ZZC")).toBe("Stock C");
    expect(a.label(" zza ")).toBe("Stock A");
    const b = new StockAliases(["ZZC", "ZZB", "ZZA"]);
    for (const c of ["ZZA", "ZZB", "ZZC"]) expect(b.label(c)).toBe(a.label(c));
  });

  it("never gives a code outside the set a letter, and never returns the code", () => {
    const a = new StockAliases(["ZZA"]);
    expect(a.label("ZZQ")).toBe(UNKNOWN_STOCK);
    expect(a.label(null)).toBe(UNKNOWN_STOCK);
    expect(a.has("ZZQ")).toBe(false);
  });

  it("letters are never reused within a date, and a new date's set restarts", () => {
    const day1 = new StockAliases(["AAA", "BBB", "CCC"]);
    const labels = ["AAA", "BBB", "CCC"].map((c) => day1.label(c));
    expect(new Set(labels).size).toBe(3);
    const day2 = new StockAliases(["BBB", "CCC", "DDD"]);
    expect(day2.label("BBB")).toBe("Stock A"); // a different date: letters are assigned afresh
    expect(day1.label("BBB")).toBe("Stock B");
  });

  it("past 26 stocks the labels stay unique", () => {
    const codes = Array.from({ length: 80 }, (_, i) => `Q${String(i).padStart(3, "0")}`);
    const a = new StockAliases(codes);
    expect(new Set(codes.map((c) => a.label(c))).size).toBe(80);
    expect(a.label("Q026")).toBe("Stock AA");
  });
});

describe("maskContext", () => {
  const u = (role: string | null) => ({ id: 1, role });
  it("Owner is unmasked; Editor, Viewer, unknown and missing users are masked", () => {
    expect(maskContext(u("owner"), false)).toEqual({ masked: false });
    expect(maskContext(u("editor"), false)).toEqual({ masked: true });
    expect(maskContext(u("viewer"), false)).toEqual({ masked: true });
    expect(maskContext(u("root"), false)).toEqual({ masked: true });
    expect(maskContext(u(null), true)).toEqual({ masked: true });
    expect(maskContext(null, true)).toEqual({ masked: true });
    expect(maskContext(undefined, true)).toEqual({ masked: true });
  });
  it("a live grant unmasks an Editor or a Viewer but not an unknown role", () => {
    expect(maskContext(u("editor"), true)).toEqual({ masked: false });
    expect(maskContext(u("viewer"), true)).toEqual({ masked: false });
    expect(maskContext(u("root"), true)).toEqual({ masked: true });
  });
});

describe("isGrantLive", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");
  it("is live until the expiry instant, and not after", () => {
    expect(isGrantLive({ expiresAt: "2026-10-20T00:00:00.001Z", revokedAt: null }, now)).toBe(true);
    expect(isGrantLive({ expiresAt: "2026-10-20T00:00:00.000Z", revokedAt: null }, now)).toBe(
      false,
    );
    expect(isGrantLive({ expiresAt: "2026-10-19T23:59:59.999Z", revokedAt: null }, now)).toBe(
      false,
    );
  });
  it("a revoked grant is never live, and an unparseable expiry is not live", () => {
    expect(
      isGrantLive({ expiresAt: "2099-01-01T00:00:00Z", revokedAt: "2026-10-01T00:00:00Z" }, now),
    ).toBe(false);
    expect(isGrantLive({ expiresAt: "not a date", revokedAt: null }, now)).toBe(false);
    expect(isGrantLive({ expiresAt: "", revokedAt: null }, now)).toBe(false);
  });
});

describe("maskText", () => {
  const aliases = new StockAliases(["BHP", "ZZUP"]);
  const lookup: MaskLookup = {
    known: new Set(["BHP", "ZZUP", "CBA"]),
    names: new Map([
      ["BHP", "BHP Group Limited"],
      ["ZZUP", "Zed Upward Holdings"],
      ["CBA", "Commonwealth Bank"],
    ]),
  };
  it("replaces codes and names of the active set by their letters", () => {
    expect(maskText("BHP Group Limited rose; BHP is held", aliases, lookup)).toBe(
      "Stock A rose; Stock A is held",
    );
    expect(maskText("zed upward holdings and ZZUP", aliases, lookup)).toBe("Stock B and Stock B");
  });
  it("masks another known code as 'Another stock' and leaves ordinary words alone", () => {
    expect(maskText("CBA fell. Bhpx and BHPX stay.", aliases, lookup)).toBe(
      `${UNKNOWN_STOCK} fell. Bhpx and BHPX stay.`,
    );
    expect(maskText("E01 F1 P1 UNVALIDATED", aliases, lookup)).toBe("E01 F1 P1 UNVALIDATED");
  });
  it("removes links and money amounts and turns exact dates into ISO weeks", () => {
    const out = maskText(
      "See https://example.test/a?b=1 and www.example.test/x. Bought at A$12.34, $5, AUD 1,200.50 on 2026-10-19.",
      aliases,
      lookup,
    );
    expect(out).not.toContain("example.test");
    expect(out).toContain(LINK_HIDDEN);
    expect(out).not.toMatch(/12\.34|1,200|\$5/);
    expect(out).toContain(PRICE_HIDDEN);
    expect(out).toContain("2026-W43");
    expect(out).not.toContain("2026-10-19");
  });
  it("is stable: masking twice equals masking once", () => {
    const once = maskText("BHP at $10 on 2026-10-19 via https://x.test", aliases, lookup);
    expect(maskText(once, aliases, lookup)).toBe(once);
  });
});

describe("weekOnly", () => {
  it("gives the ISO week of a date or an instant, else null", () => {
    expect(weekOnly("2026-10-19")).toBe("2026-W43");
    expect(weekOnly("2026-10-19T13:00:00.000Z")).toBe("2026-W43");
    expect(weekOnly("2026-12-31")).toBe("2026-W53");
    expect(weekOnly("2027-01-01")).toBe("2026-W53");
    expect(weekOnly("2026-02-31")).toBeNull();
    expect(weekOnly("x")).toBeNull();
    expect(weekOnly(null)).toBeNull();
  });
});

describe("findLeaks", () => {
  it("finds whole-token codes (any case) and whole names inside nested values", () => {
    expect(findLeaks({ a: ["x BHP y"], b: { c: "bhp" } }, ["BHP"])).toEqual(["BHP", "bhp"]);
    expect(findLeaks("BHPX and XBHP", ["BHP"])).toEqual([]);
    expect(findLeaks("Zed Upward Holdings", [], ["zed upward holdings"])).toEqual([
      "zed upward holdings",
    ]);
    expect(findLeaks("all of it", ["ALL"], [], { caseSensitive: true })).toEqual([]);
    expect(findLeaks("ALL of it", ["ALL"], [], { caseSensitive: true })).toEqual(["ALL"]);
  });
});

// ---- property test ------------------------------------------------------------------------------

describe("property: nothing identifying survives maskText for a masked context", () => {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const WORDS = ["rose", "fell", "held", "bought", "sold", "after", "results", "guidance", "halt"];

  function code(r: () => number): string {
    const n = 3 + Math.floor(r() * 2);
    return Array.from({ length: n }, () => LETTERS[Math.floor(r() * 26)]).join("");
  }
  function name(r: () => number, i: number): string {
    const w = ["Alpha", "Bravo", "Delta", "Mining", "Holdings", "Group", "Energy", "Capital"];
    return `${w[Math.floor(r() * w.length)]} ${w[Math.floor(r() * w.length)]} No${i}`;
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])(
    "seed %i",
    (seed) => {
      const r = rng(seed * 7919);
      const codes = [...new Set(Array.from({ length: 5 + Math.floor(r() * 15) }, () => code(r)))];
      const names = new Map(codes.map((c, i) => [c, name(r, i)]));
      const lookup: MaskLookup = { known: new Set(codes), names };
      const inSet = codes.filter(() => r() < 0.7);
      const aliases = new StockAliases(inSet);
      const records: string[] = [];
      const dates: string[] = [];
      const prices: string[] = [];
      const urls: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const c = codes[Math.floor(r() * codes.length)]!;
        const d = `2026-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`;
        const p = `A$${Math.floor(r() * 900) + 1}.${String(Math.floor(r() * 100)).padStart(2, "0")}`;
        const u = `https://news.example.test/${c.toLowerCase()}/${Math.floor(r() * 1000)}`;
        dates.push(d);
        prices.push(p);
        urls.push(u);
        const useName = r() < 0.4;
        records.push(
          `${useName ? names.get(c) : c} ${WORDS[Math.floor(r() * WORDS.length)]} at ${p} on ${d}, see ${u}`,
        );
      }
      const masked = records.map((t) => maskText(t, aliases, lookup));
      const blob = masked.join("\n");
      // Every known code is gone, whether it was in the set (a letter) or not ("Another stock").
      expect(findLeaks(blob, codes), `seed ${seed}`).toEqual([]);
      // Every company name is gone, those of the active set and those of any other known company.
      for (const c of codes) {
        expect(blob.toLowerCase(), `${seed} ${c}`).not.toContain(names.get(c)!.toLowerCase());
      }
      for (const p of prices) expect(blob, `${seed} ${p}`).not.toContain(p);
      for (const d of dates) expect(blob, `${seed} ${d}`).not.toContain(d);
      expect(blob).not.toContain("example.test");
      expect(blob).not.toContain("://");
      // Letters used are exactly those of the set.
      const used = new Set(blob.match(/Stock [A-Z]+/g) ?? []);
      const valid = new Set(inSet.map((c) => aliases.label(c)));
      for (const u of used) expect(valid.has(u), `${seed} ${u}`).toBe(true);
    },
  );

  it("letters are stable within a date whatever order the records arrive in", () => {
    const r = rng(42);
    const codes = Array.from({ length: 30 }, () => code(r));
    const a = new StockAliases(codes);
    const shuffled = [...codes].sort(() => r() - 0.5);
    const b = new StockAliases(shuffled);
    for (const c of codes) expect(b.label(c)).toBe(a.label(c));
  });
});
