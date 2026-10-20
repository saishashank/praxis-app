// Reviews loaders: the list and one Evening Review (UX-080, UXN-113, UXN-206, EML-010/036; docs/M7_design.md
// 3 row 21; D-136 draft). Stored reviews only. The Owner and unmasked users get the stored HTML; a masked
// user gets the view model of `@/lib/view/reviews` built from the stored facts (never the HTML), with the
// same last-line leak check the page uses. "Mark as read" is Owner-only (`canMarkRead`).
import { listVersions, loadReview, readState } from "@/lib/review/assemble";
import { activeCodesForDate } from "@/lib/view/active";
import { loadMaskLookup, StockAliases } from "@/lib/view/mask";
import {
  factCodes,
  maskedReview,
  parseFacts,
  reviewLeaks,
  type MaskedReview,
} from "@/lib/view/reviews";
import { dateStaleness } from "@/lib/view/staleness";
import {
  intParam,
  isDateParam,
  marketOf,
  textParam,
  todayD,
  type LoaderEnv,
  type LoaderState,
} from "./shell";

const LIST_ROWS = 30; // threshold-ok: one page of the review list
const STALE_DAYS = 4; // threshold-ok: evening reviews; a long weekend is 3 days
const KIND_TEXT: Record<string, string> = {
  full: "Complete",
  partial: "Partial",
  minimal: "Minimal",
  non_trading: "Non-trading day",
};

export type ReviewsQuery = { q?: string; page: number };

/** `?q=&page=`: q is a date prefix or kind word; null when a value is not allowed. */
export function parseReviewsQuery(sp: URLSearchParams): ReviewsQuery | null {
  const q = textParam(sp.get("q"), 20);
  const page = intParam(sp.get("page"), 1, 1000);
  if (q === null || page === null) return null;
  if (q !== undefined && !/^[A-Za-z0-9 _-]+$/.test(q)) return null;
  return { q, page };
}

export type ReviewListRow = {
  d: string;
  version: number;
  kind: string;
  kindText: string;
  narrative: string;
  read: boolean;
};
export type ReviewListModel = {
  state: LoaderState;
  masked: boolean;
  staleText: string | null;
  /** Today's review is expected but not stored yet. */
  pending: boolean;
  rows: ReviewListRow[];
  page: number;
  hasMore: boolean;
};

export async function loadReviewList(env: LoaderEnv, q: ReviewsQuery): Promise<ReviewListModel> {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (q.q !== undefined) {
    where.push("(e.d LIKE ? ESCAPE '\\' OR e.kind LIKE ? ESCAPE '\\')");
    const like = `${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  args.push(LIST_ROWS + 1, (q.page - 1) * LIST_ROWS);
  const r = await env.main.execute({
    sql: `SELECT e.d, e.version, e.kind, e.narrative, rr.read_at
          FROM evening_review e
          LEFT JOIN review_read rr ON rr.d = e.d
          WHERE e.version = (SELECT MAX(v.version) FROM evening_review v WHERE v.d = e.d)
          ${where.length ? `AND ${where.join(" AND ")}` : ""}
          ORDER BY e.d DESC LIMIT ? OFFSET ?`,
    args,
  });
  const rows: ReviewListRow[] = r.rows.slice(0, LIST_ROWS).map((x) => ({
    d: String(x.d),
    version: Number(x.version), // money-float-ok: SQL integer column
    kind: String(x.kind),
    kindText: KIND_TEXT[String(x.kind)] ?? String(x.kind),
    narrative: String(x.narrative),
    read: x.read_at !== null,
  }));
  const newest = rows[0]?.d ?? null;
  const stale = dateStaleness(newest, todayD(env), STALE_DAYS);
  return {
    state: rows.length === 0 ? "empty" : stale.state === "stale" ? "stale" : "ok",
    masked: env.mask.masked,
    staleText: stale.state === "stale" ? stale.text : null,
    pending: newest !== todayD(env),
    rows,
    page: q.page,
    hasMore: r.rows.length > LIST_ROWS,
  };
}

export type ReviewModel = {
  masked: boolean;
  d: string;
  version: number;
  versions: Array<{ version: number; kindText: string }>;
  kindText: string;
  createdAt: string;
  narrative: string;
  read: { readAt: string; via: string } | null;
  canMarkRead: boolean;
  /** Stored HTML: only for the Owner and unmasked users. */
  html: string | null;
  /** The masked view; null for an unmasked user, and also null when it failed the leak check. */
  maskedView: MaskedReview | null;
  /** True when a masked user's view could not be built safely. */
  unavailable: boolean;
};

/** `d` is a date, `version` optional; null when no review is stored. */
export async function loadReviewPage(
  env: LoaderEnv,
  d: string,
  version?: number,
): Promise<ReviewModel | null> {
  if (!isDateParam(d)) return null;
  const versions = await listVersions(env.main, d);
  if (versions.length === 0) return null;
  const review = await loadReview(env.main, d, version);
  if (review === null) return null;
  const read = await readState(env.main, d);
  const masked = env.mask.masked;
  let view: MaskedReview | null = null;
  if (masked) {
    const row = await env.main.execute({
      sql: "SELECT facts_json FROM evening_review WHERE d = ? AND version = ?",
      args: [d, review.version],
    });
    const facts = row.rows.length ? parseFacts(String(row.rows[0]!.facts_json)) : null;
    if (facts !== null) {
      const market = marketOf(env);
      const active = await activeCodesForDate(env.main, market, d);
      const aliases = new StockAliases([...active, ...factCodes(facts)]);
      const lookup = await loadMaskLookup(env.main, market);
      const built = maskedReview(facts, aliases, lookup);
      const names = aliases.codes().map((c) => lookup.names.get(c) ?? "");
      view = reviewLeaks(built, aliases.codes(), names) ? null : built;
    }
  }
  return {
    masked,
    d,
    version: review.version,
    versions: versions.map((v) => ({ version: v.version, kindText: KIND_TEXT[v.kind] ?? v.kind })),
    kindText: KIND_TEXT[review.kind] ?? review.kind,
    createdAt: review.createdAt,
    narrative: review.narrative,
    read,
    canMarkRead: env.user.role === "owner",
    html: masked ? null : review.html,
    maskedView: view,
    unavailable: masked && view === null,
  };
}
