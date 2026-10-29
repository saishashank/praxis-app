// Sentinel ingest (M5 T5; AGT-010, AGT-011, AGT-014, AGT-015, PLT-012, PLT-075; docs/M5_design.md
// 4.2, decision 36; D-100 draft). Called by the signed route with a feed body the Worker already
// hashed. Steps, in this order:
//   1. parse with the active `FeedParser` (the format is TODO(fixtures) [VERIFY]);
//   2. first-seen insert of every item into `announcement` (ON CONFLICT DO NOTHING, so a repeated
//      body or a repeated item changes nothing and `items_new` counts only the rows really added);
//      (M14 DAT-237) each row carries `content_hash`; an item whose hash an earlier row of the same
//      code already holds is an exact repeat and is assessed at materiality 0: no alert, no breaker;
//   3. take at most `maxItems` (<= 40, `sentinel_max_items_per_run`) UNASSESSED announcements of
//      the carry window, OLDEST FIRST, so nothing starves; the `announcement` table is the queue,
//      the rest are "carried" and are picked up by the next call (or by alert-flush, T6);
//   4. classify them (membership sets read once, rule materiality, polarity) and write the
//      `item_assessment` rows and the `sentinel_ingest` row in ONE write batch.
//   5. (M5 T7) the event thesis-breakers of held / pending positions on those codes: intraday rows
//      and a sink call for a red one (`breakers.ts`).
// No order is written here (AGT-012: the Sentinel never changes orders); the alert and e-mail path
// is T6. Nothing the feed says reaches a log or a response body.
import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { normaliseTitle } from "@/lib/agents/announcementDedup";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { ACTIVE_FEED_PARSER, type FeedItem, type FeedParser } from "./feed";
import { assess, MATERIALITY_RULE_VERSION } from "./materiality";
import type { BreakerAlertSink } from "@/lib/agents/breakerEval";
import { loadAgentParams } from "@/lib/agents/params";
import { evaluateIntraday, type IntradayAnnouncement } from "./breakers";
import { loadMembership, membershipOf } from "./membership";

export const MAX_ITEMS_PER_RUN = 40; // AGT-010, PLT-075: a hard ceiling whatever the config says
/** Only announcements first seen and published within this window are assessed (not the backfill). */
export const CARRY_WINDOW_H = 48;
const ROWS_PER_STATEMENT = 50;
const HOUR_MS = 3_600_000;

export type IngestInput = {
  db: Client;
  /** Raw feed body. */
  feed: string;
  /** SHA-256 of `feed`, already verified by the caller. */
  sha: string;
  /** ISO-8601 UTC ms. */
  now: string;
  /** Sydney date of `now`. */
  today: string;
  maxItems?: number;
  market?: string;
  parser?: FeedParser;
  /** Receives a red intraday thesis-breaker (M5 T7); default: writes the alert row. */
  breakerSink?: BreakerAlertSink;
};

export type IngestResult =
  | { ok: true; seen: number; skipped: number; new: number; assessed: number; carried: number }
  | { ok: false; error: "unrecognised_format" | "unavailable" };

const clampItems = (n: number | undefined): number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1
    ? Math.min(n, MAX_ITEMS_PER_RUN)
    : MAX_ITEMS_PER_RUN;

/** DAT-237 (D-240): sha256(market | code | normalised title | published date), lower-case hex. */
export function announcementContentHash(
  market: string,
  code: string,
  title: string,
  publishedAt: string,
): string {
  return createHash("sha256")
    .update([market, code, normaliseTitle(title), publishedAt.slice(0, 10)].join("|"), "utf8")
    .digest("hex");
}

function insertAnnouncements(
  items: readonly FeedItem[],
  market: string,
  now: string,
): InStatement[] {
  const stmts: InStatement[] = [];
  for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) {
    const slice = items.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql:
        "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, " +
        // GL-05: first_ingested_at = the instant this system first stored the row (live: now)
        `price_sensitive, title, url, source, first_ingested_at, content_hash) VALUES ${slice.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")} ` +
        "ON CONFLICT DO NOTHING",
      args: slice.flatMap((r) => [
        market,
        r.code,
        r.annId,
        r.publishedAt,
        now,
        r.type,
        r.priceSensitive ? 1 : 0,
        r.title,
        r.url,
        ASX_SOURCE,
        now,
        announcementContentHash(market, r.code, r.title, r.publishedAt),
      ]),
    });
  }
  return stmts;
}

export async function ingestFeed(i: IngestInput): Promise<IngestResult> {
  const market = i.market ?? "AU";
  const max = clampItems(i.maxItems);
  const parsed = (i.parser ?? ACTIVE_FEED_PARSER).parse(i.feed);
  if (parsed === null) return { ok: false, error: "unrecognised_format" };
  try {
    // 2. first-seen insert
    let added = 0;
    const inserts = insertAnnouncements(parsed.items, market, i.now);
    if (inserts.length > 0) {
      const res = await i.db.batch(inserts, "write");
      added = res.reduce((n, r) => n + r.rowsAffected, 0);
    }

    // 3. the queue: unassessed announcements of the carry window, oldest first
    const since = new Date(Date.parse(i.now) - CARRY_WINDOW_H * HOUR_MS).toISOString();
    const where =
      "FROM announcement a WHERE a.source = ? AND a.market = ? AND a.ingested_at >= ? " +
      "AND a.published_at >= ? AND NOT EXISTS (SELECT 1 FROM item_assessment s " +
      "WHERE s.source = a.source AND s.ann_id = a.ann_id)";
    const qargs = [ASX_SOURCE, market, since, since];
    const [queue, count] = await i.db.batch(
      [
        {
          sql:
            "SELECT a.ann_id AS ann_id, a.code AS code, a.type AS type, a.published_at AS published_at, " +
            "a.price_sensitive AS price_sensitive, a.title AS title, " +
            "(a.content_hash IS NOT NULL AND EXISTS (SELECT 1 FROM announcement b WHERE b.market = a.market " +
            "AND b.code = a.code AND b.content_hash = a.content_hash AND b.id < a.id)) AS dup " +
            `${where} ORDER BY a.published_at ASC, a.id ASC LIMIT ?`,
          args: [...qargs, max],
        },
        { sql: `SELECT COUNT(*) AS n ${where}`, args: qargs },
      ],
      "read",
    );
    const waiting = Number(count.rows[0]?.n ?? 0);

    // 4. classify and write, one batch
    const sets = await loadMembership(i.db, market, i.today);
    const stmts: InStatement[] = [];
    const affected: IntradayAnnouncement[] = [];
    for (const r of queue.rows) {
      const code = String(r.code);
      const m = membershipOf(code, sets);
      const dup = Number(r.dup) === 1;
      const assessed1 = assess(
        {
          type: r.type === null ? null : String(r.type),
          title: String(r.title),
          priceSensitive: Number(r.price_sensitive) === 1,
        },
        m,
      );
      // An exact repeat is stored and marked assessed, but never alerts (materiality 0, polarity 0).
      const a = dup ? { ...assessed1, materiality: 0 as const, polarity: 0 as const } : assessed1;
      if (!dup && (m.held || m.candidate)) {
        affected.push({
          annId: String(r.ann_id),
          code,
          type: r.type === null ? null : String(r.type),
          title: String(r.title),
          priceSensitive: Number(r.price_sensitive) === 1,
          publishedAt: String(r.published_at),
        });
      }
      stmts.push({
        sql:
          "INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, " +
          "polarity, held, watch, candidate, tracked, assessed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT DO NOTHING",
        args: [
          ASX_SOURCE,
          String(r.ann_id),
          market,
          code,
          a.materiality,
          MATERIALITY_RULE_VERSION,
          a.polarity,
          m.held ? 1 : 0,
          m.watch ? 1 : 0,
          m.candidate ? 1 : 0,
          m.tracked ? 1 : 0,
          i.now,
        ],
      });
    }
    const assessed = queue.rows.length;
    const carried = Math.max(0, waiting - assessed);
    // The ingest row's CHECKs bound its counts by items_new; the response carries the true figures.
    stmts.push({
      sql:
        "INSERT INTO sentinel_ingest (id, received_at, items_seen, items_new, assessed, carried, status, attempt) " +
        "VALUES (?,?,?,?,?,?,?,1) ON CONFLICT DO NOTHING",
      args: [
        `si:${ASX_SOURCE}:${i.sha}`,
        i.now,
        parsed.items.length,
        added,
        Math.min(assessed, added),
        Math.min(carried, added),
        carried === 0 ? "ok" : "partial",
      ],
    });
    await i.db.batch(stmts, "write");
    // Event breakers of the held / pending positions (M5 T7). A failure here never fails the ingest:
    // the nightly cycle evaluates the same announcements again from the event rows.
    if (affected.length > 0) {
      try {
        await evaluateIntraday({
          db: i.db,
          market,
          today: i.today,
          now: i.now,
          params: await loadAgentParams(i.db),
          announcements: affected,
          sink: i.breakerSink,
        });
      } catch {
        // swallowed on purpose
      }
    }
    return {
      ok: true,
      seen: parsed.items.length,
      skipped: parsed.skipped,
      new: added,
      assessed,
      carried,
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
