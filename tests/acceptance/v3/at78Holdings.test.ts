// @vitest-environment node
// AT-78 "a holding changes no book" (M21 B1, D-1220, D-1221): the AT-32 golden ZZ world is built twice, once as it is and
// once with a planted `owner_holding` upload, and every table except `owner_holding` dumps identically (every book, order,
// signal, rule, alert, card and Cortex table). Also: no trading, learning or Cortex module names the table. Synthetic ZZ
// data only (SEC-110).
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { saveHoldings } from "@/lib/ownerTools/holdings";
import { cleanupTempDbs } from "../../db/helpers";
import { at32World, dump } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const ROOT = path.resolve(import.meta.dirname, "../../..");
/** Code only: whole-line and trailing comments are dropped, so prose in a comment is not a reader. */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
// the market-guard trigger generator derives its table list from the schema; it reads no row
const GUARD_GENERATOR = "scripts/db/gen-market-guard.mjs";

describe("AT-78: a planted holding moves nothing (D-1220)", () => {
  it("the golden world dumps identically with and without a holdings upload, except owner_holding", async () => {
    const plain = await at32World();
    const planted = await at32World(async (db) => {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        code: `ZZH${i}`,
        qty: 100 + i,
        avgCostMicro: BigInt(1_000_000 + i * 250_000),
      }));
      const saved = await saveHoldings(
        db,
        "AU",
        rows,
        new Date("2030-01-01T00:00:00.000Z"),
        "00000001",
      );
      expect(saved).toMatchObject({ ok: true });
    });
    const a = await dump(plain);
    const b = await dump(planted);
    // not vacuous: the world has orders and the plant is there
    expect(a.rows.arena_order).toBeGreaterThan(0);
    expect(a.rows.owner_holding).toBe(0);
    expect(b.rows.owner_holding).toBe(12);
    expect(Object.keys(b.perTable).sort()).toEqual(Object.keys(a.perTable).sort());
    const differing = Object.keys(a.perTable)
      .filter((t) => a.perTable[t] !== b.perTable[t])
      .sort();
    expect(differing).toEqual(["owner_holding"]);
    for (const t of Object.keys(a.rows).filter((t) => t !== "owner_holding")) {
      expect(b.rows[t], `${t} row count`).toBe(a.rows[t]);
    }
  });

  it("no trading, learning, Cortex, arena or agent module reads the holdings table", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const roots = [
      "src/lib/agents",
      "src/lib/arena",
      "src/lib/learning",
      "src/lib/cortex",
      "src/lib/replay",
      "src/lib/picks",
      "src/lib/stats",
      "src/lib/alerts",
      "src/lib/intraday",
      "scripts",
      "worker",
    ];
    const bad: string[] = [];
    for (const r of roots) {
      if (!fs.existsSync(path.join(ROOT, r))) continue;
      for (const f of walk(r)) {
        if (f === GUARD_GENERATOR) continue;
        if (/\bowner_holding\b/.test(code(fs.readFileSync(path.join(ROOT, f), "utf8"))))
          bad.push(f);
      }
    }
    expect(bad).toEqual([]);
  });

  it("only the Owner-tools modules, pages and the migrations name the table in the app", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
          if (/\bowner_holding\b/.test(code(fs.readFileSync(path.join(ROOT, rel), "utf8"))))
            hits.push(rel);
        }
      }
    };
    walk("src");
    expect(hits.sort()).toEqual(["src/lib/ownerTools/holdings.ts"]);
  });
});
