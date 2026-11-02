// @vitest-environment node
// DAT-237 (D-240): exact and MinHash de-duplication of announcement titles. Pure, deterministic,
// synthetic titles only.
import { describe, expect, it } from "vitest";
import {
  dedupAnnouncements,
  minhashSignature,
  minhashSimilarity,
  normaliseTitle,
  shingles,
  MINHASH_SIZE,
  type DedupItem,
} from "@/lib/agents/announcementDedup";
import type { CalendarRow } from "@/lib/data/calendar";

const calendar: CalendarRow[] = [{ d: "2026-10-26", kind: "holiday", close_time: null }];
const opts = { calendar, windowSessions: 5, threshold: 0.85 };

const LONG = "Company announces full year results and final dividend for the year ended June";
const LONG_NEAR = `${LONG} 2026`;
const OTHER = "Quarterly cash flow report and appendix four c for the period ended September";

let n = 0;
const item = (code: string, title: string, published: string): DedupItem => ({
  source: "asx",
  ann_id: `a${++n}`,
  code,
  published_at: published,
  title,
  session: published.slice(0, 10),
});

describe("normaliseTitle and shingles", () => {
  it("lower-cases, strips punctuation and collapses spaces", () => {
    expect(normaliseTitle("  Appendix 3Y -  Change of Director's Interest!! ")).toBe(
      "appendix 3y change of director s interest",
    );
  });

  it("makes word 3-shingles; a short title is one shingle; empty is none", () => {
    expect(shingles("a b c d")).toEqual(["a b c", "b c d"]);
    expect(shingles("a b")).toEqual(["a b"]);
    expect(shingles("")).toEqual([]);
  });
});

describe("MinHash", () => {
  it("is deterministic and has the configured size", () => {
    const a = minhashSignature(normaliseTitle(LONG));
    const b = minhashSignature(normaliseTitle(LONG));
    expect(a).toHaveLength(MINHASH_SIZE);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(minhashSimilarity(a, b)).toBe(1);
  });

  it("a one-word change scores high, an unrelated title scores low", () => {
    const a = minhashSignature(normaliseTitle(LONG));
    expect(
      minhashSimilarity(a, minhashSignature(normaliseTitle(LONG_NEAR))),
    ).toBeGreaterThanOrEqual(0.85);
    expect(minhashSimilarity(a, minhashSignature(normaliseTitle(OTHER)))).toBeLessThan(0.3);
  });
});

describe("dedupAnnouncements", () => {
  it("an exact repost is a duplicate of the earlier item", () => {
    const a = item("AAA", "Trading update", "2026-10-14T01:00:00.000Z");
    const b = item("AAA", "TRADING  UPDATE!", "2026-10-14T03:00:00.000Z");
    const r = dedupAnnouncements([b, a], opts);
    expect([...r.duplicates]).toEqual([[`asx|${b.ann_id}`, `asx|${a.ann_id}`]]);
  });

  it("a near-duplicate on the next day is a duplicate; a different title is not", () => {
    const a = item("AAA", LONG, "2026-10-14T01:00:00.000Z");
    const b = item("AAA", LONG_NEAR, "2026-10-15T01:00:00.000Z");
    const c = item("AAA", OTHER, "2026-10-15T02:00:00.000Z");
    const r = dedupAnnouncements([a, b, c], opts);
    expect([...r.duplicates.keys()]).toEqual([`asx|${b.ann_id}`]);
  });

  it("a different code is never a duplicate", () => {
    const a = item("AAA", LONG, "2026-10-14T01:00:00.000Z");
    const b = item("BBB", LONG, "2026-10-14T02:00:00.000Z");
    expect(dedupAnnouncements([a, b], opts).duplicates.size).toBe(0);
  });

  it("5 sessions apart is a repeat, 6 is a new item", () => {
    const a = item("AAA", LONG, "2026-10-12T01:00:00.000Z"); // Mon
    const in5 = item("AAA", LONG_NEAR, "2026-10-19T01:00:00.000Z"); // Mon, 5 sessions later
    const out6 = item("AAA", LONG_NEAR, "2026-10-20T01:00:00.000Z"); // Tue, 6 sessions later
    expect(dedupAnnouncements([a, in5], opts).duplicates.size).toBe(1);
    expect(dedupAnnouncements([a, out6], opts).duplicates.size).toBe(0);
  });

  it("a holiday is not a session", () => {
    const a = item("AAA", LONG, "2026-10-23T01:00:00.000Z"); // Fri
    // Tue 27, Wed 28, Thu 29, Fri 30, Mon 2 Nov: 5 sessions (Mon 26 Oct is a holiday)
    const b = item("AAA", LONG_NEAR, "2026-11-02T01:00:00.000Z");
    expect(dedupAnnouncements([a, b], opts).duplicates.size).toBe(1);
  });

  it("is independent of input order", () => {
    const list = [
      item("AAA", LONG, "2026-10-14T01:00:00.000Z"),
      item("AAA", LONG_NEAR, "2026-10-14T02:00:00.000Z"),
      item("AAA", OTHER, "2026-10-14T03:00:00.000Z"),
    ];
    const fwd = [...dedupAnnouncements(list, opts).duplicates];
    const rev = [...dedupAnnouncements([...list].reverse(), opts).duplicates];
    expect(rev).toEqual(fwd);
  });
});
