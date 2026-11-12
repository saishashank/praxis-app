// Morning Brief runner (EML-016, AT-20a, M5 T13, design 4.7, decision 4). Default off. Sends ONE
// `brief:<d>` email (pool slot) only when `morning_brief_enabled` is on, D is a trading day and
// the market is `active` (mode full, MKT-106). Fixed template over stored data; no LLM text.
//   overnight announcements: published since 19:30 Melbourne the evening before, up to 08:00,
//     on held or watched codes (held = open trade of a live E cohort, watch = signal in the last 20
//     session dates or an unexpired Owner add);
//   today's events: ex-dates and result announcements dated D on those codes;
//   tonight's plan: pending orders of live E cohorts, plus open amber/red health items.
import type { Client } from "@libsql/client";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { addDays, isTradingDay, localToUtc } from "@/lib/data/calendar";
import { getConfig } from "@/lib/config/store";
import { enabledMarkets, loadProfile } from "@/lib/market/profile";
import type { BriefMarketSection } from "./templates/marketSections";
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";
import { loadAttentionItems } from "@/lib/health/attention";
import { emailKeys, melbourneDate } from "./keys";
import { LiveSendBlockedError } from "./provider";
import type { MorningCtx } from "./reminder";
import { sendEmail, type SendStatus } from "./send";

export type BriefResult =
  | { status: "skipped"; reason: "disabled" | "not_active" | "non_trading" }
  | { status: "sent" | "duplicate" | "suppressed" | "failed"; send: SendStatus };

const TZ = OWNER_TZ;
const WATCH_SESSIONS = 20; // watch_list_window default (AGT-014)
const hhmm = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(/^24:/, "00:");

async function codeSets(db: Client, d: string, market: string): Promise<Set<string>> {
  const held = await db.execute({
    sql:
      "SELECT DISTINCT t.code AS code FROM trade t JOIN cohort c ON c.id = t.cohort_id " +
      "JOIN execution e ON e.id = c.execution_id " +
      "WHERE t.exit_type IS NULL AND c.live = 1 AND e.kind = 'E'",
    args: [],
  });
  const watch = await db.execute({
    sql:
      "SELECT DISTINCT code FROM signal WHERE market = ? AND d IN " +
      "(SELECT DISTINCT d FROM signal WHERE market = ? AND d < ? ORDER BY d DESC LIMIT ?) " +
      "UNION SELECT code FROM watch_list_owner WHERE market = ? AND removed_at IS NULL AND expires_d >= ?",
    args: [market, market, d, WATCH_SESSIONS, market, d],
  });
  return new Set([...held.rows, ...watch.rows].map((r) => String(r.code)));
}

export async function runBrief(ctx: MorningCtx, dOverride?: string): Promise<BriefResult> {
  const { db } = ctx;
  const now = (ctx.now ?? (() => new Date()))();
  const d = dOverride ?? melbourneDate(now);
  if ((await getConfig(db, "morning_brief_enabled")) !== "on") {
    return { status: "skipped", reason: "disabled" };
  }
  // One brief for the Owner. Each enabled market that is active (mode full) and trades on D adds its
  // overnight announcements and today's events; with AU alone the content is exactly the single-market
  // brief (D-997, D-1060); with more than one, each market has its own section (D-1124, M20).
  const active: string[] = [];
  let anyActive = false;
  for (const market of await enabledMarkets(db)) {
    const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [market] });
    if (!m.rows.length || String(m.rows[0]!.mode) !== "full") continue;
    anyActive = true;
    if (isTradingDay(d, await loadCalendar(db, market))) active.push(market);
  }
  if (!anyActive) return { status: "skipped", reason: "not_active" };
  if (active.length === 0) return { status: "skipped", reason: "non_trading" };

  const from = localToUtc(addDays(d, -1), "19:30", TZ).toISOString();
  const to = localToUtc(d, "08:00", TZ).toISOString();

  type Part = {
    market: string;
    overnight: { code: string; title: string; time: string; url?: string }[];
    events: { label: string; detail: string }[];
  };
  const parts: Part[] = [];
  for (const market of active) {
    const overnight: Part["overnight"] = [];
    const events: Part["events"] = [];
    const codes = await codeSets(db, d, market);
    const ann = await db.execute({
      sql:
        "SELECT code, title, url, published_at FROM announcement WHERE market = ? " +
        "AND published_at >= ? AND published_at < ? ORDER BY published_at, code",
      args: [market, from, to],
    });
    for (const r of ann.rows) {
      const code = String(r.code);
      if (!codes.has(code)) continue;
      overnight.push({
        code,
        title: String(r.title),
        time: hhmm(String(r.published_at)),
        url: r.url ? String(r.url) : undefined,
      });
    }
    const ex = await db.execute({
      sql: "SELECT code, type FROM corporate_action WHERE market = ? AND ex_date = ? ORDER BY code",
      args: [market, d],
    });
    for (const r of ex.rows) {
      if (codes.has(String(r.code))) {
        events.push({ label: String(r.code), detail: `ex-date (${String(r.type)})` });
      }
    }
    const res = await db.execute({
      sql: "SELECT code FROM event WHERE market = ? AND day0_d = ? AND category = 'results' GROUP BY code ORDER BY code",
      args: [market, d],
    });
    for (const r of res.rows) {
      if (codes.has(String(r.code))) events.push({ label: String(r.code), detail: "results" });
    }
    parts.push({ market, overnight, events });
  }

  // UXN-313, D-1124: one section per active market that trades on D. With one market the lists are exactly the
  // single-market ones (the plan query is not market-filtered then, as before); with more, the first market keeps the
  // top lists, each further market has its own section, and every plan is filtered to its own market, never pooled.
  const multi = parts.length > 1;
  const planOf = async (market: string | null): Promise<string[]> => {
    const plan: string[] = [];
    const ord = await db.execute({
      sql:
        "SELECT o.side AS side, o.kind AS kind, o.code AS code, COUNT(*) AS n FROM arena_order o " +
        "JOIN cohort c ON c.id = o.cohort_id JOIN execution e ON e.id = c.execution_id " +
        "WHERE o.status = 'pending' AND c.live = 1 AND e.kind = 'E' " +
        (market === null ? "" : "AND e.market = ? ") +
        "GROUP BY o.side, o.kind, o.code ORDER BY o.code, o.side",
      args: market === null ? [] : [market],
    });
    for (const r of ord.rows) {
      const n = Number(r.n);
      plan.push(
        `${String(r.side)} ${String(r.code)} (${String(r.kind)}) in ${n} execution${n === 1 ? "" : "s"}`,
      );
    }
    return plan;
  };
  const first = parts[0]!;
  const overnight = first.overnight;
  const events = first.events;
  const plan = await planOf(multi ? first.market : null);
  for (const a of await loadAttentionItems(db)) plan.push(`Health: ${a.label}`);
  const sections: BriefMarketSection[] = [];
  if (multi) {
    for (const part of parts.slice(1)) {
      const name = (await loadProfile(db, part.market)).name;
      sections.push({
        market: part.market,
        name,
        overnight: part.overnight,
        events: part.events,
        plan: await planOf(part.market),
      });
    }
  }

  try {
    const out = await sendEmail(
      { db, env: ctx.env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "brief",
      emailKeys.brief(d),
      {
        date: d,
        overnight,
        events,
        plan,
        ...(multi
          ? { marketSections: sections, firstMarket: (await loadProfile(db, first.market)).name }
          : {}),
      },
    );
    const s = out.status;
    if (s === "sent") return { status: "sent", send: s };
    if (s === "duplicate") return { status: "duplicate", send: s };
    if (s.startsWith("suppressed") || s === "no_recipient") {
      return { status: "suppressed", send: s };
    }
    return { status: "failed", send: s };
  } catch (e) {
    if (e instanceof LiveSendBlockedError) throw e;
    return { status: "failed", send: "failed" };
  }
}
