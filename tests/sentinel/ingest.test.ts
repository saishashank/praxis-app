// @vitest-environment node
// M5 T5 (AGT-010, AGT-011, AGT-014, AGT-015, PLT-075; D-100 draft): the Sentinel ingest core.
// Feed parser seam, rule materiality table, first-seen idempotency, membership flags, the 40-item
// cap with carry, the carry window. Real SQLite with all migrations; synthetic ZZ* data only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asxFeedV1 } from "@/lib/sentinel/feed";
import { assess, type Membership } from "@/lib/sentinel/materiality";
import { ingestFeed, MAX_ITEMS_PER_RUN } from "@/lib/sentinel/ingest";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

type Raw = {
  id: string;
  code: string;
  time: string;
  type?: string;
  price_sensitive?: boolean;
  title?: string;
  url?: string;
};
const item = (o: Raw) => ({
  type: "Progress Report",
  price_sensitive: false,
  title: "Synthetic routine update",
  url: "https://example.test/doc.pdf",
  ...o,
});
export const feedOf = (list: Raw[]): string => JSON.stringify({ data: list.map(item) });

const NOW = "2026-10-13T00:10:00.000Z"; // Tue 11:10 AEDT
const TODAY = "2026-10-13";
const T = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
const SHA = "a".repeat(64);

const NONE: Membership = { held: false, watch: false, candidate: false, tracked: false };
const TRACKED: Membership = { ...NONE, tracked: true };
const HELD: Membership = { ...NONE, held: true, tracked: true };
const WATCH: Membership = { ...NONE, watch: true, candidate: true };

describe("asxFeedV1 (the adapter seam)", () => {
  it("parses the documented synthetic shape", () => {
    const p = asxFeedV1.parse(
      feedOf([{ id: "1", code: "ZZAA", time: "2026-10-13T10:00:00+11:00" }]),
    );
    expect(p?.items).toHaveLength(1);
    expect(p?.items[0]).toMatchObject({
      code: "ZZAA",
      publishedAt: "2026-10-12T23:00:00.000Z",
      priceSensitive: false,
    });
    expect(p?.items[0].annId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns null (never throws) for anything that is not a feed", () => {
    for (const body of ["", "not json", "null", "[]", '{"data":5}', "<html>x</html>"]) {
      expect(asxFeedV1.parse(body)).toBeNull();
    }
  });

  it("skips malformed and duplicate entries and counts them", () => {
    const body = JSON.stringify({
      data: [
        item({ id: "1", code: "ZZAA", time: "2026-10-13T10:00:00+11:00" }),
        item({ id: "1", code: "ZZAA", time: "2026-10-13T10:00:00+11:00" }), // duplicate
        item({ id: "2", code: "bad code", time: "2026-10-13T10:00:00+11:00" }),
        item({ id: "3", code: "ZZBB", time: "2026-10-13" }), // date only
      ],
    });
    const p = asxFeedV1.parse(body);
    expect(p?.items).toHaveLength(1);
    expect(p?.skipped).toBe(3);
  });
});

describe("rule materiality (AGT-011, design 2.2)", () => {
  const at = (
    m: Membership,
    title: string,
    o: { type?: string | null; ps?: boolean } = {},
  ): number =>
    assess({ type: o.type ?? null, title, priceSensitive: o.ps ?? false }, m).materiality;

  it("3: price-sensitive, halt or exchange query on a held code", () => {
    expect(at(HELD, "Update on trading", { ps: true })).toBe(3);
    expect(at(HELD, "Trading Halt")).toBe(3);
    expect(at(HELD, "x", { type: "Price Query" })).toBe(3);
    expect(at(HELD, "Quarterly activities report")).toBe(2); // routine results-type on a held code
    expect(at(HELD, "Notice of meeting")).toBe(1);
  });

  it("3: takeover or scheme on a tracked code, not on an untracked one", () => {
    expect(at(TRACKED, "Scheme of arrangement announced")).toBe(3);
    expect(at(TRACKED, "Takeover offer received")).toBe(3);
    expect(at(NONE, "Takeover offer received")).toBe(0);
  });

  it("2: price-sensitive on a watch-list or candidate code; results and capital raising on tracked", () => {
    expect(at(WATCH, "Update", { ps: true })).toBe(2);
    expect(at({ ...NONE, candidate: true }, "Update", { ps: true })).toBe(2);
    expect(at(TRACKED, "Half-year results")).toBe(2);
    expect(at(TRACKED, "Placement to raise funds")).toBe(2);
    expect(at(TRACKED, "Appendix 3Y change of director's interest")).toBe(2);
    expect(at(TRACKED, "Company lowers guidance")).toBe(2);
  });

  it("1: other announcements on a tracked code (price-sensitive too, if not watch or held)", () => {
    expect(at(TRACKED, "Notice of meeting")).toBe(1);
    expect(at(TRACKED, "Update", { ps: true })).toBe(1);
  });

  it("0: an untracked code, whatever the title or flag", () => {
    expect(at(NONE, "Half-year results", { ps: true })).toBe(0);
    expect(at(NONE, "Trading Halt")).toBe(0);
  });

  it("polarity is fixed by category and 0 otherwise (no abnormal return yet)", () => {
    expect(
      assess({ type: null, title: "Company lowers guidance", priceSensitive: false }, TRACKED)
        .polarity,
    ).toBe(-1);
    expect(
      assess({ type: null, title: "Company raises guidance", priceSensitive: false }, TRACKED)
        .polarity,
    ).toBe(1);
    expect(
      assess({ type: null, title: "Notice of meeting", priceSensitive: false }, TRACKED).polarity,
    ).toBe(0);
  });
});

// ---- database ---------------------------------------------------------------------------------

let db: Client;
const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });
const rows = async (sql: string, args: (string | number | null)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

async function seedHeld(code: string, o: { live?: number; kind?: string; id?: string } = {}) {
  const id = o.id ?? code;
  const kind = o.kind ?? "E";
  await run(
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES (?, 'AU', ?, ?, ?, 'T1', 'rv1', 'P5')`,
    [`X${id}`, kind, kind === "E" ? "F1" : null, kind === "E" ? "U" : null],
  );
  await run(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed, live) VALUES (?, ?, '2026-10-12', 600000000, 'rv1', '{}', 1, 42, ?)`,
    [`K${id}`, `X${id}`, o.live ?? 1],
  );
  await run(
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, '2026-10-12', ?, 'buy', 'entry', 10, 'pending')`,
    [`O${id}`, `K${id}`, code],
  );
  await run(
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
       slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
       bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES (?, ?, ?, '2026-10-13', ?, 'buy', 10, 'open', 1000000, 5000, 1005000, 10050000,
       30000000, 'P5', 1000000, 1100000, 900000, 1050000)`,
    [`F${id}`, `O${id}`, `K${id}`, code],
  );
  await run("UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = ?", [
    `O${id}`,
  ]);
  await run(
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?, ?, ?, ?, 900000)",
    [`T${id}`, `K${id}`, code, `F${id}`],
  );
}

async function seedPendingEntry(code: string) {
  await run(
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('XP', 'AU', 'E', 'F1', 'U', 'T1', 'rv1', 'P5')`,
  );
  await run(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed) VALUES ('KP', 'XP', '2026-10-12', 600000000, 'rv1', '{}', 1, 42)`,
  );
  await run(
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES ('OP', 'KP', '2026-10-12', ?, 'buy', 'entry', 10, 'pending')`,
    [code],
  );
}

const universe = (code: string, tier = "U1") =>
  run(
    "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU', '2026-10-12', ?, 'active', ?)",
    [code, tier],
  );

const assessments = async () =>
  rows(
    "SELECT ann_id, code, materiality, held, watch, candidate, tracked, rule_version, polarity, " +
      "materiality_llm, text_llm FROM item_assessment ORDER BY code, ann_id",
  );
const byCode = async (code: string) => (await assessments()).filter((a) => a.code === code);

const go = (feed: string, o: { sha?: string; now?: string; maxItems?: number } = {}) =>
  ingestFeed({
    db,
    feed,
    sha: o.sha ?? SHA,
    now: o.now ?? NOW,
    today: TODAY,
    maxItems: o.maxItems,
  });

beforeEach(async () => {
  db = await freshDb("main");
});

describe("ingestFeed: first-seen insert and idempotency", () => {
  it("stores every item once and assesses it; a repeated body changes nothing", async () => {
    const feed = feedOf([
      { id: "1", code: "ZZAA", time: T(30) },
      { id: "2", code: "ZZBB", time: T(20) },
    ]);
    const r1 = await go(feed);
    expect(r1).toMatchObject({ ok: true, seen: 2, new: 2, assessed: 2, carried: 0 });
    const ann = await rows(
      "SELECT ann_id, ingested_at, source, market FROM announcement ORDER BY ann_id",
    );
    expect(ann).toHaveLength(2);
    expect(ann.every((a) => a.source === "asx_announcements" && a.market === "AU")).toBe(true);

    const r2 = await go(feed, { now: "2026-10-13T00:14:00.000Z" });
    expect(r2).toMatchObject({ ok: true, seen: 2, new: 0, assessed: 0, carried: 0 });
    expect(await rows("SELECT ann_id, ingested_at FROM announcement ORDER BY ann_id")).toEqual(
      ann.map((a) => ({ ann_id: a.ann_id, ingested_at: a.ingested_at })),
    ); // first-seen: ingested_at never moves
    expect(await assessments()).toHaveLength(2);
    const ing = await rows(
      "SELECT id, items_seen, items_new, assessed, carried, status FROM sentinel_ingest",
    );
    expect(ing).toEqual([
      {
        id: `si:asx_announcements:${SHA}`,
        items_seen: 2,
        items_new: 2,
        assessed: 2,
        carried: 0,
        status: "ok",
      },
    ]);
  });

  it("a later feed with some known items adds only the new ones", async () => {
    await go(feedOf([{ id: "1", code: "ZZAA", time: T(30) }]), { sha: "b".repeat(64) });
    const r = await go(
      feedOf([
        { id: "1", code: "ZZAA", time: T(30) },
        { id: "2", code: "ZZAA", time: T(5) },
      ]),
      { sha: "c".repeat(64) },
    );
    expect(r).toMatchObject({ ok: true, seen: 2, new: 1, assessed: 1, carried: 0 });
    expect(await assessments()).toHaveLength(2);
  });

  it("an unrecognised body writes nothing", async () => {
    const r = await go("<html>not a feed</html>");
    expect(r).toEqual({ ok: false, error: "unrecognised_format" });
    expect(await rows("SELECT 1 FROM announcement")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM sentinel_ingest")).toHaveLength(0);
  });

  it("writes no order, no alert and no e-mail (AGT-012)", async () => {
    await seedHeld("ZZHH");
    await run("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    await go(
      feedOf([{ id: "9", code: "ZZHH", time: T(5), price_sensitive: true, title: "Trading Halt" }]),
    );
    expect(await rows("SELECT 1 FROM alert")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM email_message")).toHaveLength(0);
    expect(await rows("SELECT status FROM arena_order WHERE id = 'OZZHH'")).toEqual([
      { status: "filled" },
    ]);
  });
});

describe("ingestFeed: held, watch, candidate, tracked", () => {
  beforeEach(async () => {
    await run("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  });

  it("classifies by membership with the flags stored", async () => {
    await seedHeld("ZZHH");
    await seedPendingEntry("ZZCC");
    await universe("ZZTT");
    await run(
      "INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) VALUES ('w1','AU','ZZWW',1,'2026-10-10T00:00:00.000Z','2026-12-01')",
    );
    await go(
      feedOf([
        { id: "h", code: "ZZHH", time: T(50), price_sensitive: true, title: "Guidance update" },
        { id: "w", code: "ZZWW", time: T(49), price_sensitive: true, title: "Update" },
        { id: "c", code: "ZZCC", time: T(48), price_sensitive: true, title: "Update" },
        { id: "t", code: "ZZTT", time: T(47), title: "Notice of meeting" },
        { id: "u", code: "ZZUU", time: T(46), price_sensitive: true, title: "Half-year results" },
      ]),
    );
    expect((await byCode("ZZHH"))[0]).toMatchObject({
      materiality: 3,
      held: 1,
      tracked: 1,
      watch: 0,
    });
    expect((await byCode("ZZWW"))[0]).toMatchObject({
      materiality: 2,
      watch: 1,
      candidate: 1,
      held: 0,
    });
    expect((await byCode("ZZCC"))[0]).toMatchObject({
      materiality: 2,
      watch: 0,
      candidate: 1,
      held: 0,
    });
    expect((await byCode("ZZTT"))[0]).toMatchObject({
      materiality: 1,
      tracked: 1,
      held: 0,
      candidate: 0,
    });
    expect((await byCode("ZZUU"))[0]).toMatchObject({
      materiality: 0,
      tracked: 0,
      held: 0,
      watch: 0,
      candidate: 0,
      rule_version: "materiality-v1",
      materiality_llm: null,
      text_llm: null,
    });
  });

  it("a signal within the watch-list window puts the code on the watch-list; an old one does not", async () => {
    const sig = (code: string, d: string) =>
      run(
        `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score,
           rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
         VALUES (?, 'AU', ?, 'F1', 'rv1', 'U', ?, 'NEUTRAL', '1', '{}', '{}', 1, 'a1', 'ref', '2026-10-12T08:00:00.000Z')`,
        [`s-${code}`, d, code],
      );
    // 25 sessions of calendar before today so the window (20) cuts at a known date
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.UTC(2026, 8, 7 + i)).toISOString().slice(0, 10);
      await run(
        "INSERT OR IGNORE INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', ?, 'session', 1, 'test')",
        [d],
      );
    }
    await sig("ZZNEW", "2026-09-30");
    await sig("ZZOLD", "2026-09-08");
    await go(
      feedOf([
        { id: "n", code: "ZZNEW", time: T(10), price_sensitive: true },
        { id: "o", code: "ZZOLD", time: T(9), price_sensitive: true },
      ]),
    );
    expect((await byCode("ZZNEW"))[0]).toMatchObject({ watch: 1, materiality: 2 });
    expect((await byCode("ZZOLD"))[0]).toMatchObject({ watch: 0, materiality: 0 });
  });

  it("controls, shadow cohorts, closed trades and a data-only market never make a code held", async () => {
    await seedHeld("ZZCT", { kind: "C1", id: "c1" });
    await seedHeld("ZZSH", { live: 0, id: "sh" });
    await seedHeld("ZZCL", { id: "cl" });
    await run("UPDATE trade SET exit_type = 'legacy', legacy = 1 WHERE id = 'Tcl'");
    await go(
      feedOf([
        { id: "1", code: "ZZCT", time: T(9), price_sensitive: true },
        { id: "2", code: "ZZSH", time: T(8), price_sensitive: true },
        { id: "3", code: "ZZCL", time: T(7), price_sensitive: true },
      ]),
    );
    for (const c of ["ZZCT", "ZZSH", "ZZCL"])
      expect((await byCode(c))[0]).toMatchObject({ held: 0, materiality: 0 });

    await seedHeld("ZZLV", { id: "lv" });
    await run("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    await go(feedOf([{ id: "4", code: "ZZLV", time: T(6), price_sensitive: true }]), {
      sha: "d".repeat(64),
    });
    expect((await byCode("ZZLV"))[0]).toMatchObject({ held: 0 });
  });
});

describe("ingestFeed: at most 40 assessments per run, the rest carried (AGT-010, PLT-075)", () => {
  const many = (n: number, offset = 0): Raw[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `m${offset + i}`,
      code: "ZZMM",
      time: T(300 - (offset + i)),
    }));

  it("assesses 40, carries the rest oldest first, and the next call drains the queue", async () => {
    await universe("ZZMM");
    const feed = feedOf(many(95));
    const r1 = await go(feed);
    expect(r1).toMatchObject({ ok: true, new: 95, assessed: 40, carried: 55 });
    expect(await assessments()).toHaveLength(40);
    // oldest first: the 40 oldest announcements are the assessed ones
    const done = await rows(
      "SELECT MAX(a.published_at) AS p FROM announcement a JOIN item_assessment s ON s.ann_id = a.ann_id",
    );
    const left = await rows(
      "SELECT MIN(a.published_at) AS p FROM announcement a WHERE NOT EXISTS (SELECT 1 FROM item_assessment s WHERE s.ann_id = a.ann_id)",
    );
    expect(String(done[0].p) < String(left[0].p)).toBe(true);
    expect(await rows("SELECT assessed, carried, status FROM sentinel_ingest")).toEqual([
      { assessed: 40, carried: 55, status: "partial" },
    ]);

    const r2 = await go(feed, { sha: "e".repeat(64) });
    expect(r2).toMatchObject({ new: 0, assessed: 40, carried: 15 });
    const r3 = await go(feed, { sha: "f".repeat(64) });
    expect(r3).toMatchObject({ new: 0, assessed: 15, carried: 0 });
    expect(await assessments()).toHaveLength(95);
  });

  it("the cap never exceeds 40 whatever the config says, and a lower cap is honoured", async () => {
    expect(MAX_ITEMS_PER_RUN).toBe(40);
    const r = await go(feedOf(many(60)), { maxItems: 1000 });
    expect(r).toMatchObject({ assessed: 40, carried: 20 });
    const r2 = await go(feedOf(many(60)), { sha: "b".repeat(64), maxItems: 5 });
    expect(r2).toMatchObject({ assessed: 5, carried: 15 });
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      const r3 = await go(feedOf(many(60)), { sha: "c".repeat(64), maxItems: bad });
      expect(r3).toMatchObject({ ok: true, assessed: expect.any(Number) });
      if (r3.ok) expect(r3.assessed).toBeLessThanOrEqual(40);
    }
  });

  it("announcements outside the carry window (backfill, old) are stored but not queued", async () => {
    await run(
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
       VALUES ('AU', 'ZZOO', 'old1', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', NULL, 0, 'Old', NULL, 'asx_announcements')`,
    );
    const r = await go(feedOf([{ id: "n1", code: "ZZAA", time: T(5) }]));
    expect(r).toMatchObject({ new: 1, assessed: 1, carried: 0 });
    expect(await rows("SELECT 1 FROM item_assessment WHERE ann_id = 'old1'")).toHaveLength(0);
  });
});
