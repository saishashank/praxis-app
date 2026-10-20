// Reviews loaders: the list, the calendar and one Evening Review (UX-080, UXN-113, UXN-206, EML-010/036;
// docs/M7_design.md 3 rows 19, 20; D-136 and D-144 drafts). Stored reviews only. The Owner and unmasked
// users get the stored HTML; a masked user gets the view model of `@/lib/view/reviews` built from the
// stored facts (never the HTML), with the same last-line leak check the page uses. "Mark as read" is
// Owner-only (`canMarkRead`).
// Masked users see ISO weeks, never an exact review date, and address a review by an opaque `rv-`
// reference (keyed digest, like `ck-`/`pk:`). Section 7a "New picks" is read from the stored picks with
// the review's own letters, so "Stock A" is the same stock in every section of the page.
import { getConfig } from "@/lib/config/store";
import { listVersions, loadReview, readState } from "@/lib/review/assemble";
import type { Missing } from "@/lib/review/facts";
import { activeCodesForDate } from "@/lib/view/active";
import { formatCents, isoWeek, MISSING } from "@/lib/view/format";
import { findLeaks, loadMaskLookup, maskText, StockAliases, weekOnly } from "@/lib/view/mask";
import { opaqueDigest } from "@/lib/view/opaqueRef";
import {
  factCodes,
  maskedReview,
  parseFacts,
  reviewLeaks,
  type MaskedReview,
} from "@/lib/view/reviews";
import { dateStaleness } from "@/lib/view/staleness";
import { modelSuccess, pickRef, successLine } from "./picks";
import {
  intParam,
  isDateParam,
  marketOf,
  money,
  textParam,
  todayD,
  type LoaderEnv,
  type LoaderState,
  type MoneyView,
} from "./shell";

const LIST_ROWS = 30; // threshold-ok: one page of the review list
const MASKED_SCAN = 400; // threshold-ok: reviews a masked list can reach (about 16 months of days)
const MAX_REF_ROWS = 800; // threshold-ok: bound of the reference resolve scan
const STALE_DAYS = 4; // threshold-ok: evening reviews; a long weekend is 3 days
const WINDOW_START_MIN = 19 * 60 + 30; // threshold-ok: UX-080 "19:30–20:45" pending window starts
const SEND_BY_DEFAULT = "20:45"; // threshold-ok: ch.15 default of `send_by`, used only if the read fails
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REF_RE = /^rv-([0-9a-f]{16})$/;
const KIND_TEXT: Record<string, string> = {
  full: "Complete",
  partial: "Partial",
  minimal: "Minimal",
  non_trading: "Non-trading day",
};

/** `rv-` plus the keyed digest of the review date: the address a masked user follows. */
export const reviewRef = (d: string): string => "rv-" + opaqueDigest("rv", d);
export const isReviewRef = (v: string): boolean => REF_RE.test(v);
/** The path part of a review link: the date for an unmasked user, the opaque reference otherwise. */
export const reviewPath = (d: string, masked: boolean): string =>
  `/reviews/${masked ? reviewRef(d) : d}`;

/** The stored review date behind a reference (null when none matches). */
export async function resolveReviewRef(env: LoaderEnv, ref: string): Promise<string | null> {
  if (!REF_RE.test(ref)) return null;
  const r = await env.main.execute({
    sql: "SELECT DISTINCT d FROM evening_review ORDER BY d DESC LIMIT ?",
    args: [MAX_REF_ROWS],
  });
  for (const x of r.rows) if (reviewRef(String(x.d)) === ref) return String(x.d);
  return null;
}

export type ReviewsQuery = { q?: string; page: number; view?: "calendar"; month?: string };

/** `?q=&page=&view=&month=`: q is a date prefix, kind word or text; null when a value is not allowed. */
export function parseReviewsQuery(sp: URLSearchParams): ReviewsQuery | null {
  const q = textParam(sp.get("q"), 20);
  const page = intParam(sp.get("page"), 1, 1000);
  if (q === null || page === null) return null;
  if (q !== undefined && !/^[A-Za-z0-9 _-]+$/.test(q)) return null;
  const v = sp.get("view");
  if (v !== null && v !== "list" && v !== "calendar") return null;
  const m = sp.get("month");
  if (m !== null && m !== "" && !MONTH_RE.test(m)) return null;
  const out: ReviewsQuery = { q, page };
  if (v === "calendar") out.view = "calendar";
  if (m) out.month = m;
  return out;
}

// ---- shared parts -------------------------------------------------------------------------------

export type DeliveryView = { status: string; text: string };
const DELIVERY_TEXT: Record<string, string> = {
  sent: "Emailed",
  failed: "Email failed",
  claimed: "Email being sent",
  suppressed_cap: "Not emailed: daily email limit reached",
  suppressed_off: "Not emailed: email is switched off",
  suppressed_paused: "Not emailed: paused",
  no_recipient: "Not emailed: no recipient",
  none: "Not emailed",
};
const NOT_EMAILED: DeliveryView = { status: "none", text: DELIVERY_TEXT.none! };
const delivery = (status: string): DeliveryView => ({
  status,
  text: DELIVERY_TEXT[status] ?? DELIVERY_TEXT.none!,
});

/** Delivery of the review email per date: a sent mail wins, else the newest attempt. */
async function deliveryByDate(env: LoaderEnv, dates: string[]): Promise<Map<string, DeliveryView>> {
  const out = new Map<string, DeliveryView>();
  if (dates.length === 0) return out;
  try {
    const r = await env.main.execute({
      sql: `SELECT d, status FROM email_message WHERE kind = 'review'
              AND d IN (${dates.map(() => "?").join(",")}) ORDER BY created_at`,
      args: dates,
    });
    for (const x of r.rows) {
      const d = String(x.d);
      if (out.get(d)?.status === "sent") continue;
      out.set(d, delivery(String(x.status)));
    }
  } catch {
    // an unreadable table shows "Not emailed" rather than failing the page
  }
  return out;
}

const hhmm = /^(\d{1,2}):(\d{2})$/;
const melbourneClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function melbourneMinutes(now: Date): number {
  const p = Object.fromEntries(melbourneClock.formatToParts(now).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute); // threshold-ok: minutes per hour
}

export type PendingState = "window" | "late" | null;

/** UX-080: no review stored for today and the clock is in 19:30 to `send_by` ("window") or after it ("late"). */
async function pendingStateOf(env: LoaderEnv, todayStored: boolean): Promise<PendingState> {
  if (todayStored) return null;
  let sendBy = SEND_BY_DEFAULT;
  try {
    const v = await getConfig(env.main, "send_by");
    if (typeof v === "string" && hhmm.test(v)) sendBy = v;
  } catch {
    // default
  }
  const m = hhmm.exec(sendBy)!;
  const end = Number(m[1]) * 60 + Number(m[2]); // threshold-ok: minutes per hour
  const now = melbourneMinutes(env.now);
  if (now < WINDOW_START_MIN) return null;
  return now <= end ? "window" : "late";
}

const aiOf = (narrative: string): boolean => narrative === "llm" || narrative === "mock";
export const AI_TEXT = "Written with AI";
export const NO_AI_TEXT = "Written without AI today";

// ---- the list -----------------------------------------------------------------------------------

export type ReviewListRow = {
  /** The review date, or the ISO week for a masked user. */
  d: string;
  label: string;
  href: string;
  version: number;
  kind: string;
  kindText: string;
  partial: boolean;
  narrative: string;
  /** UXN-113: the narrative sections were written by the model (otherwise the facts-only fallback). */
  ai: boolean;
  aiText: string;
  read: boolean;
  delivery: DeliveryView;
};
export type ReviewListModel = {
  state: LoaderState;
  masked: boolean;
  staleText: string | null;
  /** Today's review is not stored yet. */
  pending: boolean;
  /** UX-080: "window" 19:30 to send_by, "late" after it, null otherwise. */
  pendingState: PendingState;
  rows: ReviewListRow[];
  page: number;
  hasMore: boolean;
};

type ListRow = Record<string, unknown>;

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function loadReviewList(env: LoaderEnv, q: ReviewsQuery): Promise<ReviewListModel> {
  const masked = env.mask.masked;
  const today = todayD(env);
  const select = `SELECT e.d, e.version, e.kind, e.narrative, rr.read_at
          FROM evening_review e LEFT JOIN review_read rr ON rr.d = e.d
          WHERE e.version = (SELECT MAX(v.version) FROM evening_review v WHERE v.d = e.d)`;
  const lowerQ = q.q?.toLowerCase();
  const kindHits =
    lowerQ === undefined
      ? []
      : Object.entries(KIND_TEXT)
          .filter(([k, t]) => k.startsWith(lowerQ) || t.toLowerCase().startsWith(lowerQ))
          .map(([k]) => k);

  let raw: ListRow[];
  let hasMore: boolean;
  if (masked) {
    // A masked user's search never touches the review text or the exact date: weeks and kinds only.
    const r = await env.main.execute({
      sql: `${select} ORDER BY e.d DESC LIMIT ?`,
      args: [MASKED_SCAN],
    });
    const all = r.rows as unknown as ListRow[];
    const hits = all.filter((x) => {
      if (lowerQ === undefined) return true;
      const wk = (isoWeek(String(x.d)) ?? "").toLowerCase();
      return wk.includes(lowerQ) || kindHits.includes(String(x.kind));
    });
    const from = (q.page - 1) * LIST_ROWS;
    raw = hits.slice(from, from + LIST_ROWS);
    hasMore = hits.length > from + LIST_ROWS;
    // Ordinal inside a week (oldest first) tells two reviews of one week apart without a date.
    const ordinal = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const x of [...all].reverse()) {
      const wk = isoWeek(String(x.d)) ?? MISSING;
      const n = (seen.get(wk) ?? 0) + 1;
      seen.set(wk, n);
      ordinal.set(String(x.d), n);
    }
    return finishList(env, raw, hasMore, q.page, today, ordinal);
  }
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (q.q !== undefined) {
    const like = `${escapeLike(q.q)}%`;
    const clauses = ["e.d LIKE ? ESCAPE '\\'", "e.text LIKE ? ESCAPE '\\'"];
    args.push(like, `%${escapeLike(q.q)}%`);
    for (const k of kindHits) {
      clauses.push("e.kind = ?");
      args.push(k);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }
  args.push(LIST_ROWS + 1, (q.page - 1) * LIST_ROWS);
  const r = await env.main.execute({
    sql: `${select} ${where.length ? `AND ${where.join(" AND ")}` : ""}
          ORDER BY e.d DESC LIMIT ? OFFSET ?`,
    args,
  });
  raw = (r.rows as unknown as ListRow[]).slice(0, LIST_ROWS);
  hasMore = r.rows.length > LIST_ROWS;
  return finishList(env, raw, hasMore, q.page, today, null);
}

async function finishList(
  env: LoaderEnv,
  raw: ListRow[],
  hasMore: boolean,
  page: number,
  today: string,
  ordinal: Map<string, number> | null,
): Promise<ReviewListModel> {
  const masked = env.mask.masked;
  const deliveries = await deliveryByDate(
    env,
    raw.map((x) => String(x.d)),
  );
  const rows: ReviewListRow[] = raw.map((x) => {
    const real = String(x.d);
    const wk = isoWeek(real) ?? MISSING;
    const kind = String(x.kind);
    const narrative = String(x.narrative);
    return {
      d: masked ? wk : real,
      label: masked ? `Week ${wk}, review ${ordinal?.get(real) ?? 1}` : real,
      href: reviewPath(real, masked),
      version: Number(x.version), // money-float-ok: SQL integer column
      kind,
      kindText: KIND_TEXT[kind] ?? kind,
      partial: kind === "partial",
      narrative,
      ai: aiOf(narrative),
      aiText: aiOf(narrative) ? AI_TEXT : NO_AI_TEXT,
      read: x.read_at !== null && x.read_at !== undefined,
      delivery: deliveries.get(real) ?? NOT_EMAILED,
    };
  });
  const newest = raw.length ? String(raw[0]!.d) : null;
  const stale = dateStaleness(newest, today, STALE_DAYS);
  const todayStored = await storedOn(env, today);
  return {
    state: rows.length === 0 ? "empty" : stale.state === "stale" ? "stale" : "ok",
    masked,
    staleText: stale.state === "stale" ? stale.text : null,
    pending: !todayStored,
    pendingState: await pendingStateOf(env, todayStored),
    rows,
    page,
    hasMore,
  };
}

async function storedOn(env: LoaderEnv, d: string): Promise<boolean> {
  if (d === "") return false;
  const r = await env.main.execute({
    sql: "SELECT 1 AS x FROM evening_review WHERE d = ? LIMIT 1",
    args: [d],
  });
  return r.rows.length > 0;
}

// ---- the calendar (UXN-206) ---------------------------------------------------------------------

export type DayPl = { currency: string; cents: number; text: string };
export type CalendarCell = {
  d: string;
  day: number;
  href: string;
  kindText: string;
  partial: boolean;
  pl: DayPl[];
  /** One sentence for the tooltip and the screen reader. */
  summary: string;
};
export type MaskedCalendarWeek = {
  week: string;
  count: number;
  href: string;
  pl: DayPl[];
  summary: string;
};
export type ReviewCalendarModel = {
  state: LoaderState;
  masked: boolean;
  month: string;
  monthLabel: string;
  prev: string;
  next: string | null;
  /** Unmasked: Monday-first rows of 7 (null = no day). Empty for a masked user. */
  weeks: Array<Array<CalendarCell | null>>;
  /** Masked: one row per ISO week with the summed day P/L. Empty for an unmasked user. */
  maskedWeeks: MaskedCalendarWeek[];
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_PER_YEAR = 12; // threshold-ok: calendar constant

function shiftMonth(month: string, by: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / MONTHS_PER_YEAR);
  const mm = ((m % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

function currencyPrefix(c: string): string {
  return c === "AUD" ? "A$" : `${c} `;
}

/** Sums the stored day P/L of a review's executions per currency (no FX blending, O-34). */
function dayPlOf(exJson: unknown): DayPl[] {
  let list: unknown;
  try {
    list = typeof exJson === "string" ? JSON.parse(exJson) : null;
  } catch {
    list = null;
  }
  const sums = new Map<string, number>();
  if (Array.isArray(list)) {
    for (const e of list) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      if (typeof o.currency !== "string" || typeof o.dayPlCents !== "number") continue;
      if (!Number.isFinite(o.dayPlCents)) continue;
      sums.set(o.currency, (sums.get(o.currency) ?? 0) + o.dayPlCents);
    }
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({
      currency,
      cents,
      text: formatCents(cents, { currency: currencyPrefix(currency), sign: "always" }),
    }));
}

const plSentence = (pl: DayPl[]): string =>
  pl.length === 0
    ? "no profit or loss recorded"
    : pl.map((p) => `${p.text} ${p.currency}`).join(", ");

export async function loadReviewCalendar(
  env: LoaderEnv,
  q: { month?: string },
): Promise<ReviewCalendarModel> {
  const masked = env.mask.masked;
  const today = todayD(env);
  const thisMonth = today.slice(0, 7);
  const month = q.month ?? (thisMonth.length === 7 ? thisMonth : "1970-01");
  const monthLabel = `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  const from = `${month}-01`;
  const to = `${shiftMonth(month, 1)}-01`;
  const r = await env.main.execute({
    sql: `SELECT e.d, e.kind, json_extract(e.facts_json, '$.executions') AS ex
          FROM evening_review e
          WHERE e.d >= ? AND e.d < ?
            AND e.version = (SELECT MAX(v.version) FROM evening_review v WHERE v.d = e.d)
          ORDER BY e.d`,
    args: [from, to],
  });
  const days = r.rows.map((x) => ({
    d: String(x.d),
    kind: String(x.kind),
    pl: dayPlOf(x.ex),
  }));
  const base: ReviewCalendarModel = {
    state: days.length === 0 ? "empty" : "ok",
    masked,
    month,
    monthLabel,
    prev: shiftMonth(month, -1),
    next: month < thisMonth ? shiftMonth(month, 1) : null,
    weeks: [],
    maskedWeeks: [],
  };
  if (masked) {
    const byWeek = new Map<string, { count: number; sums: Map<string, number> }>();
    for (const day of days) {
      const wk = isoWeek(day.d) ?? MISSING;
      const w = byWeek.get(wk) ?? { count: 0, sums: new Map<string, number>() };
      w.count += 1;
      for (const p of day.pl) w.sums.set(p.currency, (w.sums.get(p.currency) ?? 0) + p.cents);
      byWeek.set(wk, w);
    }
    base.maskedWeeks = [...byWeek.entries()].map(([week, w]) => {
      const pl = [...w.sums.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, cents]) => ({
          currency,
          cents,
          text: formatCents(cents, { currency: currencyPrefix(currency), sign: "always" }),
        }));
      return {
        week,
        count: w.count,
        href: `/reviews?q=${encodeURIComponent(week)}`,
        pl,
        summary: `Week ${week}: ${w.count} ${w.count === 1 ? "review" : "reviews"}, ${plSentence(pl)}`,
      };
    });
    return base;
  }
  const byDay = new Map(days.map((x) => [x.d, x]));
  const first = new Date(`${from}T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0  (threshold-ok: weekday arithmetic)
  const length = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate();
  const cells: Array<CalendarCell | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= length; day += 1) {
    const d = `${month}-${String(day).padStart(2, "0")}`;
    const hit = byDay.get(d);
    cells.push(
      hit
        ? {
            d,
            day,
            href: `/reviews/${d}`,
            kindText: KIND_TEXT[hit.kind] ?? hit.kind,
            partial: hit.kind === "partial",
            pl: hit.pl,
            summary: `${d}: ${KIND_TEXT[hit.kind] ?? hit.kind} review, ${plSentence(hit.pl)}`,
          }
        : { d, day, href: "", kindText: "", partial: false, pl: [], summary: `${d}: no review` },
    );
  }
  while (cells.length % 7 !== 0) cells.push(null); // threshold-ok: days per week
  for (let i = 0; i < cells.length; i += 7) base.weeks.push(cells.slice(i, i + 7)); // threshold-ok: days per week
  return base;
}

// ---- one review ---------------------------------------------------------------------------------

export type NewPickView = {
  rank: number;
  /** "Stock A" for a masked user, the code otherwise. */
  stock: string;
  company: string | null;
  buyUpTo: MoneyView | null;
  stop: MoneyView | null;
  aim: MoneyView | null;
  /** The date, or the ISO week for a masked user. */
  validUntil: string;
  timeFrameWeeks: number | null;
  basedOn: string | null;
  href: string;
};
export type NewPicksView = {
  none: boolean;
  honesty: string;
  profiles: Array<{ profile: string; successLine: string; picks: NewPickView[] }>;
};

export type ReviewModel = {
  masked: boolean;
  /** The date, or the ISO week for a masked user. */
  d: string;
  /** Page heading: names the exact date only for an unmasked user or a masked user who typed the date. */
  title: string;
  version: number;
  versions: Array<{ version: number; kindText: string }>;
  kind: string;
  kindText: string;
  /** Sections still missing when this version was stored (a partial review, EML-011). */
  missing: Missing[];
  createdAt: string;
  narrative: string;
  /** UXN-113 badge. */
  ai: boolean;
  aiText: string;
  read: { readAt: string; via: string } | null;
  canMarkRead: boolean;
  delivery: DeliveryView;
  /** Stored HTML: only for the Owner and unmasked users. */
  html: string | null;
  /** The masked view; null for an unmasked user, and also null when it failed the leak check. */
  maskedView: MaskedReview | null;
  /** True when a masked user's view could not be built safely. */
  unavailable: boolean;
  /** Section 7a. */
  newPicks: NewPicksView | null;
  /** True when 7a was left out because it failed the leak check. */
  newPicksHidden: boolean;
};

type PickRaw = {
  profile: string;
  rank: number;
  code: string;
  name: string | null;
  buy: string;
  stop: string;
  aim: string;
  valid: string;
  sessions: number | null;
  basedOn: string | null;
};
const SESSIONS_PER_WEEK = 5; // threshold-ok: weekdays per week, display unit only

async function pickRows(env: LoaderEnv, d: string): Promise<PickRaw[]> {
  try {
    const r = await env.main.execute({
      sql: `SELECT p.profile, p.rank, p.code, i.name, p.buy_max_micro, p.stop_micro, p.aim_micro,
                   p.valid_until_d, p.time_frame_sessions, p.based_on_json
            FROM pick p LEFT JOIN instrument i ON i.market = p.market AND i.code = p.code
            WHERE p.market = ? AND p.d = ? ORDER BY p.profile, p.rank LIMIT 60`,
      args: [marketOf(env), d],
    });
    return r.rows.map((x) => {
      let based: string | null = null;
      try {
        const v: unknown = JSON.parse(String(x.based_on_json));
        if (Array.isArray(v) && typeof v[0] === "string") based = v[0];
      } catch {
        based = null;
      }
      return {
        profile: String(x.profile),
        rank: Number(x.rank), // money-float-ok: SQL integer column
        code: String(x.code),
        name: x.name === null ? null : String(x.name),
        buy: String(x.buy_max_micro),
        stop: String(x.stop_micro),
        aim: String(x.aim_micro),
        valid: String(x.valid_until_d),
        sessions: x.time_frame_sessions === null ? null : Number(x.time_frame_sessions), // money-float-ok: SQL integer column
        basedOn: based,
      };
    });
  } catch {
    return [];
  }
}

async function successLines(
  env: LoaderEnv,
  d: string,
  profiles: string[],
): Promise<{ lines: Map<string, string>; proven: boolean }> {
  const lines = new Map<string, string>();
  let proven = profiles.length > 0;
  try {
    const minN = Number(await getConfig(env.main, "pick_success_min_n"));
    const confidence = Number(await getConfig(env.main, "cif_confidence"));
    for (const profile of profiles) {
      const s = await modelSuccess(env.main, {
        market: marketOf(env),
        profile,
        d,
        minN,
        confidence,
      });
      if (!s.beatsLuck) proven = false;
      // The "since" date is a trade date: a masked user's line carries no date (UX-009).
      lines.set(profile, successLine(env.mask.masked ? { ...s, since: null } : s));
    }
  } catch {
    proven = false;
  }
  return { lines, proven };
}

async function newPicksOf(
  env: LoaderEnv,
  d: string,
  rows: PickRaw[],
  aliases: StockAliases | null,
  t: (s: string) => string,
): Promise<NewPicksView> {
  const masked = env.mask.masked;
  const names = [...new Set(rows.map((r) => r.profile))];
  const { lines, proven } = await successLines(env, d, names);
  return {
    none: rows.length === 0,
    honesty: "Personal use only · Not financial advice" + (proven ? "" : " · Model not proven yet"),
    profiles: names.map((profile) => ({
      profile,
      successLine: lines.get(profile) ?? "",
      picks: rows
        .filter((r) => r.profile === profile)
        .map((r) => {
          const real = `${d}.${profile}.${r.rank}`;
          return {
            rank: r.rank,
            stock: aliases ? aliases.label(r.code) : r.code,
            company: masked ? null : r.name,
            buyUpTo: masked ? null : money(r.buy),
            stop: masked ? null : money(r.stop),
            aim: masked ? null : money(r.aim),
            validUntil: masked ? (isoWeek(r.valid) ?? MISSING) : r.valid,
            timeFrameWeeks:
              r.sessions === null ? null : Math.max(1, Math.round(r.sessions / SESSIONS_PER_WEEK)),
            basedOn: r.basedOn === null ? null : t(r.basedOn),
            href: `/picks/${encodeURIComponent(masked ? pickRef(real) : real)}`,
          };
        }),
    })),
  };
}

/**
 * `idOrDate` is a date or an `rv-` reference, `version` optional; null when no review is stored.
 * A masked user may address a review by the exact date too (existing behaviour, tests); the list and
 * the calendar only ever link the reference.
 */
export async function loadReviewPage(
  env: LoaderEnv,
  idOrDate: string,
  version?: number,
): Promise<ReviewModel | null> {
  let d: string;
  let byRef = false;
  if (isReviewRef(idOrDate)) {
    const found = await resolveReviewRef(env, idOrDate);
    if (found === null) return null;
    d = found;
    byRef = true;
  } else if (isDateParam(idOrDate)) {
    d = idOrDate;
  } else {
    return null;
  }
  const versions = await listVersions(env.main, d);
  if (versions.length === 0) return null;
  const review = await loadReview(env.main, d, version);
  if (review === null) return null;
  const read = await readState(env.main, d);
  const masked = env.mask.masked;
  const wk = isoWeek(d) ?? MISSING;
  const deliveries = await deliveryByDate(env, [d]);
  const picks = await pickRows(env, d);
  let view: MaskedReview | null = null;
  let newPicks: NewPicksView | null = null;
  let newPicksHidden = false;
  if (masked) {
    const row = await env.main.execute({
      sql: "SELECT facts_json FROM evening_review WHERE d = ? AND version = ?",
      args: [d, review.version],
    });
    const facts = row.rows.length ? parseFacts(String(row.rows[0]!.facts_json)) : null;
    const market = marketOf(env);
    const active = await activeCodesForDate(env.main, market, d);
    const lookup = await loadMaskLookup(env.main, market);
    const aliases = new StockAliases([
      ...active,
      ...(facts ? factCodes(facts) : []),
      ...picks.map((p) => p.code),
    ]);
    const names = aliases.codes().map((c) => lookup.names.get(c) ?? "");
    if (facts !== null) {
      const built = maskedReview(facts, aliases, lookup);
      view = reviewLeaks(built, aliases.codes(), names) ? null : built;
    }
    const built = await newPicksOf(env, d, picks, aliases, (s) => maskText(s, aliases, lookup));
    if (findLeaks(built, aliases.codes(), names, { caseSensitive: true }).length > 0) {
      newPicksHidden = true;
    } else {
      newPicks = built;
    }
  } else {
    newPicks = await newPicksOf(env, d, picks, null, (s) => s);
  }
  const title = masked && byRef ? `Evening Review, week ${wk}` : `Evening Review ${d}`;
  return {
    masked,
    d: masked ? wk : d,
    title,
    version: review.version,
    versions: versions.map((v) => ({ version: v.version, kindText: KIND_TEXT[v.kind] ?? v.kind })),
    kind: review.kind,
    kindText: KIND_TEXT[review.kind] ?? review.kind,
    missing: review.kind === "partial" ? review.missing : [],
    createdAt: masked ? (weekOnly(review.createdAt) ?? MISSING) : review.createdAt,
    narrative: review.narrative,
    ai: aiOf(review.narrative),
    aiText: aiOf(review.narrative) ? AI_TEXT : NO_AI_TEXT,
    read: read
      ? { readAt: masked ? (weekOnly(read.readAt) ?? MISSING) : read.readAt, via: read.via }
      : null,
    canMarkRead: env.user.role === "owner",
    delivery: deliveries.get(d) ?? NOT_EMAILED,
    html: masked ? null : review.html,
    maskedView: view,
    unavailable: masked && view === null,
    newPicks,
    newPicksHidden,
  };
}

/** UX-080 pending state alone (the calendar view needs it without the list). */
export async function loadPendingState(env: LoaderEnv): Promise<PendingState> {
  return pendingStateOf(env, await storedOn(env, todayD(env)));
}
