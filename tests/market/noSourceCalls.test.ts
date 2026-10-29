// @vitest-environment node
// UXN-273 (ch.16 16.24 acceptance): "1,000 Market page views in a day -> the number of external
// data-source calls is unchanged". The pages read stored data only. This test drives 1,000 page views
// (market tab, company page, overview, search) through the loaders the pages use, with a fetch stub that
// throws on ANY call (every external host, and anything else), and checks that no call is made and that
// no stored row changed (a page view writes nothing). A source scan adds that the Market code contains no
// fetch to an absolute URL, and that the only same-origin fetches are the two read-only GET routes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCompany, loadIndexStrip } from "@/lib/ui/loaders/company";
import { loadMarket, loadOverview, searchInstruments } from "@/lib/ui/loaders/market";
import { mq } from "./query";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld, type Who, type World } from "../loaders/world";

let w: World;
const fetchCalls: string[] = [];

beforeAll(async () => {
  w = await fullWorld();
});
afterAll(cleanupTempDbs);
afterEach(() => vi.unstubAllGlobals());

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["price_bar", "instrument", "announcement", "index_bar", "watch_list_owner"]) {
    out[t] = Number((await w.main.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
  }
  return out;
}

describe("1,000 Market page views", () => {
  it("make no external source call and write nothing", async () => {
    vi.stubGlobal("fetch", (input: unknown) => {
      fetchCalls.push(String(input));
      throw new Error(`external source call refused: ${String(input)}`);
    });
    const before = await counts();
    const roles: Who[] = ["owner", "editor", "viewer", "granted"];
    let views = 0;
    for (let i = 0; i < 1000; i++) {
      const env = envOf(w, roles[i % roles.length]!);
      switch (i % 5) {
        case 0:
          await Promise.all([loadMarket(env, mq()), loadIndexStrip(env)]);
          break;
        case 1:
          await Promise.all([loadMarket(env, mq({ open: ["all"] })), loadIndexStrip(env)]);
          break;
        case 2:
          await loadCompany(env, env.mask.masked ? "stock-b" : "ZZUP");
          break;
        case 3:
          await loadOverview(env, env.mask.masked ? "stock-b" : "ZZDN");
          break;
        default:
          await searchInstruments(env, "zz");
      }
      views += 1;
    }
    expect(views).toBe(1000);
    expect(fetchCalls).toEqual([]);
    expect(await counts()).toEqual(before);
  }, 240_000);
});

describe("the Market source", () => {
  const roots = [
    path.resolve(import.meta.dirname, "../../src/app/(app)/market"),
    path.resolve(import.meta.dirname, "../../src/lib/ui/loaders/company.ts"),
    path.resolve(import.meta.dirname, "../../src/lib/ui/loaders/market.ts"),
  ];
  const files = (p: string): string[] =>
    statSync(p).isDirectory()
      ? readdirSync(p).flatMap((n) => files(path.join(p, n)))
      : /\.(ts|tsx)$/.test(p)
        ? [p]
        : [];
  const sources = roots.flatMap(files).map((f) => ({ f, text: readFileSync(f, "utf8") }));

  it("never fetches an absolute URL; the only fetches are same-origin GET routes", () => {
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/fetch\(\s*([^,)]+)/g)) {
        const arg = m[1]!.trim();
        expect(
          arg.startsWith("`/api/market/") || arg.startsWith('"/api/market/'),
          `${f}: ${arg}`,
        ).toBe(true);
      }
      expect(text, f).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
      expect(text, f).not.toMatch(/yahoo|asx\.com\.au|finance\./i);
    }
  });

  it("the loaders import no source fetcher (data pipeline) module", () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/from "@\/lib\/data\/(asx|yahoo|fetch|ingest|sources)/);
      expect(text, f).not.toMatch(/from "@\/lib\/sentinel\/(poll|asx)/);
    }
  });
});
