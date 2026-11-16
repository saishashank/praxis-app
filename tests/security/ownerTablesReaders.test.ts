// @vitest-environment node
// ARN-121 readers rule (M21 B2, D-1221, D-1275; F): the Owner's tables (`owner_trade`, `owner_trade_void`, `owner_holding`)
// are named only by the modules that are allowed to. No trading, learning, Cortex, arena, agent, alert, pick or replay
// module reads them, so nothing the Owner types in can move a book, order, signal or alert (AT-32 boundary). The list is
// exact: a new reader fails this test until it is added here with a reason, and a listed file that stops naming a table
// fails too. Also: no code anywhere updates or deletes a row of these tables (they are append-only).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TABLE = /\bowner_(?:trade|trade_void|holding)\b/;

/** The files that may name an Owner table, each with the tables it names and why. */
export const ALLOWED: Readonly<Record<string, { tables: readonly string[]; why: string }>> = {
  "src/lib/ownerTools/holdings.ts": {
    tables: ["owner_holding"],
    why: "B1 holdings: appends an upload and reads the newest; display only",
  },
  "src/lib/ownerTools/tradeLog/store.ts": {
    tables: ["owner_trade", "owner_trade_void"],
    why: "B2 trade log: appends trades and voids, reads the log for /trades",
  },
  "src/lib/tax/fromLog.ts": {
    tables: ["owner_trade", "owner_trade_void"],
    why: "B3 tax report on the log (lazy import, Owner tools on only); reads, writes nothing",
  },
  // not application code, but they name the tables by their nature:
  "scripts/db/gen-market-guard.mjs": {
    tables: ["owner_holding", "owner_trade"],
    why: "the market-guard trigger generator lists the market-keyed tables; it reads no row",
  },
  "e2e/seed/states/owner-tools-on.mjs": {
    tables: ["owner_trade", "owner_holding"],
    why: "the e2e seed state plants one trade and one upload in a throwaway database",
  },
};

/** Code only: whole-line and trailing comments are dropped, so prose in a comment is not a reader. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests", "docs", "coverage", "out"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith("wt-") || e.name.startsWith(".")) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const files = walk("");
const sources = new Map(files.map((f) => [f, code(fs.readFileSync(path.join(ROOT, f), "utf8"))]));

describe("ARN-121: only the allow-listed files name an Owner table", () => {
  it("scans real code (not vacuous)", () => {
    expect(files.filter((f) => f.startsWith("src/")).length).toBeGreaterThan(500);
    expect(sources.get("src/lib/ownerTools/tradeLog/store.ts")).toMatch(TABLE);
  });

  it("the files that name an owner_trade, owner_trade_void or owner_holding table are exactly the list", () => {
    const hits = files.filter((f) => TABLE.test(sources.get(f)!)).sort();
    expect(hits).toEqual(Object.keys(ALLOWED).sort());
  });

  it("each listed file names exactly the tables listed for it", () => {
    for (const [f, a] of Object.entries(ALLOWED)) {
      const named = [
        ...new Set(sources.get(f)!.match(/\bowner_(?:trade_void|trade|holding)\b/g) ?? []),
      ].sort();
      expect(named, f).toEqual([...a.tables].sort());
    }
  });

  it("no trading, learning, Cortex, arena, agent, alert, pick, replay, stats or worker module is on the list", () => {
    const FORBIDDEN =
      /^(src\/lib\/(agents|arena|learning|cortex|replay|picks|stats|alerts|intraday|signals|steelman|llm|email)\/|worker\/)/;
    expect(Object.keys(ALLOWED).filter((f) => FORBIDDEN.test(f))).toEqual([]);
  });

  it("the application's Owner-tool pages and actions name no table; they go through the modules", () => {
    const pages = files.filter((f) => f.startsWith("src/app/") || f.startsWith("src/components/"));
    expect(pages.filter((f) => TABLE.test(sources.get(f)!))).toEqual([]);
  });
});

describe("the Owner tables are append-only in code", () => {
  it("no file updates or deletes an Owner table row (the 0038 triggers would refuse it anyway)", () => {
    const WRITE =
      /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+owner_(?:trade|trade_void|holding)\b|ON\s+CONFLICT[^;`"']*DO\s+UPDATE/i;
    const bad = [...sources].filter(([, s]) => TABLE.test(s) && WRITE.test(s)).map(([f]) => f);
    expect(bad).toEqual([]);
  });
});
