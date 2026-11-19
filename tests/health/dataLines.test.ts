// @vitest-environment node
// DAT-251 b / DAT-252 (2): the Owner's data-feed lines on System Health, counts only.
import { afterEach, describe, expect, it } from "vitest";
import { getHealthSummary } from "@/lib/health/summary";
import { companyListLine, dataFeedLines, newsWaitingLine } from "@/lib/health/dataLines";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("pure lines", () => {
  it("news line: counts only, none when nothing waits", () => {
    expect(newsWaitingLine(0)).toBeNull();
    expect(newsWaitingLine(1)).toBe("News: 1 item waiting for assessment");
    expect(newsWaitingLine(75)).toBe("News: 75 items waiting for assessment");
  });
  it("company-list line: the fixed wording, none while healthy", () => {
    expect(companyListLine(0, false)).toBeNull();
    expect(companyListLine(3, false)).toBe(
      "Company list: ASX fetch failed 3 runs; the Wikidata fallback is off (Data sources)",
    );
    expect(companyListLine(1, true)).toBe(
      "Company list: ASX fetch failed 1 run; the Wikidata fallback is on",
    );
  });
});

describe("on a database", () => {
  const NOW = new Date("2026-11-12T01:00:00.000Z");

  it("shows the waiting news and the failing list; a Viewer sees none", async () => {
    const db = await freshDb("main");
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES ('AU','ZZA','a1','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z',NULL,0,'secret title',NULL,'asx_announcements')`,
      args: [],
    });
    await db.execute(
      "INSERT INTO source_fetch_status (source, consecutive_failures, last_cause) VALUES ('asx_listed_companies', 3, 'server_error')",
    );
    expect(await dataFeedLines(db, NOW)).toEqual([
      "News: 1 item waiting for assessment",
      "Company list: ASX fetch failed 3 runs; the Wikidata fallback is off (Data sources)",
    ]);
    const owner = await getHealthSummary(db, NOW, "owner");
    expect(owner.dataLines).toHaveLength(2);
    expect(JSON.stringify(owner.dataLines)).not.toMatch(/ZZA|secret title/);
    expect((await getHealthSummary(db, NOW, "viewer")).dataLines).toBeUndefined();
  });

  it("is empty when nothing waits and the list fetch is healthy", async () => {
    const db = await freshDb("main");
    expect(await dataFeedLines(db, NOW)).toEqual([]);
  });
});
