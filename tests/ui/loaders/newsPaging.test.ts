// @vitest-environment node
// D-959 (OPS-104 d): the news list pages by keyset cursor "<published_at>|<id>", never OFFSET. The pages
// are identical to what the old LIMIT/OFFSET form returned on the same fixture (the reference below
// runs OFFSET in the test only), forwards and backwards, including items that share one timestamp.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../../db/helpers";
import { loadNews, parseNewsQuery, type NewsModel } from "@/lib/ui/loaders/news";
import { emptyWorld, envOf, type World } from "../../loaders/world";

afterAll(cleanupTempDbs);

const PAGE = 50; // LIST_ROWS in news.ts
const TOTAL = 120;
let w: World;

beforeAll(async () => {
  w = await emptyWorld();
  for (let i = 0; i < TOTAL; i++) {
    // three items share each timestamp so the id half of the cursor decides ties
    const at = `2026-10-${String(1 + Math.floor(i / 12)).padStart(2, "0")}T0${Math.floor(i / 4) % 10}:00:00`;
    await w.main.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive,
            title, url, source) VALUES ('AU', 'ZZUP', ?, ?, ?, 'Results', 1, ?, 'https://news.example.test/d.pdf', 'src')`,
      args: [`a${i}`, at, at, `Item ${i}`],
    });
  }
});

const cursorOf = (m: NewsModel) => ({ older: m.olderAfter, newer: m.newerBefore });
const titles = (m: NewsModel) => m.items.map((x) => x.title);

/** The old output, by OFFSET (test-only reference). */
async function reference(page: number): Promise<string[]> {
  const r = await w.main.execute({
    sql: `SELECT title FROM announcement WHERE market = 'AU' ORDER BY published_at DESC, id DESC
          LIMIT ? OFFSET ?`,
    args: [PAGE, (page - 1) * PAGE],
  });
  return r.rows.map((x) => String(x.title));
}

describe("news keyset paging", () => {
  it("walks every page forwards, identical to the OFFSET pages", async () => {
    const env = envOf(w, "owner");
    let m = await loadNews(env, { chip: "all", show: "all", page: 1 });
    expect(m).toMatchObject({ hasNewer: false, hasMore: true, page: 1, newerBefore: null });
    expect(titles(m)).toEqual(await reference(1));
    for (const page of [2, 3]) {
      const q = parseNewsQuery(
        new URLSearchParams({ show: "all", page: String(page), after: m.olderAfter! }),
      )!;
      m = await loadNews(env, q);
      expect(titles(m)).toEqual(await reference(page));
      expect(m.hasNewer).toBe(true);
      expect(m.page).toBe(page);
    }
    expect(m.hasMore).toBe(false); // 120 items: the third page is the last
    expect(m.olderAfter).toBeNull();
    expect(titles(m)).toHaveLength(TOTAL - 2 * PAGE);
  });

  it("walks back with the before cursor and reaches the newest page", async () => {
    const env = envOf(w, "owner");
    const first = await loadNews(env, { chip: "all", show: "all", page: 1 });
    const second = await loadNews(env, {
      chip: "all",
      show: "all",
      page: 2,
      after: first.olderAfter!,
    });
    const back = await loadNews(env, {
      chip: "all",
      show: "all",
      page: 1,
      before: second.newerBefore!,
    });
    expect(titles(back)).toEqual(titles(first));
    expect(back).toMatchObject({ hasNewer: false, hasMore: true, page: 1, newerBefore: null });
    expect(cursorOf(back).older).toBe(first.olderAfter);
  });

  it("never repeats or skips an item when timestamps tie", async () => {
    const env = envOf(w, "owner");
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const m = await loadNews(env, { chip: "all", show: "all", page: 1, after });
      seen.push(...titles(m));
      if (!m.hasMore) break;
      after = m.olderAfter!;
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("a masked reader pages the bounded scan in memory (no cursor, no OFFSET)", async () => {
    const m = await loadNews(envOf(w, "viewer"), { chip: "all", show: "all", page: 1 });
    expect(m.olderAfter).toBeNull();
    expect(m.newerBefore).toBeNull();
  });

  it("the cursor parameters are validated", () => {
    const ok = parseNewsQuery(new URLSearchParams("after=2026-10-03T01:00:00|17"));
    expect(ok?.after).toBe("2026-10-03T01:00:00|17");
    for (const bad of [
      "after=x",
      "after=2026-10-03T01:00:00|abc",
      "after=2026-10-03T01:00:00|1&before=2026-10-03T01:00:00|2",
      "before=' OR 1=1 --|1",
    ]) {
      expect(parseNewsQuery(new URLSearchParams(bad)), bad).toBeNull();
    }
  });
});
