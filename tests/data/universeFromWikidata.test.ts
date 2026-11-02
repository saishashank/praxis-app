// @vitest-environment node
// DAT-236 (D-239): the offline Wikidata converter. No network: it reads a local JSON only, and its
// output must be accepted by the listed-companies parser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseListedCompanies } from "@/lib/data/universe/parse.mjs";
import { convert, main } from "../../scripts/data/universe-from-wikidata.mjs";

const b = (code: string, name: string, industry?: string) => ({
  code: { value: code },
  companyLabel: { value: name },
  ...(industry === undefined ? {} : { industryLabel: { value: industry } }),
});
const sparql = {
  results: {
    bindings: [
      b("ZZB", "Zed, Beta & Co", "Banks"),
      b("ZZA", 'Zed "Alpha" Ltd', "Mining"),
      b("ZZA", "Duplicate"),
      b("bad", "Lower case code"),
      b("ZZC", ""),
      b("ZZD", "No industry"),
    ],
  },
};

describe("universe-from-wikidata", () => {
  it("turns SPARQL JSON into a CSV that the universe parser accepts", () => {
    const r = convert(sparql);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({ input: 6, written: 3, skipped: 2, duplicates: 1 });
    expect(r.csv.split("\n")[0]).toBe("Company name,ASX code,GICS industry group");
    const p = parseListedCompanies(r.csv);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows).toEqual([
      { code: "ZZA", name: 'Zed "Alpha" Ltd', industry: "Mining" },
      { code: "ZZB", name: "Zed, Beta & Co", industry: "Banks" },
      { code: "ZZD", name: "No industry", industry: null },
    ]);
  });

  it("accepts a plain array, is deterministic, and refuses other shapes", () => {
    const rows = [{ code: "ZZA", name: "Zed A", industry: "Gold" }];
    expect(convert(rows)).toEqual(convert(rows));
    expect(convert({ nothing: 1 })).toEqual({ ok: false, error: "unrecognised_format" });
    expect(convert("text")).toEqual({ ok: false, error: "unrecognised_format" });
  });

  it("the CLI reads a local file and writes a local file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-"));
    try {
      writeFileSync(path.join(dir, "in.json"), JSON.stringify(sparql));
      const msgs: string[] = [];
      const say = (s: string) => msgs.push(s);
      expect(main([path.join(dir, "in.json"), "--out", path.join(dir, "u.csv")], say)).toBe(0);
      expect(readFileSync(path.join(dir, "u.csv"), "utf8")).toContain("ZZA");
      expect(main([path.join(dir, "missing.json")], say)).toBe(1);
      expect(main([], say)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds no network code", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "../../scripts/data/universe-from-wikidata.mjs"),
      "utf8",
    );
    expect(src).not.toMatch(/\bfetch\s*\(|node:https?|XMLHttpRequest|node:net/);
  });
});
