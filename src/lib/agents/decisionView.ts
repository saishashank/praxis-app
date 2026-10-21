// DecisionView (M4 T6; docs/M4_design.md 2.3, 4.12; TST-109; DAT-001; ARN-020). The only door the
// agents use to read inputs for the decision of session D. Every query carries a bound on the
// session date (`d <= D`, `as_of <= D`) and, for rows with a publication time, on the decision
// cut-off instant (`published_at < cutoff(D)`, strict, design 2.3). A request that names a later
// date or instant throws LookAheadError before any SQL runs, so a bug fails loudly instead of
// leaking the future into a signal. The same view reads a replay snapshot, which is why the
// bounds live in the SQL and not in the caller.
//
// Untimed items are stored with a date-only `published_at` (YYYY-MM-DD, "assumed time"); a date
// string sorts before any instant of that day, so they become usable from that day's cut-off.
import type { Client } from "@libsql/client";
import { LookAheadError, priceMicro } from "@/lib/arena/marketData";
import { assertBar } from "@/lib/arena/fills";
import { localToUtc } from "@/lib/data/calendar";

export { LookAheadError };

type Reader = Pick<Client, "execute">;

/** Exchange time zone of the AU market profile (PLT-023). */
export const AU_TIME_ZONE = "Australia/Melbourne";

/** The cut-off instant of session D as ISO-8601 UTC text (ms), from the "HH:MM" local config. */
export function decisionCutoffUtc(d: string, hhmm: string, tz: string = AU_TIME_ZONE): string {
  return localToUtc(d, hhmm, tz).toISOString();
}

/** A raw session bar in integer micro prices; volume in shares. */
export type ViewBar = {
  readonly d: string;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
};

export type IndexViewBar = { readonly d: string; readonly close: bigint };

export type AnnouncementRow = {
  readonly id: number;
  readonly market: string;
  readonly code: string;
  readonly source: string;
  readonly ann_id: string;
  readonly published_at: string;
  readonly type: string | null;
  readonly title: string;
  readonly price_sensitive: 0 | 1;
};

export type ShortInterestPoint = {
  readonly as_of: string;
  readonly short_ppm: number;
  readonly published_at: string;
};

export type NoticeRow = {
  readonly ann_id: string;
  readonly kind: string;
  readonly value_micro: bigint | null;
  readonly published_at: string;
};

export type PriorRegime = {
  readonly d: string;
  readonly state: string;
  readonly exit_streak: number;
};

export type DecisionViewOptions = {
  readonly market: string;
  /** The session being decided (the guard date). */
  readonly d: string;
  /** cut-off(D) as ISO UTC text; see decisionCutoffUtc. */
  readonly cutoff: string;
  /**
   * Live runs: a bar ingested after the cut-off is not used for D (catch-up bars, design 2.3).
   * Replays read backfilled rows whose ingested_at is later by construction, so they leave it off.
   */
  readonly liveIngestBound?: boolean;
};

export type DecisionView = {
  readonly market: string;
  readonly guardD: string;
  readonly cutoff: string;
  checkDate(d: string): void;
  checkInstant(iso: string): void;
  /** The last `count` raw bars of `code` with d <= upTo (default D), oldest first. */
  bars(code: string, count: number, upTo?: string): Promise<ViewBar[]>;
  /** The last `count` index closes with d <= upTo (default D), oldest first. */
  indexBars(indexCode: string, count: number, upTo?: string): Promise<IndexViewBar[]>;
  /** Announcements published before the cut-off (and at or after `sinceIso`), id order. */
  announcements(opts?: {
    codes?: readonly string[];
    sinceIso?: string;
  }): Promise<AnnouncementRow[]>;
  /** `${source}|${ann_id}` of the event rows already recorded (published before the cut-off). */
  recordedEventKeys(): Promise<Set<string>>;
  /** Short-interest points usable at the cut-off (as_of <= D, published before it), newest first. */
  shortInterest(code: string, limit: number): Promise<ShortInterestPoint[]>;
  /** Insider / substantial-holder notices published in [sinceIso, cut-off), oldest first. */
  insiderNotices(code: string, sinceIso: string): Promise<NoticeRow[]>;
  /** True when at least one notice (any code) was published before the cut-off: the source ran. */
  insiderCoverage(): Promise<boolean>;
  /** The latest regime_daily row strictly before D for this rule version. */
  priorRegime(version: number): Promise<PriorRegime | null>;
  /** The latest indicator_daily row for the code with d <= D (stored state, design 4.2). */
  indicatorRow(code: string, indVersion: number): Promise<Record<string, unknown> | null>;
};

function bigintCol(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("expected an integer column value");
}

export function createDecisionView(db: Reader, opts: DecisionViewOptions): DecisionView {
  const { market, d: guardD, cutoff } = opts;
  const checkDate = (d: string): void => {
    if (typeof d !== "string" || d.length === 0)
      throw new TypeError("date must be a non-empty string");
    if (d > guardD) throw new LookAheadError(d, guardD);
  };
  const checkInstant = (iso: string): void => {
    if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) {
      throw new TypeError("instant must be ISO-8601 text");
    }
    if (iso >= cutoff) throw new LookAheadError(iso, `cut-off ${cutoff}`);
  };
  const ingestClause = opts.liveIngestBound === true ? " AND ingested_at <= ?" : "";

  return {
    market,
    guardD,
    cutoff,
    checkDate,
    checkInstant,
    async bars(code, count, upTo = guardD) {
      checkDate(upTo);
      const args: (string | number)[] = [market, code, upTo, guardD];
      if (opts.liveIngestBound === true) args.push(cutoff);
      args.push(count);
      const rs = await db.execute({
        sql: `SELECT d, o, h, l, c, volume FROM price_bar
              WHERE market = ? AND code = ? AND d <= ? AND d <= ?${ingestClause}
              ORDER BY d DESC LIMIT ?`,
        args,
      });
      const out: ViewBar[] = [];
      for (const r of rs.rows) {
        const bar: ViewBar = {
          d: String(r.d),
          open: priceMicro(r.o),
          high: priceMicro(r.h),
          low: priceMicro(r.l),
          close: priceMicro(r.c),
          volume: bigintCol(r.volume),
        };
        try {
          assertBar({
            openMicro: bar.open,
            highMicro: bar.high,
            lowMicro: bar.low,
            closeMicro: bar.close,
          });
          out.push(bar);
        } catch {
          // a malformed bar is unusable evidence (DAT-200 flags it)
        }
      }
      return out.reverse();
    },
    async indexBars(indexCode, count, upTo = guardD) {
      checkDate(upTo);
      const rs = await db.execute({
        sql: `SELECT d, c_micro FROM index_bar
              WHERE market = ? AND index_code = ? AND d <= ? AND d <= ? AND published_at < ?
              ORDER BY d DESC LIMIT ?`,
        args: [market, indexCode, upTo, guardD, cutoff, count],
      });
      return rs.rows.map((r) => ({ d: String(r.d), close: bigintCol(r.c_micro) })).reverse();
    },
    async announcements(q = {}) {
      if (q.sinceIso !== undefined && q.sinceIso >= cutoff) {
        throw new LookAheadError(q.sinceIso, `cut-off ${cutoff}`);
      }
      const where = ["market = ?", "published_at < ?"];
      const args: (string | number)[] = [market, cutoff];
      if (q.sinceIso !== undefined) {
        where.push("published_at >= ?");
        args.push(q.sinceIso);
      }
      if (q.codes !== undefined) {
        if (q.codes.length === 0) return [];
        where.push(`code IN (${q.codes.map(() => "?").join(", ")})`);
        args.push(...q.codes);
      }
      const rs = await db.execute({
        sql: `SELECT id, market, code, source, ann_id, published_at, type, title, price_sensitive
              FROM announcement WHERE ${where.join(" AND ")} ORDER BY id`,
        args,
      });
      return rs.rows.map((r) => ({
        id: Number(r.id),
        market: String(r.market),
        code: String(r.code),
        source: String(r.source),
        ann_id: String(r.ann_id),
        published_at: String(r.published_at),
        type: r.type === null ? null : String(r.type),
        title: String(r.title),
        price_sensitive: Number(r.price_sensitive) === 1 ? 1 : 0,
      }));
    },
    async recordedEventKeys() {
      const rs = await db.execute({
        sql: `SELECT source, ann_id FROM event WHERE market = ? AND published_at < ? AND day0_d <= ?`,
        args: [market, cutoff, guardD],
      });
      return new Set(rs.rows.map((r) => `${String(r.source)}|${String(r.ann_id)}`));
    },
    async shortInterest(code, limit) {
      const rs = await db.execute({
        sql: `SELECT as_of, short_ppm, published_at FROM short_interest
              WHERE market = ? AND code = ? AND as_of <= ? AND published_at < ?
              ORDER BY as_of DESC LIMIT ?`,
        args: [market, code, guardD, cutoff, limit],
      });
      return rs.rows.map((r) => ({
        as_of: String(r.as_of),
        short_ppm: Number(r.short_ppm),
        published_at: String(r.published_at),
      }));
    },
    async insiderNotices(code, sinceIso) {
      if (sinceIso >= cutoff) throw new LookAheadError(sinceIso, `cut-off ${cutoff}`);
      const rs = await db.execute({
        sql: `SELECT ann_id, kind, value_micro, published_at FROM insider_notice
              WHERE market = ? AND code = ? AND published_at >= ? AND published_at < ?
              ORDER BY published_at, ann_id`,
        args: [market, code, sinceIso, cutoff],
      });
      return rs.rows.map((r) => ({
        ann_id: String(r.ann_id),
        kind: String(r.kind),
        value_micro: r.value_micro === null ? null : bigintCol(r.value_micro),
        published_at: String(r.published_at),
      }));
    },
    async insiderCoverage() {
      const rs = await db.execute({
        sql: `SELECT 1 FROM insider_notice WHERE market = ? AND published_at < ? LIMIT 1`,
        args: [market, cutoff],
      });
      return rs.rows.length > 0;
    },
    async priorRegime(version) {
      const rs = await db.execute({
        sql: `SELECT d, state, exit_streak FROM regime_daily
              WHERE market = ? AND version = ? AND d < ? AND d <= ?
              ORDER BY d DESC LIMIT 1`,
        args: [market, version, guardD, guardD],
      });
      if (rs.rows.length === 0) return null;
      const r = rs.rows[0];
      return { d: String(r.d), state: String(r.state), exit_streak: Number(r.exit_streak) };
    },
    async indicatorRow(code, indVersion) {
      const rs = await db.execute({
        sql: `SELECT * FROM indicator_daily
              WHERE market = ? AND code = ? AND ind_version = ? AND d <= ?
              ORDER BY d DESC LIMIT 1`,
        args: [market, code, indVersion, guardD],
      });
      return rs.rows.length === 0 ? null : { ...rs.rows[0] };
    },
  };
}
