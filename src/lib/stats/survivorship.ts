// Survivorship and delisting sensitivity (M4 design 4.8 item 9; ARN-082, DAT-125). Pure.
//
// Missing share per calendar year = codes on the DAT-125 list (>= `survivorshipMinAnnouncements`
// announcements in the previous `survivorshipWindowSessions` sessions, evaluated at any session of that
// year) with no price history in the source, divided by all such codes. A year whose share is above
// `survivorshipFlagShare` is "survivorship-exposed"; years before the announcement backfill are
// "survivorship unknown (exposed)".
import type { StatsParams } from "../agents/params";
import { cmpRat, makeRational, type Rational } from "../money/rational";

export type Announcement = { readonly code: string; readonly d: string };

export type SurvivorshipYear = {
  readonly year: number;
  readonly status: "measured" | "unknown";
  readonly listed: number;
  readonly missing: number;
  /** missing / listed, exact; null when unknown or nothing listed. */
  readonly share: Rational | null;
  readonly exposed: boolean;
};

/** First index i with calendar[i] >= d (calendar ascending), or calendar.length. */
function firstSessionOnOrAfter(calendar: readonly string[], d: string): number {
  let lo = 0;
  let hi = calendar.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const yearOf = (d: string): number => Number(d.slice(0, 4));

/** The DAT-125 list per calendar year: year -> set of codes. */
export function announcementListByYear(
  announcements: readonly Announcement[],
  calendar: readonly string[],
  params: Pick<StatsParams, "survivorshipMinAnnouncements" | "survivorshipWindowSessions">,
): Map<number, Set<string>> {
  const k = params.survivorshipMinAnnouncements;
  const W = params.survivorshipWindowSessions;
  const byCode = new Map<string, number[]>();
  for (const a of announcements) {
    const idx = firstSessionOnOrAfter(calendar, a.d);
    if (idx >= calendar.length) continue;
    const list = byCode.get(a.code);
    if (list === undefined) byCode.set(a.code, [idx]);
    else list.push(idx);
  }
  const out = new Map<number, Set<string>>();
  for (const code of [...byCode.keys()].sort()) {
    const idx = byCode.get(code)!.sort((a, b) => a - b);
    for (let i = 0; i + k - 1 < idx.length; i += 1) {
      const first = idx[i]!;
      const last = idx[i + k - 1]!;
      if (last - first > W - 1) continue;
      // A session s counts the announcements in [s - W, s - 1]; both ends fit iff s in [last + 1, first + W].
      const lo = last + 1;
      const hi = Math.min(first + W, calendar.length - 1);
      for (let s = lo; s <= hi; s += 1) {
        const y = yearOf(calendar[s]!);
        const set = out.get(y);
        if (set === undefined) out.set(y, new Set([code]));
        else set.add(code);
      }
    }
  }
  return out;
}

export type SurvivorshipInput = {
  readonly announcements: readonly Announcement[];
  readonly calendar: readonly string[];
  /** Codes with price history in the source. */
  readonly hasPrice: ReadonlySet<string>;
  readonly params: StatsParams;
  /** First date announcement history exists; earlier calendar years are "unknown (exposed)". */
  readonly announcementBackfillStartD?: string | null;
};

export function survivorshipSeries(input: SurvivorshipInput): SurvivorshipYear[] {
  const { calendar, params } = input;
  const list = announcementListByYear(input.announcements, calendar, params);
  const years = [...new Set(calendar.map(yearOf))].sort((a, b) => a - b);
  const backfillYear =
    input.announcementBackfillStartD === undefined || input.announcementBackfillStartD === null
      ? null
      : yearOf(input.announcementBackfillStartD);
  return years.map((year): SurvivorshipYear => {
    if (backfillYear !== null && year < backfillYear) {
      return { year, status: "unknown", listed: 0, missing: 0, share: null, exposed: true };
    }
    const codes = [...(list.get(year) ?? [])].sort();
    const missing = codes.filter((c) => !input.hasPrice.has(c)).length;
    if (codes.length === 0) {
      return { year, status: "measured", listed: 0, missing: 0, share: null, exposed: false };
    }
    const share = makeRational(BigInt(missing), BigInt(codes.length));
    return {
      year,
      status: "measured",
      listed: codes.length,
      missing,
      share,
      exposed: cmpRat(share, params.survivorshipFlagShare) > 0,
    };
  });
}

export type Partition<T> = {
  readonly all: readonly T[];
  readonly exposed: readonly T[];
  readonly withoutExposed: readonly T[];
  /** Share of rows in exposed years, exact; null when there are no rows. */
  readonly exposedShare: Rational | null;
};

/** Results with and without the exposed years (rows keyed by entry-date year). */
export function partitionByExposure<T extends { readonly entryD: string }>(
  rows: readonly T[],
  series: readonly SurvivorshipYear[],
): Partition<T> {
  const exposedYears = new Set(series.filter((s) => s.exposed).map((s) => s.year));
  const exposed = rows.filter((r) => exposedYears.has(yearOf(r.entryD)));
  const withoutExposed = rows.filter((r) => !exposedYears.has(yearOf(r.entryD)));
  return {
    all: rows,
    exposed,
    withoutExposed,
    exposedShare:
      rows.length === 0 ? null : makeRational(BigInt(exposed.length), BigInt(rows.length)),
  };
}

// ---- delisting sensitivity ----

export type DelistRow = {
  readonly id: string;
  readonly code: string;
  readonly entryD: string;
  readonly exitD: string;
  readonly net: number;
  /** Net return had the row exited at the code's last traded price; null when the caller cannot score it. */
  readonly lastTradedNet?: number | null;
};

export type DelistingSensitivity = {
  readonly n: number;
  /** Rows in codes delisted within their hold (entry <= delisting date <= exit). */
  readonly affected: number;
  /** Affected rows without a last-traded score (left unchanged in the last-price scenario). */
  readonly unscorable: number;
  readonly baseMean: number | null;
  readonly lastPriceMean: number | null;
  /** Affected rows re-scored at -100 %. */
  readonly wipeoutMean: number | null;
  readonly limitation: string;
};

export const DELISTING_LIMITATION =
  "Rows are re-scored only for codes the price source still holds; codes absent from the source never entered the ledger, so the true effect is larger than shown.";

function meanOrNull(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Re-score rows in codes delisted within their hold at the last traded price, or at -100 %. */
export function delistingSensitivity(
  rows: readonly DelistRow[],
  delisted: ReadonlyMap<string, string>,
): DelistingSensitivity {
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const base: number[] = [];
  const last: number[] = [];
  const wipe: number[] = [];
  let affected = 0;
  let unscorable = 0;
  for (const r of ordered) {
    const dl = delisted.get(r.code);
    const hit = dl !== undefined && dl >= r.entryD && dl <= r.exitD;
    base.push(r.net);
    if (!hit) {
      last.push(r.net);
      wipe.push(r.net);
      continue;
    }
    affected += 1;
    wipe.push(-1);
    if (r.lastTradedNet === undefined || r.lastTradedNet === null) {
      unscorable += 1;
      last.push(r.net);
    } else last.push(r.lastTradedNet);
  }
  return {
    n: ordered.length,
    affected,
    unscorable,
    baseMean: meanOrNull(base),
    lastPriceMean: meanOrNull(last),
    wipeoutMean: meanOrNull(wipe),
    limitation: DELISTING_LIMITATION,
  };
}

// ---- code reuse (flag only in M4) ----

export type CodeSpan = {
  readonly code: string;
  readonly name: string;
  readonly firstIdx: number;
  readonly lastIdx: number;
};

export type CodeReuseFlag = {
  readonly code: string;
  readonly gapSessions: number;
  readonly fromName: string;
  readonly toName: string;
};

/**
 * Flag a code whose history has a gap of at least `minGapSessions` followed by a different instrument
 * name (design 4.8 item 9). `minGapSessions` is supplied by the caller (it is not yet a registry key).
 */
export function detectCodeReuse(
  spans: readonly CodeSpan[],
  minGapSessions: number,
): CodeReuseFlag[] {
  const byCode = new Map<string, CodeSpan[]>();
  for (const s of spans) {
    const list = byCode.get(s.code);
    if (list === undefined) byCode.set(s.code, [s]);
    else list.push(s);
  }
  const out: CodeReuseFlag[] = [];
  for (const code of [...byCode.keys()].sort()) {
    const list = byCode.get(code)!.sort((a, b) => a.firstIdx - b.firstIdx);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const gap = cur.firstIdx - prev.lastIdx;
      if (gap >= minGapSessions && cur.name !== prev.name) {
        out.push({ code, gapSessions: gap, fromName: prev.name, toName: cur.name });
      }
    }
  }
  return out;
}
