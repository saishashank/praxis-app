// News loaders: the news list and the one-item pop-up (UX-060..062, UXN-035, UXN-038; docs/M7_design.md
// 3 rows 17, 18; D-136 draft). Stored announcements and our assessment only.
// Masking (DAT-124, UX-009): a masked user sees only items about stocks of the item's own Melbourne
// date's active set, as "Stock A", with a masked headline, the ISO week, no company name and no link.
// A search term and a code filter are ignored for them (they would reveal which codes exist).
import { displayName, isoWeek, MISSING } from "@/lib/view/format";
import { starredCodes } from "./market";

/** "CESSATION OF SECURITIES" -> "Cessation of securities"; text that is not all capitals is kept. */
export function sentenceCase(s: string): string {
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
import { safeSourceUrl } from "@/lib/http/safeLink";
import { activeCodesByDate, melbourneDate } from "@/lib/view/active";
import { maskText, normCode } from "@/lib/view/mask";
import {
  intParam,
  isDateParam,
  marketOf,
  maskKit,
  maskKitByDate,
  textParam,
  todayD,
  type LoaderEnv,
  type LoaderState,
} from "./shell";
import { displayText, displayTitle } from "@/lib/view/displayText";

const SUMMARY_WITHHELD = "Summary withheld — see source announcements";

const LIST_ROWS = 50; // threshold-ok: one page of the news list
const STAR_CAP = 200; // threshold-ok: starred codes added to the important filter
const SCAN_ROWS = 200; // threshold-ok: rows read before the masked filter
const CHIPS = ["mine", "all", "alerts"] as const;
export type NewsChip = (typeof CHIPS)[number];
const CODE_RE = /^[A-Za-z0-9]{1,8}$/;

export type NewsQuery = {
  chip: NewsChip;
  q?: string;
  code?: string;
  from?: string;
  to?: string;
  page: number;
  /** `?show=all`: every announcement; the default shows only the important ones (chip "all"). */
  show?: "all";
  /** Keyset cursors "<published_at>|<id>" (D-959, no OFFSET): after the oldest item shown, or before the newest. */
  after?: string;
  before?: string;
};

const CURSOR_RE = /^[0-9T:.+ Z-]{10,40}\|[0-9]{1,12}$/;
const splitCursor = (c: string): [string, number] => {
  const i = c.lastIndexOf("|");
  return [c.slice(0, i), Number(c.slice(i + 1))]; // money-float-ok: SQL integer key
};

/** `?chip=&q=&code=&from=&to=&page=&after=&before=`: null when a value is not allowed. */
export function parseNewsQuery(sp: URLSearchParams): NewsQuery | null {
  const chip = sp.get("chip") ?? "all"; // Owner 2026-10-27: All news first
  if (!(CHIPS as readonly string[]).includes(chip)) return null;
  const q = textParam(sp.get("q"), 60);
  const code = textParam(sp.get("code"), 8);
  const page = intParam(sp.get("page"), 1, 1000);
  if (q === null || code === null || page === null) return null;
  if (code !== undefined && !CODE_RE.test(code)) return null;
  const from = sp.get("from") || undefined;
  const to = sp.get("to") || undefined;
  if ((from !== undefined && !isDateParam(from)) || (to !== undefined && !isDateParam(to))) {
    return null;
  }
  if (from !== undefined && to !== undefined && from > to) return null;
  const show = sp.get("show");
  if (show !== null && show !== "" && show !== "important" && show !== "all") return null;
  const after = sp.get("after") || undefined;
  const before = sp.get("before") || undefined;
  for (const c of [after, before]) if (c !== undefined && !CURSOR_RE.test(c)) return null;
  if (after !== undefined && before !== undefined) return null;
  const out: NewsQuery = { chip: chip as NewsChip, q, code, from, to, page };
  if (after !== undefined) out.after = after;
  if (before !== undefined) out.before = before;
  if (show === "all") out.show = "all";
  return out;
}

export type NewsItemRow = {
  id: number;
  stock: string;
  /** Company name (null when masked or unknown). */
  company: string | null;
  title: string;
  /** Exchange announcement type, for example "Quarterly" (null when masked or unknown). */
  type: string | null;
  /** Our short text when a summary exists (masked like the title); otherwise null. */
  summary: string | null;
  published: string;
  priceSensitive: boolean;
  materiality: number | null;
  /** -1 bad news for the stock, 0 neutral, 1 good; null = not assessed. */
  polarity: -1 | 0 | 1 | null;
  heldByUs: boolean;
};
export type NewsModel = {
  state: LoaderState;
  masked: boolean;
  chip: NewsChip;
  items: NewsItemRow[];
  page: number;
  /** Older items exist. */
  hasMore: boolean;
  /** Newer items exist. */
  hasNewer: boolean;
  /** Cursors for the two links (null for a masked list, which pages in memory, and at either end). */
  olderAfter: string | null;
  newerBefore: string | null;
  note: string | null;
  /** True when the list is limited to important announcements (the default of the "All news" chip). */
  importantOnly: boolean;
};

const ROW_SQL = `SELECT a.id, a.code, a.title, a.type, a.published_at, a.price_sensitive,
                        i.materiality, i.polarity, i.held, i.watch, i.text_llm, n.name
                 FROM announcement a
                 LEFT JOIN item_assessment i ON i.source = a.source AND i.ann_id = a.ann_id
                 LEFT JOIN instrument n ON n.market = a.market AND n.code = a.code`;

const pol = (v: unknown): -1 | 0 | 1 | null =>
  v === null || v === undefined ? null : Number(v) > 0 ? 1 : Number(v) < 0 ? -1 : 0; // money-float-ok: SQL integer column

export async function loadNews(env: LoaderEnv, q: NewsQuery): Promise<NewsModel> {
  const masked = env.mask.masked;
  const base: NewsModel = {
    state: "empty",
    masked,
    chip: q.chip,
    items: [],
    page: q.page,
    hasMore: false,
    hasNewer: false,
    olderAfter: null,
    newerBefore: null,
    note: masked ? "Company names, links and exact dates are hidden for your access level." : null,
    importantOnly: false,
  };
  // The alerts chip lists alerts, which the alert inbox loader owns.
  if (q.chip === "alerts") return base;
  const where = ["a.market = ?"];
  const args: Array<string | number> = [marketOf(env)];
  if (q.chip === "mine") where.push("(i.held = 1 OR i.watch = 1)");
  // Default view: price-sensitive announcements and those about held, picked or starred companies.
  // A search or a company or date filter always looks through everything.
  const filtered = [q.q, q.code, q.from, q.to].some((v) => v !== undefined);
  const importantOnly = q.chip === "all" && q.show !== "all" && !filtered;
  if (importantOnly) {
    const stars = masked ? [] : [...(await starredCodes(env))].slice(0, STAR_CAP);
    where.push(
      `(a.price_sensitive = 1 OR i.held = 1 OR i.watch = 1 OR i.candidate = 1${
        stars.length > 0 ? ` OR UPPER(a.code) IN (${stars.map(() => "?").join(",")})` : ""
      })`,
    );
    args.push(...stars.map((c) => c.toUpperCase()));
  }
  if (!masked && q.code !== undefined) {
    where.push("a.code = ?");
    args.push(q.code.toUpperCase());
  }
  if (!masked && q.q !== undefined) {
    where.push("a.title LIKE ? ESCAPE '\\'");
    args.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (q.from !== undefined) {
    where.push("a.published_at >= ?");
    args.push(`${q.from}T00:00:00`);
  }
  if (q.to !== undefined) {
    where.push("a.published_at < ?");
    args.push(
      `${new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00`,
    ); // threshold-ok: one day
  }
  // Keyset paging (D-959): after the oldest item shown, or before the newest; never OFFSET. A masked
  // list reads one bounded scan and pages it in memory. The order uses idx_announcement_published.
  const backwards = !masked && q.before !== undefined;
  const cursor = masked ? undefined : (q.after ?? q.before);
  if (cursor !== undefined) {
    const [at, id] = splitCursor(cursor);
    where.push(
      backwards
        ? "(a.published_at > ? OR (a.published_at = ? AND a.id > ?))"
        : "(a.published_at < ? OR (a.published_at = ? AND a.id < ?))",
    );
    args.push(at, at, id);
  }
  args.push(masked ? SCAN_ROWS : LIST_ROWS + 1);
  const r = await env.main.execute({
    sql: `${ROW_SQL} WHERE ${where.join(" AND ")} ORDER BY a.published_at ${backwards ? "ASC" : "DESC"}, a.id ${backwards ? "ASC" : "DESC"} LIMIT ?`,
    args,
  });
  let rows = r.rows.map((x) => ({
    d: melbourneDate(String(x.published_at)) ?? String(x.published_at).slice(0, 10),
    code: String(x.code),
    x,
  }));
  let kit: Awaited<ReturnType<typeof maskKitByDate>> | null = null;
  if (masked) {
    // Only items about a stock of the item's own date's active set.
    const dates = [...new Set(rows.map((x) => x.d))].sort();
    const active =
      dates.length > 0
        ? await activeCodesByDate(env.main, marketOf(env), dates[0]!, dates[dates.length - 1]!)
        : new Map<string, Set<string>>();
    rows = rows.filter((x) => active.get(x.d)?.has(normCode(x.code)) === true);
    kit = await maskKitByDate(env, rows);
    const start = (q.page - 1) * LIST_ROWS;
    base.hasMore = rows.length > start + LIST_ROWS;
    base.hasNewer = q.page > 1;
    rows = rows.slice(start, start + LIST_ROWS);
  } else {
    const more = rows.length > LIST_ROWS;
    rows = rows.slice(0, LIST_ROWS);
    if (backwards) rows.reverse(); // newest first again
    base.hasMore = backwards ? true : more; // going back, the cursor item itself is older
    base.hasNewer = backwards ? more : q.after !== undefined;
    base.page = base.hasNewer ? Math.max(2, q.page) : 1;
    const keyOf = (x: { x: Record<string, unknown> }) =>
      `${String(x.x.published_at)}|${Number(x.x.id)}`;
    base.olderAfter = base.hasMore && rows.length > 0 ? keyOf(rows[rows.length - 1]!) : null;
    base.newerBefore = base.hasNewer && rows.length > 0 ? keyOf(rows[0]!) : null;
  }
  const items: NewsItemRow[] = rows.map(({ d, code, x }) => {
    const aliases = kit?.aliasOf(d);
    return {
      id: Number(x.id), // money-float-ok: SQL integer key
      stock: aliases ? aliases.label(code) : code,
      company: masked || x.name == null ? null : displayName(String(x.name)),
      title: displayTitle(
        aliases && kit ? maskText(String(x.title), aliases, kit.lookup) : String(x.title),
      ),
      type: masked || x.type == null ? null : sentenceCase(String(x.type)),
      summary:
        x.text_llm == null
          ? null
          : aliases && kit
            ? displayText(maskText(String(x.text_llm), aliases, kit.lookup), SUMMARY_WITHHELD)
            : masked
              ? null
              : displayText(String(x.text_llm), SUMMARY_WITHHELD),
      published: masked ? (isoWeek(d) ?? MISSING) : String(x.published_at),
      priceSensitive: Number(x.price_sensitive) === 1,
      materiality: x.materiality === null ? null : Number(x.materiality), // money-float-ok: SQL integer column
      polarity: pol(x.polarity),
      heldByUs: !masked && Number(x.held ?? 0) === 1,
    };
  });
  return { ...base, state: items.length === 0 ? "empty" : "ok", items, importantOnly };
}

// ---- one item (pop-up) -----------------------------------------------------------------------------

export type NewsItemModel = {
  masked: boolean;
  id: number;
  stock: string;
  company: string | null;
  title: string;
  type: string | null;
  published: string;
  priceSensitive: boolean;
  materiality: number | null;
  polarity: -1 | 0 | 1 | null;
  /** Our short text when a summary exists; otherwise null (decision 48). */
  assessment: string | null;
  url: string | null;
  today: string;
};

/** `id` is an announcement id; null when not stored or (for a masked user) not in the date's active set. */
export async function loadNewsItem(env: LoaderEnv, id: number): Promise<NewsItemModel | null> {
  const masked = env.mask.masked;
  const r = await env.main.execute({
    sql: `SELECT a.id, a.code, a.title, a.type, a.url, a.published_at, a.price_sensitive,
                 i.materiality, i.polarity, i.text_llm, n.name
          FROM announcement a
          LEFT JOIN item_assessment i ON i.source = a.source AND i.ann_id = a.ann_id
          LEFT JOIN instrument n ON n.market = a.market AND n.code = a.code
          WHERE a.id = ? AND a.market = ?`,
    args: [id, marketOf(env)],
  });
  const x = r.rows[0];
  if (!x) return null;
  const code = String(x.code);
  const d = melbourneDate(String(x.published_at)) ?? String(x.published_at).slice(0, 10);
  let stock = code;
  let title = String(x.title);
  let assessment = x.text_llm === null ? null : String(x.text_llm);
  if (masked) {
    const kit = await maskKit(env, d);
    if (!kit.aliases.has(code)) return null;
    stock = kit.aliases.label(code);
    title = maskText(title, kit.aliases, kit.lookup);
    assessment = assessment === null ? null : maskText(assessment, kit.aliases, kit.lookup);
  }
  return {
    masked,
    id: Number(x.id), // money-float-ok: SQL integer key
    stock,
    company: masked || x.name === null ? null : displayName(String(x.name)),
    title: displayTitle(title),
    type: x.type === null ? null : sentenceCase(String(x.type)),
    published: masked ? (isoWeek(d) ?? MISSING) : String(x.published_at),
    priceSensitive: Number(x.price_sensitive) === 1,
    materiality: x.materiality === null ? null : Number(x.materiality), // money-float-ok: SQL integer column
    polarity: pol(x.polarity),
    assessment: assessment === null ? null : displayText(assessment, SUMMARY_WITHHELD),
    url: masked || x.url === null ? null : safeSourceUrl(x.url), // SEC-016: https + registered host, else text only
    today: todayD(env),
  };
}

/**
 * The stored id of an announcement addressed by its source's `ann_id` (the `/news?item=<ann_id>` link
 * of a Decision Card, UXN-038). Unmasked viewers only: a masked viewer never gets this link, so for
 * them the answer is always null (no existence oracle).
 */
export async function resolveNewsItemRef(env: LoaderEnv, annId: string): Promise<number | null> {
  if (env.mask.masked || annId.length === 0 || annId.length > 200) return null; // threshold-ok: id length cap
  const r = await env.main.execute({
    sql: "SELECT id FROM announcement WHERE market = ? AND ann_id = ? ORDER BY id LIMIT 1",
    args: [marketOf(env), annId],
  });
  const x = r.rows[0];
  return x ? Number(x.id) : null; // money-float-ok: SQL integer key
}
