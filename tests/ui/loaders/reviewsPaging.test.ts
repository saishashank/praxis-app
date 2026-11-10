// @vitest-environment node
// D-959 (OPS-104 d): the review list pages by the review date as a keyset cursor, never OFFSET. The pages
// are identical to what the old LIMIT/OFFSET form returned on the same fixture (the reference runs OFFSET
// in the test only), forwards and backwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../../db/helpers";
import { loadReviewList, parseReviewsQuery, type ReviewListModel } from "@/lib/ui/loaders/reviews";
import { emptyWorld, envOf, SHA, type World } from "../../loaders/world";

afterAll(cleanupTempDbs);

const PAGE = 30; // LIST_ROWS in reviews.ts
const TOTAL = 75;
let w: World;

const dayOf = (i: number) =>
  new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await emptyWorld();
  for (let i = 0; i < TOTAL; i++) {
    await w.main.execute({
      sql: `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
            VALUES (?, 1, 'full', '{}', ?, '<p>x</p>', 't', 'm', 10, 'rules', ?)`,
      args: [dayOf(i), SHA, `${dayOf(i)}T09:00:00.000Z`],
    });
  }
});

const days = (m: ReviewListModel) => m.rows.map((r) => r.d);

async function reference(page: number): Promise<string[]> {
  const r = await w.main.execute({
    sql: `SELECT e.d FROM evening_review e
          WHERE e.version = (SELECT MAX(v.version) FROM evening_review v WHERE v.d = e.d)
          ORDER BY e.d DESC LIMIT ? OFFSET ?`,
    args: [PAGE, (page - 1) * PAGE],
  });
  return r.rows.map((x) => String(x.d));
}

describe("review list keyset paging", () => {
  it("walks every page forwards, identical to the OFFSET pages", async () => {
    const env = envOf(w, "owner");
    let m = await loadReviewList(env, { page: 1, all: true });
    expect(m).toMatchObject({ hasNewer: false, hasMore: true, page: 1, newerBefore: null });
    expect(days(m)).toEqual(await reference(1));
    for (const page of [2, 3]) {
      m = await loadReviewList(env, { page, all: true, after: m.olderAfter! });
      expect(days(m)).toEqual(await reference(page));
      expect(m.hasNewer).toBe(true);
      expect(m.page).toBe(page);
    }
    expect(m.hasMore).toBe(false); // 75 reviews: the third page holds the last 15
    expect(days(m)).toHaveLength(TOTAL - 2 * PAGE);
  });

  it("walks back with the before cursor to the newest page", async () => {
    const env = envOf(w, "owner");
    const first = await loadReviewList(env, { page: 1, all: true });
    const second = await loadReviewList(env, { page: 2, all: true, after: first.olderAfter! });
    const back = await loadReviewList(env, { page: 1, all: true, before: second.newerBefore! });
    expect(days(back)).toEqual(days(first));
    expect(back).toMatchObject({ hasNewer: false, hasMore: true, page: 1 });
    // the middle page reached by a before cursor still has a newer page when one exists
    const third = await loadReviewList(env, { page: 3, all: true, after: second.olderAfter! });
    const backToSecond = await loadReviewList(env, {
      page: 2,
      all: true,
      before: third.newerBefore!,
    });
    expect(days(backToSecond)).toEqual(days(second));
    expect(backToSecond).toMatchObject({ hasNewer: true, hasMore: true, page: 2 });
  });

  it("a masked reader pages the bounded scan in memory (no cursor)", async () => {
    const m = await loadReviewList(envOf(w, "viewer"), { page: 1, all: true });
    expect(m.olderAfter).toBeNull();
    expect(m.newerBefore).toBeNull();
    expect(m.hasNewer).toBe(false);
  });

  it("the cursor parameters are validated", () => {
    expect(parseReviewsQuery(new URLSearchParams("after=2026-10-03"))).toMatchObject({
      after: "2026-10-03",
    });
    for (const bad of ["after=nope", "before=2026-13-45x", "after=2026-10-03&before=2026-10-04"]) {
      expect(parseReviewsQuery(new URLSearchParams(bad)), bad).toBeNull();
    }
  });
});
