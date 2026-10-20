// News loaders: the news list and the one-item pop-up (UX-060..062, UXN-035, UXN-038; docs/M7_design.md
// 3 rows 17, 18; D-136 draft). Stored announcements and our assessment only.
// Masking (DAT-124, UX-009): a masked user sees only items about stocks of the item's own Melbourne
// date's active set, as "Stock A", with a masked headline, the ISO week, no company name and no link.
// A search term and a code filter are ignored for them (they would reveal which codes exist).
import { isoWeek, MISSING } from "@/lib/view/format";
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

const LIST_ROWS = 50; // threshold-ok: one page of the news list
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
};

/** `?chip=&q=&code=&from=&to=&page=`: null when a value is not allowed. */
export function parseNewsQuery(sp: URLSearchParams): NewsQuery | null {
  const chip = sp.get("chip") ?? "mine";
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
  return { chip: chip as NewsChip, q, code, from, to, page };
}

export type NewsItemRow = {
  id: number;
  stock: string;
  title: string;
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
  hasMore: boolean;
  note: string | null;
};

const ROW_SQL = `SELECT a.id, a.code, a.title, a.published_at, a.price_sensitive,
                        i.materiality, i.polarity, i.held, i.watch
                 FROM announcement a
                 LEFT JOIN item_assessment i ON i.source = a.source AND i.ann_id = a.ann_id`;

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
    note: masked ? "Company names, links and exact dates are hidden for your access level." : null,
  };
  // The alerts chip lists alerts, which the alert inbox loader owns.
  if (q.chip === "alerts") return base;
  const where = ["a.market = ?"];
  const args: Array<string | number> = [marketOf(env)];
  if (q.chip === "mine") where.push("(i.held = 1 OR i.watch = 1)");
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
  args.push(masked ? SCAN_ROWS : LIST_ROWS + 1, masked ? 0 : (q.page - 1) * LIST_ROWS);
  const r = await env.main.execute({
    sql: `${ROW_SQL} WHERE ${where.join(" AND ")} ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?`,
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
    rows = rows.slice(start, start + LIST_ROWS);
  } else {
    base.hasMore = rows.length > LIST_ROWS;
    rows = rows.slice(0, LIST_ROWS);
  }
  const items: NewsItemRow[] = rows.map(({ d, code, x }) => {
    const aliases = kit?.aliasOf(d);
    return {
      id: Number(x.id), // money-float-ok: SQL integer key
      stock: aliases ? aliases.label(code) : code,
      title: aliases && kit ? maskText(String(x.title), aliases, kit.lookup) : String(x.title),
      published: masked ? (isoWeek(d) ?? MISSING) : String(x.published_at),
      priceSensitive: Number(x.price_sensitive) === 1,
      materiality: x.materiality === null ? null : Number(x.materiality), // money-float-ok: SQL integer column
      polarity: pol(x.polarity),
      heldByUs: !masked && Number(x.held ?? 0) === 1,
    };
  });
  return { ...base, state: items.length === 0 ? "empty" : "ok", items };
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
    company: masked || x.name === null ? null : String(x.name),
    title,
    type: x.type === null ? null : String(x.type),
    published: masked ? (isoWeek(d) ?? MISSING) : String(x.published_at),
    priceSensitive: Number(x.price_sensitive) === 1,
    materiality: x.materiality === null ? null : Number(x.materiality), // money-float-ok: SQL integer column
    polarity: pol(x.polarity),
    assessment,
    url: masked || x.url === null ? null : String(x.url),
    today: todayD(env),
  };
}
