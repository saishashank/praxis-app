// @vitest-environment node
// M14 WP6 (FAM-006, DAT-234): loadDayInputs fills CodeFacts.industry (the finer manual class, else the
// ASX industry group) and CodeFacts.indexChanges through the reference-data readers; a code with
// neither carries exactly the v1 facts. The readers are injected (WP8 fills them). Synthetic data.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({
  classes: new Map<string, string>(),
  changes: new Map<string, unknown[]>(),
}));
vi.mock("@/lib/data/referenceData", async (orig) => ({
  ...(await orig<typeof import("@/lib/data/referenceData")>()),
  loadIndustryMap: async () => readers.classes,
  loadIndexChanges: async () => readers.changes,
}));

import { loadDayInputs, withReferenceData } from "@/lib/agents/candidates";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { cleanupTempDbs } from "../db/helpers";
import { freshReplayDb } from "../arena/replayHarness";
import { MARKET, buildNight, DATES, testParams, trend } from "./batch2bHarness";

const params = testParams();
const HOURS = { tz: "Australia/Melbourne", open_time: "10:00", close_time: "16:00" };
const THROUGH = 130;
const D = DATES[THROUGH]!;
let db: Client;

beforeAll(async () => {
  db = await freshReplayDb();
  await buildNight(db, {
    through: THROUGH,
    codes: [
      { code: "ZZA", close: trend(10_000_000n, 20_000n, 30_000n) },
      { code: "ZZB", close: trend(5_000_000n, 5_000n, 20_000n) },
      { code: "ZZC", close: trend(6_000_000n, 5_000n, 20_000n) },
    ],
  });
  for (const [code, industry] of [
    ["ZZA", "Banks"],
    ["ZZB", "Materials"],
  ] as const) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, industry) VALUES (?, ?, ?, ?)",
      args: [MARKET, code, code, industry],
    });
  }
}, 120_000);
afterAll(cleanupTempDbs);

const day = async () =>
  loadDayInputs(db, {
    market: MARKET,
    d: D,
    calendar: await loadCalendar(db, MARKET),
    hours: HOURS,
    params,
    replay: true,
    heldCodes: [],
    actions: [],
  });

describe("loadDayInputs reference data", () => {
  it("industry: the manual class wins, else the ASX group, else absent", async () => {
    readers.classes = new Map([["ZZB", "Gold"]]);
    readers.changes = new Map();
    const r = await day();
    expect(r.facts.get("ZZA")!.industry).toBe("Banks");
    expect(r.facts.get("ZZB")!.industry).toBe("Gold");
    expect("industry" in r.facts.get("ZZC")!).toBe(false);
    expect("indexChanges" in r.facts.get("ZZA")!).toBe(false);
  });

  it("index changes reach the facts of their code only", async () => {
    const change = { indexName: "ASX 200", kind: "add", announced: null, effective: D };
    readers.classes = new Map();
    readers.changes = new Map([["ZZC", [change]]]);
    const r = await day();
    expect(r.facts.get("ZZC")!.indexChanges).toEqual([change]);
    expect("indexChanges" in r.facts.get("ZZA")!).toBe(false);
  });
});

describe("withReferenceData", () => {
  it("adds nothing for null / empty values", async () => {
    readers.classes = new Map();
    readers.changes = new Map();
    const f = (await day()).facts.get("ZZC")!;
    expect(withReferenceData(f, null, [])).toEqual(f);
    expect(withReferenceData(f, undefined, undefined)).toEqual(f);
  });
});
