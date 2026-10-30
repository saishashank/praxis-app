// @vitest-environment node
// M14 WP5 (DAT-237, D-240): the ingest route stores `content_hash`; an exact repeat of an item the
// code already holds is stored and marked assessed, but at materiality 0 so it never alerts.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { announcementContentHash, ingestFeed } from "@/lib/sentinel/ingest";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2026-10-13T00:10:00.000Z";
const T = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
const feed = (list: { id: string; code: string; time: string; title: string }[]) =>
  JSON.stringify({
    data: list.map((o) => ({
      type: "Progress Report",
      price_sensitive: true,
      url: "https://example.test/doc.pdf",
      ...o,
    })),
  });

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const go = (body: string, sha: string) =>
  ingestFeed({ db, feed: body, sha, now: NOW, today: "2026-10-13", maxItems: 40 });

describe("announcement.content_hash (DAT-237)", () => {
  it("the hash ignores case, punctuation and the time of day, not the code or the day", () => {
    const h = announcementContentHash("AU", "ZZAA", "Trading Update!", "2026-10-13T01:00:00.000Z");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      announcementContentHash("AU", "ZZAA", "trading  update", "2026-10-13T09:30:00.000Z"),
    ).toBe(h);
    expect(
      announcementContentHash("AU", "ZZBB", "Trading Update", "2026-10-13T01:00:00.000Z"),
    ).not.toBe(h);
    expect(
      announcementContentHash("AU", "ZZAA", "Trading Update", "2026-10-14T01:00:00.000Z"),
    ).not.toBe(h);
  });

  it("is written on insert", async () => {
    await go(
      feed([{ id: "1", code: "ZZAA", time: T(30), title: "Synthetic update" }]),
      "a".repeat(64),
    );
    const r = await db.execute("SELECT content_hash, title, published_at FROM announcement");
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0]!.content_hash)).toBe(
      announcementContentHash("AU", "ZZAA", "Synthetic update", String(r.rows[0]!.published_at)),
    );
  });

  it("a repost of the same item is stored, assessed at materiality 0 and raises no alert", async () => {
    await db.execute(
      "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU', '2026-10-12', 'ZZAA', 'active', 'U1'), ('AU', '2026-10-12', 'ZZBB', 'active', 'U1')",
    );
    const r = await go(
      feed([
        { id: "1", code: "ZZAA", time: T(30), title: "Trading Halt" },
        { id: "2", code: "ZZAA", time: T(20), title: "TRADING HALT." },
        { id: "3", code: "ZZBB", time: T(10), title: "Trading Halt" },
      ]),
      "b".repeat(64),
    );
    expect(r).toMatchObject({ ok: true, new: 3, assessed: 3, carried: 0 });
    const a = await db.execute(
      "SELECT s.code AS code, s.materiality AS materiality FROM item_assessment s JOIN announcement a ON a.source = s.source AND a.ann_id = s.ann_id ORDER BY s.code, a.published_at",
    );
    const byCode = a.rows.map((x) => [String(x.code), Number(x.materiality)]);
    expect(byCode[0]![1]).toBeGreaterThan(0); // the first ZZAA item keeps its materiality
    expect(byCode[1]).toEqual(["ZZAA", 0]); // the repost
    expect(byCode[2]![1]).toBeGreaterThan(0); // another code is not a repeat
  });

  // D-287: an exact-hash repeat only counts within the 5-session window of the earlier row
  it("a same-hash row older than the 5-session window is not a repeat (yearly Appendix 4C)", async () => {
    await db.execute(
      "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU', '2026-10-12', 'ZZAA', 'active', 'U1'), ('AU', '2026-10-12', 'ZZBB', 'active', 'U1')",
    );
    const items = [
      { id: "1", code: "ZZAA", time: T(30), title: "Trading Halt" },
      { id: "2", code: "ZZBB", time: T(20), title: "Trading Halt" },
    ];
    const forge = (code: string, id: string, time: string, hashOf: string) =>
      db.execute({
        sql: "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source, first_ingested_at, content_hash) VALUES ('AU', ?, ?, ?, ?, 'x', 1, 'Trading Halt', 'asx_announcements', ?, ?)",
        args: [code, id, time, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", hashOf],
      });
    const hash = (code: string, time: string) =>
      announcementContentHash("AU", code, "Trading Halt", time);
    // ZZAA: the same hash on a row published 40 days ago; ZZBB: one session ago (inside the window)
    await forge("ZZAA", "old", "2026-09-03T01:00:00.000Z", hash("ZZAA", T(30)));
    await forge("ZZBB", "recent", "2026-10-12T01:00:00.000Z", hash("ZZBB", T(20)));
    const r = await go(feed(items), "c".repeat(64));
    expect(r).toMatchObject({ ok: true, new: 2, assessed: 2 });
    const a = await db.execute(
      "SELECT s.code AS code, s.materiality AS materiality FROM item_assessment s ORDER BY s.code",
    );
    const m = Object.fromEntries(a.rows.map((x) => [String(x.code), Number(x.materiality)]));
    expect(m.ZZAA).toBeGreaterThan(0); // outside the window: assessed normally
    expect(m.ZZBB).toBe(0); // inside the window: a repeat
  });
});
