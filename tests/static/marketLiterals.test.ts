// @vitest-environment node
// AT-67 (M19 E1, MKT-107, D-991, D-1000): a market fact is written once, in the profile seed. The scan
// (scripts/ci/market-literals.mjs, also `npm run test:market-literals`) finds no market code, exchange or city word,
// market zone, AU session time, currency symbol, Yahoo suffix, index code, parcel literal or classification name in code
// outside the allow-list. A literal planted into a temporary copy of the tree must fail, and removing it must pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSES, EXTRA_ALLOW, scanTree } from "../../scripts/ci/market-literals.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

const put = (root: string, rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

describe("AT-67 market literals", () => {
  it("the tree has 0 literals outside the allow-list (the D-991 count is 0 too)", () => {
    const r = scanTree(ROOT);
    expect(r.hits.map((h) => `${h.file}:${h.line} [${h.cls}] ${h.text}`)).toEqual([]);
    expect(r.quotedFiles).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.files).toBeGreaterThan(500);
  });

  it("the market profile folder is read: the seed files hold the literals the scan allows", () => {
    const r = scanTree(ROOT);
    expect(r.allowed).toBeGreaterThan(50);
  });

  it("a planted literal in a copy of the code fails, one per class, and passes once removed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mlit-"));
    try {
      const planted: Record<string, string> = {
        marketCode: `export const m = "A${"U"}";`,
        exchangeWord: `export const l = "New ${"York"} close";`,
        zone: `export const z = "Asia/${"Kolkata"}";`,
        sessionTime: `export const t = "09:${"55"}";`,
        currency: `export const c = "US${"$"}5";`,
        yahooSuffix: `export const s = c + ".${"NS"}";`,
        indexCode: `export const i = "^${"GSPC"}";`,
        moneyLiteral: `export const p = 50_${"000"}_000_000n;`,
        classification: `export const g = "g${"ics"}-sector";`,
      };
      expect(Object.keys(planted).sort()).toEqual(Object.keys(CLASSES).sort());
      for (const [cls, text] of Object.entries(planted)) {
        put(root, "src/lib/zz.ts", `${text}\n`);
        const r = scanTree(root);
        expect(
          r.hits.map((h) => h.cls),
          cls,
        ).toContain(cls);
      }
      fs.rmSync(path.join(root, "src/lib/zz.ts"));
      expect(scanTree(root).hits).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the allow-list is honoured for the seed folder and the registered files, and for nothing else", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mlit-"));
    try {
      put(root, "src/lib/market/seed/ZZ.mjs", 'export const code = "AU";\n');
      put(
        root,
        "src/lib/market/seed/allow.mjs",
        'export const MARKET_LITERAL_ALLOW = [\n  "src/lib/data/rules.mjs", // x\n];\n',
      );
      put(root, "src/lib/data/rules.mjs", 'export const code = "AU";\n');
      expect(scanTree(root).hits).toEqual([]);
      put(root, "src/lib/data/unregistered.mjs", 'export const code = "AU";\n');
      expect(scanTree(root).hits.map((h) => h.file)).toEqual(["src/lib/data/unregistered.mjs"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("every extra allow entry says why", () => {
    for (const e of EXTRA_ALLOW) expect(e.reason.length, e.file ?? e.dir).toBeGreaterThan(20);
  });
});
