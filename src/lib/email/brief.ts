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
import { loadAttentionItems } from "@/lib/health/attention";
import { emailKeys, melbourneDate } from "./keys";
import { LiveSendBlockedError } from "./provider";
import type { MorningCtx } from "./reminder";
import { sendEmail, type SendStatus } from "./send";

export type BriefResult =
  | { status: "skipped"; reason: "disabled" | "not_active" | "non_trading" }
  | { status: "sent" | "duplicate" | "suppressed" | "failed"; send: SendStatus };

const TZ = "Australia/Melbourne";
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

async function codeSets(db: Client, d: string): Promise<Set<string>> {
  const held = await db.execute({
    sql:
      "SELECT DISTINCT t.code AS code FROM trade t JOIN cohort c ON c.id = t.cohort_id " +
      "JOIN execution e ON e.id = c.execution_id " +
      "WHERE t.exit_type IS NULL AND c.live = 1 AND e.kind = 'E'",
    args: [],
  });
  const watch = await db.execute({
    sql:
      "SELECT DISTINCT code FROM signal WHERE market = 'AU' AND d IN " +
      "(SELECT DISTINCT d FROM signal WHERE market = 'AU' AND d < ? ORDER BY d DESC LIMIT ?) " +
      "UNION SELECT code FROM watch_list_owner WHERE market = 'AU' AND removed_at IS NULL AND expires_d >= ?",
    args: [d, WATCH_SESSIONS, d],
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
  const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = 'AU'", args: [] });
  if (!m.rows.length || String(m.rows[0]!.mode) !== "full") {
    return { status: "skipped", reason: "not_active" };
  }
  if (!isTradingDay(d, await loadCalendar(db, "AU"))) {
    return { status: "skipped", reason: "non_trading" };
  }

  const codes = await codeSets(db, d);
  const from = localToUtc(addDays(d, -1), "19:30", TZ).toISOString();
  const to = localToUtc(d, "08:00", TZ).toISOString();

  const overnight: { code: string; title: string; time: string; url?: string }[] = [];
  const events: { label: string; detail: string }[] = [];
  const ann = await db.execute({
    sql:
      "SELECT code, title, url, published_at FROM announcement WHERE market = 'AU' " +
      "AND published_at >= ? AND published_at < ? ORDER BY published_at, code",
    args: [from, to],
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
    sql: "SELECT code, type FROM corporate_action WHERE market = 'AU' AND ex_date = ? ORDER BY code",
    args: [d],
  });
  for (const r of ex.rows) {
    if (codes.has(String(r.code))) {
      events.push({ label: String(r.code), detail: `ex-date (${String(r.type)})` });
    }
  }
  const res = await db.execute({
    sql: "SELECT code FROM event WHERE market = 'AU' AND day0_d = ? AND category = 'results' GROUP BY code ORDER BY code",
    args: [d],
  });
  for (const r of res.rows) {
    if (codes.has(String(r.code))) events.push({ label: String(r.code), detail: "results" });
  }

  const plan: string[] = [];
  const ord = await db.execute({
    sql:
      "SELECT o.side AS side, o.kind AS kind, o.code AS code, COUNT(*) AS n FROM arena_order o " +
      "JOIN cohort c ON c.id = o.cohort_id JOIN execution e ON e.id = c.execution_id " +
      "WHERE o.status = 'pending' AND c.live = 1 AND e.kind = 'E' " +
      "GROUP BY o.side, o.kind, o.code ORDER BY o.code, o.side",
    args: [],
  });
  for (const r of ord.rows) {
    const n = Number(r.n);
    plan.push(
      `${String(r.side)} ${String(r.code)} (${String(r.kind)}) in ${n} execution${n === 1 ? "" : "s"}`,
    );
  }
  for (const a of await loadAttentionItems(db)) plan.push(`Health: ${a.label}`);

  try {
    const out = await sendEmail(
      { db, env: ctx.env, now: ctx.now, provider: ctx.provider, sleep: ctx.sleep },
      "brief",
      emailKeys.brief(d),
      { date: d, overnight, events, plan },
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
