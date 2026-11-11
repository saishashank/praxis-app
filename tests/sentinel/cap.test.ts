// @vitest-environment node
// DAT-251 b (D-954; AT-81): the key news_assess_per_run (20 to 200, Owner), the effective cap
// min(key, LLM headroom, Turso cap) and the unassessed count. Fixture data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { setConfig } from "@/lib/config/store";
import { CONFIG_KEYS } from "@/lib/config/keys";
import {
  effectiveAssessCap,
  loadEffectiveCap,
  TURSO_NEAR_LINE_CAP,
  tursoLevelNow,
} from "@/lib/sentinel/cap";
import { countUnassessed } from "@/lib/sentinel/ingest";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const base = { key: 120, llmRemainingTokens: 100_000, tokensPerItem: 0, tursoLevel: "ok" as const };

describe("the key", () => {
  it("is Owner-editable, default 40, bounds 20 to 200, and the old key is gone", async () => {
    const k = CONFIG_KEYS.news_assess_per_run;
    expect([k.default, k.editable, k.range, k.unit]).toEqual([40, "O", [20, 200], "items"]);
    expect(await k.validate(19, async () => null)).not.toBeNull();
    expect(await k.validate(20, async () => null)).toBeNull();
    expect(await k.validate(200, async () => null)).toBeNull();
    expect(await k.validate(201, async () => null)).not.toBeNull();
    expect("sentinel_max_items_per_run" in CONFIG_KEYS).toBe(false);
  });
});

describe("effectiveAssessCap (pure table)", () => {
  it("the key alone when nothing binds", () => {
    expect(effectiveAssessCap(base)).toMatchObject({
      cap: 120,
      llmHeadroomCap: null,
      tursoCap: null,
    });
  });
  it("the LLM headroom binds: remaining tokens / measured tokens per item", () => {
    const r = effectiveAssessCap({ ...base, tokensPerItem: 1000, llmRemainingTokens: 30_500 });
    expect(r).toMatchObject({ cap: 30, llmHeadroomCap: 30 });
  });
  it("an exhausted LLM budget still lets one item through, so the queue moves", () => {
    expect(effectiveAssessCap({ ...base, tokensPerItem: 1000, llmRemainingTokens: 0 }).cap).toBe(1);
  });
  it("the Turso cap is 40 at notice or worse and does not apply at ok or no data", () => {
    for (const lvl of ["notice", "alert", "degrade"] as const) {
      expect(effectiveAssessCap({ ...base, tursoLevel: lvl })).toMatchObject({
        cap: TURSO_NEAR_LINE_CAP,
        tursoCap: 40,
      });
    }
    expect(effectiveAssessCap({ ...base, tursoLevel: "no data" }).cap).toBe(120);
    expect(effectiveAssessCap({ ...base, tursoLevel: "ok" }).cap).toBe(120);
  });
  it("the key below the other caps wins; the key can never lift a cap above them", () => {
    expect(effectiveAssessCap({ ...base, key: 25, tursoLevel: "notice" }).cap).toBe(25);
    expect(effectiveAssessCap({ ...base, key: 200, tursoLevel: "notice" }).cap).toBe(40);
    expect(
      effectiveAssessCap({ ...base, key: 200, tokensPerItem: 500, llmRemainingTokens: 10_000 }).cap,
    ).toBe(20);
  });
});

describe("loadEffectiveCap and tursoLevelNow on a database", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });
  const NOW = new Date("2026-11-12T01:00:00.000Z");
  const setKey = (v: number) =>
    setConfig(db, {
      key: "news_assess_per_run",
      value: v,
      userId: null,
      reason: "test",
      now: "2026-11-12T00:00:00.000Z",
    });
  const sample = (read: number, written: number) =>
    db.execute({
      sql: `INSERT INTO usage_sample (sampled_at, rows_read_month, rows_written_month, storage_bytes, plan_name, source)
            VALUES ('2026-11-12T00:40:00.000Z', ?, ?, 1000, 'free', 'platform')`,
      args: [read, written],
    });

  it("without a sample the Turso level is ok and the cap is the key", async () => {
    expect(await tursoLevelNow(db, NOW)).toBe("ok");
    expect((await loadEffectiveCap(db, NOW)).cap).toBe(40); // the default key
    await setKey(150);
    expect((await loadEffectiveCap(db, NOW)).cap).toBe(150);
  });

  it("a sample at the notice share (15 % of the plan) caps a raised key back to 40", async () => {
    await setKey(150);
    // 15 % of 500 M reads is 75 M, which is 75 % of the 100 M line (the 20 % ceiling)
    await sample(75_000_000, 100_000);
    expect(["notice", "alert"]).toContain(await tursoLevelNow(db, NOW)); // the two share a threshold (D-958)
    const r = await loadEffectiveCap(db, NOW);
    expect(r).toMatchObject({ key: 150, tursoCap: 40, cap: 40 });
  });

  it("a sample under the notice share leaves the key alone", async () => {
    await setKey(150);
    await sample(10_000_000, 100_000);
    expect((await loadEffectiveCap(db, NOW)).cap).toBe(150);
  });
});

describe("the unassessed count", () => {
  it("counts the carry window's announcements that have no assessment", async () => {
    const db = await freshDb("main");
    const now = "2026-11-12T01:00:00.000Z";
    const ann = (id: string, publishedAt: string) =>
      db.execute({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
              VALUES ('AU','ZZA',?,?,?,NULL,0,'t',NULL,'asx_announcements')`,
        args: [id, publishedAt, publishedAt],
      });
    await ann("a1", "2026-11-12T00:00:00.000Z");
    await ann("a2", "2026-11-11T23:00:00.000Z");
    await ann("old", "2026-11-01T00:00:00.000Z"); // outside the 48 h carry window
    await db.execute({
      sql: `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity, held, watch, candidate, tracked, assessed_at)
            VALUES ('asx_announcements','a2','AU','ZZA',1,'r',0,0,0,0,0,?)`,
      args: [now],
    });
    expect(await countUnassessed(db, now)).toBe(1);
  });
});
