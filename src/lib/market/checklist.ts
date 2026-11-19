// The switch-on checklist of a built market (MKT-111, AT-71, D-1100; M20 S1). Pure reads: nothing here writes.
// `checklist(db, code, now)` answers the one question the Owner's switch asks: may this market take its next step?
//
//   off -> data_only needs      profile_complete, at_m_evidence, licence_rows, quota_projection, au_mkt105
//   data_only -> full adds      five_green_days, latency_measured
//
// Each item is `{ id, ok, text, evidence }`: `text` is the plain-words state (what is missing when it is open) and
// `evidence` is the link or path the Markets page shows beside it. `complete` is true only when every item of the step
// is ok. The production seed can never be complete (IN/US evidence and register rows are open, D-1096), which is why
// no IN or US market can be switched on by accident (BLD-050).
//
// Every statement is a key probe or a bounded key-range read with a `rows-ok:` comment (Turso free plan, no OFFSET).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { marketDate } from "@/lib/data/calendar";
import { builtMarkets, loadProfile } from "@/lib/market/profile";
import { HOME_MARKET, OWNER_TZ } from "@/lib/market/profileCore.mjs";
import { marketSourcesOf } from "@/lib/market/seed/sourceSites.mjs";
import { loadProjectionReport } from "@/lib/usage/projection";

export type ChecklistStep = "data_only" | "full";
export type ChecklistItemId =
  | "profile_complete"
  | "at_m_evidence"
  | "licence_rows"
  | "quota_projection"
  | "au_mkt105"
  | "five_green_days"
  | "latency_measured";
export type ChecklistItem = {
  id: ChecklistItemId;
  ok: boolean;
  /** Plain words: the state, and what is open. */
  text: string;
  /** The link or path the Markets page shows beside the item; null when there is none. */
  evidence: string | null;
};
export type Checklist = {
  code: string;
  /** The step the items are for. */
  to: ChecklistStep;
  complete: boolean;
  items: ChecklistItem[];
};

/** MKT-105: AU has been live this many trading days (since its go-live sign-off). */
export const AU_LIVE_TRADING_DAYS = 60; // threshold-ok: MKT-105
/** MKT-111: this many consecutive completed sessions with a green quality verdict in `data_only`. */
export const GREEN_DAYS_REQUIRED = 5; // threshold-ok: MKT-111, AT-M4
/** D-1105: this many `bar_latency_sample` rows before `full` (the 10-night measurement). */
export const LATENCY_SAMPLES_REQUIRED = 10; // threshold-ok: D-1105
/** NFR-001: the completion marker by this Melbourne minute on at least this share of AU trading days. */
export const NFR1_MARKER_BY_MINUTE = 19 * 60 + 45; // threshold-ok: NFR-001 19:45
export const NFR1_SHARE_PCT = 95; // threshold-ok: NFR-001
/** NFR-002: at least this share of scheduled polls succeed. */
export const NFR2_SHARE_PCT = 98; // threshold-ok: NFR-002
/** NFR-003: the Evening Review delivered by 20:45 Melbourne on at least this many of 30 days. */
export const NFR3_BY_MINUTE = 20 * 60 + 45; // threshold-ok: NFR-003
export const NFR3_DAYS_REQUIRED = 28; // threshold-ok: NFR-003
const WINDOW_DAYS = 30; // threshold-ok: the "any 30-day window" of NFR-001…003
const MAX_LISTED = 5; // threshold-ok: ids named in a text before "and n more"

export type ChecklistDeps = {
  /** Is `docs/test-reports/AT-M-<CODE>.md` listed in the test map? Default: read docs/test-map.md. */
  reportListed?: (code: string) => boolean;
  /** The quota projection verdict for the market; default: `loadProjectionReport`. */
  quota?: (db: Client, code: string, now: Date) => Promise<{ fits: boolean; text: string }>;
  /** Test seam: the market's source rows (id, status) instead of the seed rows. */
  sources?: readonly {
    readonly id: string;
    readonly status: string;
    readonly optional?: boolean;
  }[];
  /** Test seam: the AU MKT-105 item (the real reader needs 60 sessions of planted AU history). */
  au?: (db: Client, now: Date) => Promise<ChecklistItem>;
};

const num = (v: unknown): number => Number(v ?? 0);

function defaultReportListed(code: string): boolean {
  try {
    const map = readFileSync(join(process.cwd(), "docs", "test-map.md"), "utf8");
    return map.includes(`test-reports/AT-M-${code}.md`);
  } catch {
    return false; // a deployment without the docs folder: the evidence cannot be shown, so it counts as open
  }
}

const named = (ids: readonly string[]): string =>
  ids.length <= MAX_LISTED
    ? ids.join(", ")
    : `${ids.slice(0, MAX_LISTED).join(", ")} and ${ids.length - MAX_LISTED} more`;

async function defaultQuota(
  db: Client,
  code: string,
  now: Date,
): Promise<{ fits: boolean; text: string }> {
  const rep = await loadProjectionReport(db, now);
  const v = rep.fitsWith[code];
  if (v === undefined || v === null) {
    const why = rep.markets.find((m) => m.market === code)?.note ?? "No projection.";
    return { fits: false, text: `No projection yet. ${why}` };
  }
  if (v.fits)
    return { fits: true, text: "AU plus the enabled markets plus this one fit the quotas." };
  const over = v.verdicts.filter((x) => !x.ok).map((x) => `${x.label} ${x.sharePct} %`);
  return { fits: false, text: `Over the line: ${named(over)}.` };
}

// ---- items ------------------------------------------------------------------------------------------------------

async function profileItem(db: Client, code: string): Promise<ChecklistItem> {
  const p = await loadProfile(db, code);
  const c = p.completeness;
  const ok = c.complete;
  const open = [...c.missing, ...c.unverified];
  return {
    id: "profile_complete",
    ok,
    text: ok
      ? `Profile complete: ${c.verified} of ${c.total} fields verified.`
      : `Profile: ${c.verified} of ${c.total} fields verified; open: ${named(open)}.`,
    evidence: "/settings/region",
  };
}

async function evidenceItem(db: Client, code: string, deps: ChecklistDeps): Promise<ChecklistItem> {
  const p = await loadProfile(db, code);
  const listed = (deps.reportListed ?? defaultReportListed)(code);
  const recorded = p.evidenceRecordedAt !== null;
  const path = `docs/test-reports/AT-M-${code}.md`;
  const ok = recorded && listed;
  const text = ok
    ? `AT-M evidence recorded ${p.evidenceRecordedAt!.slice(0, 10)}; the report is in the test map.`
    : !recorded
      ? "AT-M evidence not recorded."
      : `AT-M evidence recorded, but ${path} is not listed in the test map.`;
  return { id: "at_m_evidence", ok, text, evidence: path };
}

async function licenceItem(db: Client, code: string, deps: ChecklistDeps): Promise<ChecklistItem> {
  const seeded = deps.sources ?? marketSourcesOf(code);
  // rows-ok: at most 25 primary-key lookups of this market's own register ids
  const have =
    seeded.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await db.execute({
          sql: `SELECT source, status FROM source_register WHERE source IN (${seeded.map(() => "?").join(", ")})`,
          args: seeded.map((s) => s.id),
        });
  const stored = new Map(have.rows.map((r) => [String(r.source), String(r.status)]));
  // The rows are written when the market leaves `off` (D-1128): until then the seed row is the state that will be
  // written, so a pending seed row blocks and an enabled one does not.
  // A `disabled` row is a decision only for an optional source; a primary price or calendar source (optional: false in
  // the seed row) that is disabled leaves the market with no data, so it blocks like a pending one (S1 fix, D-1191).
  const pending: string[] = [];
  const disabledNeeded: string[] = [];
  for (const s of seeded) {
    const status = stored.get(s.id) ?? s.status;
    if (status === "pending") pending.push(s.id);
    else if (status === "disabled" && s.optional === false) disabledNeeded.push(s.id);
  }
  const open = [...pending, ...disabledNeeded];
  const ok = seeded.length > 0 && open.length === 0;
  return {
    id: "licence_rows",
    ok,
    text:
      seeded.length === 0
        ? "No source rows are defined for this market."
        : ok
          ? `All ${seeded.length} source rows are decided (enabled, with the Owner reference where one is needed, or disabled).`
          : `${open.length} of ${seeded.length} source rows are open: ${named(open)}${disabledNeeded.length > 0 ? ` (${disabledNeeded.length} disabled but needed)` : ""}.`,
    evidence: "docs/source-licence-register.md",
  };
}

async function quotaItem(
  db: Client,
  code: string,
  now: Date,
  deps: ChecklistDeps,
): Promise<ChecklistItem> {
  let verdict: { fits: boolean; text: string };
  try {
    verdict = await (deps.quota ?? defaultQuota)(db, code, now);
  } catch {
    verdict = { fits: false, text: "The projection could not be read." };
  }
  return {
    id: "quota_projection",
    ok: verdict.fits,
    text: verdict.text,
    evidence: "/usage#projection",
  };
}

/** The AU session dates between two dates (exclusive of `from`, inclusive of `to`) by the stored calendar. */
async function auSessionsBetween(db: Client, from: string, to: string): Promise<number> {
  // rows-ok: a key-range count over the AU calendar between two dates (at most a few hundred rows)
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM trading_calendar
          WHERE market = ? AND d > ? AND d <= ? AND kind IN ('session', 'early_close')`,
    args: [HOME_MARKET, from, to],
  });
  return num(r.rows[0]?.n);
}

const melbourneMinute = (iso: string): number => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: OWNER_TZ,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute); // threshold-ok: minutes per hour
};

export type NfrLine = { id: "NFR-001" | "NFR-002" | "NFR-003"; ok: boolean; text: string };

/**
 * The NFR-001…003 30-day lines of AU, read from their own records (D-1191): the completion marker by 19:45, the
 * sentinel poll success share, the Evening Review sent by 20:45. A line with no basis is open, except NFR-002 with no
 * scheduled poll (nothing could fail while the Worker's ASX poll is off).
 */
export async function nfrLines(db: Client, today: string): Promise<NfrLine[]> {
  const from = marketDate(
    new Date(Date.parse(`${today}T00:00:00Z`) - WINDOW_DAYS * 86_400_000),
    "UTC",
  );
  const out: NfrLine[] = [];
  // NFR-001
  // rows-ok: the AU sessions and markers of a 30-day window (about 22 rows each), keyed by (market, d)
  const sessions = await db.execute({
    sql: `SELECT d FROM trading_calendar WHERE market = ? AND d > ? AND d <= ? AND kind IN ('session', 'early_close')`,
    args: [HOME_MARKET, from, today],
  });
  const markers = await db.execute({
    sql: "SELECT d, at FROM completion_marker WHERE market = ? AND kind = 'data' AND d > ? AND d <= ?",
    args: [HOME_MARKET, from, today],
  });
  const onTime = new Set(
    markers.rows
      .filter((m) => melbourneMinute(String(m.at)) <= NFR1_MARKER_BY_MINUTE)
      .map((m) => String(m.d)),
  );
  const days = sessions.rows.map((s) => String(s.d));
  const hit = days.filter((d) => onTime.has(d)).length;
  const ok1 = days.length > 0 && hit * 100 >= NFR1_SHARE_PCT * days.length;
  out.push({
    id: "NFR-001",
    ok: ok1,
    text:
      days.length === 0
        ? "NFR-001: no AU trading days in the window."
        : `NFR-001: completion marker by 19:45 on ${hit} of ${days.length} trading days.`,
  });
  // NFR-002
  // rows-ok: one row per AU source per day over 30 days, by the (market, source, d) key prefix
  const polls = await db.execute({
    sql: `SELECT SUM(scheduled) AS s, SUM(ok + not_modified) AS g FROM sentinel_poll_day
          WHERE market = ? AND d > ? AND d <= ?`,
    args: [HOME_MARKET, from, today],
  });
  const sched = num(polls.rows[0]?.s);
  const good = num(polls.rows[0]?.g);
  out.push({
    id: "NFR-002",
    ok: sched === 0 || good * 100 >= NFR2_SHARE_PCT * sched,
    text:
      sched === 0
        ? "NFR-002: no poll was scheduled in the window."
        : `NFR-002: ${good} of ${sched} scheduled polls succeeded.`,
  });
  // NFR-003
  // rows-ok: review mails of a 30-day window by the primary-key range `review:<d>` (about 30 rows)
  const mails = await db.execute({
    sql: `SELECT d, sent_at FROM email_message
          WHERE email_key >= ? AND email_key <= ? AND kind = 'review' AND status = 'sent'`,
    args: [`review:${from}`, `review:${today}`],
  });
  const timely = new Set<string>();
  for (const m of mails.rows) {
    if (
      m.sent_at !== null &&
      String(m.d) > from &&
      melbourneMinute(String(m.sent_at)) <= NFR3_BY_MINUTE
    )
      timely.add(String(m.d));
  }
  out.push({
    id: "NFR-003",
    ok: timely.size >= NFR3_DAYS_REQUIRED,
    text: `NFR-003: Evening Review sent by 20:45 on ${timely.size} of the last ${WINDOW_DAYS} days.`,
  });
  return out;
}

async function auItem(db: Client, now: Date): Promise<ChecklistItem> {
  const today = marketDate(now, OWNER_TZ);
  const problems: string[] = [];
  // rows-ok: the newest AU sign-off row by idx_go_live_signoff_market
  const sign = await db.execute({
    sql: "SELECT signed_at FROM go_live_signoff WHERE market = ? ORDER BY id DESC LIMIT 1",
    args: [HOME_MARKET],
  });
  if (sign.rows.length === 0) problems.push("AU has no go-live sign-off");
  else {
    const since = marketDate(new Date(String(sign.rows[0]!.signed_at)), OWNER_TZ);
    const n = await auSessionsBetween(db, since, today);
    if (n < AU_LIVE_TRADING_DAYS)
      problems.push(`AU live ${n} of ${AU_LIVE_TRADING_DAYS} trading days`);
  }
  // rows-ok: open incidents through idx_incident_open, S1 and S2 only (a handful)
  const inc = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM incident WHERE resolved_at IS NULL AND severity IN ('S1', 'S2')",
    args: [],
  });
  const open = num(inc.rows[0]?.n);
  if (open > 0) problems.push(`${open} open S1 or S2 incident${open === 1 ? "" : "s"}`);
  for (const l of await nfrLines(db, today)) if (!l.ok) problems.push(l.text);
  const ok = problems.length === 0;
  return {
    id: "au_mkt105",
    ok,
    text: ok
      ? `AU meets MKT-105: live ${AU_LIVE_TRADING_DAYS} trading days or more, no open S1 or S2 incident, NFR-001 to NFR-003 green.`
      : `AU does not meet MKT-105 yet: ${problems.join("; ")}.`,
    evidence: "/health",
  };
}

async function greenItem(db: Client, code: string, now: Date): Promise<ChecklistItem> {
  const today = marketDate(now, OWNER_TZ);
  // rows-ok: primary-key probe of one market row
  const m = await db.execute({
    sql: "SELECT data_only_since FROM market WHERE code = ?",
    args: [code],
  });
  const since =
    m.rows[0]?.data_only_since === null || m.rows[0] === undefined
      ? null
      : String(m.rows[0].data_only_since);
  const base = { id: "five_green_days" as const, evidence: "/health" };
  if (since === null) {
    return { ...base, ok: false, text: "The market has not been in data_only mode." };
  }
  // rows-ok: the newest completed sessions of this market since data_only_since, a limit of 5 by the (market, d) key
  const cal = await db.execute({
    sql: `SELECT d FROM trading_calendar
          WHERE market = ? AND d >= ? AND d < ? AND kind IN ('session', 'early_close')
          ORDER BY d DESC LIMIT ?`,
    args: [code, since, today, GREEN_DAYS_REQUIRED],
  });
  const days = cal.rows.map((r) => String(r.d));
  if (days.length < GREEN_DAYS_REQUIRED) {
    return {
      ...base,
      ok: false,
      text: `${days.length} of ${GREEN_DAYS_REQUIRED} completed trading days since ${since} in data_only mode.`,
    };
  }
  // rows-ok: three tier rows per day for at most five days, by the (market, d, tier) key
  const q = await db.execute({
    sql: `SELECT d, COUNT(*) AS n, MIN(gate_pass) AS g FROM quality_score
          WHERE market = ? AND d >= ? AND d <= ? GROUP BY d`,
    args: [code, days[days.length - 1]!, days[0]!],
  });
  const green = new Set(
    q.rows.filter((r) => num(r.n) === 3 && num(r.g) === 1).map((r) => String(r.d)),
  );
  const bad = days.filter((d) => !green.has(d));
  return {
    ...base,
    ok: bad.length === 0,
    text:
      bad.length === 0
        ? `The last ${GREEN_DAYS_REQUIRED} trading days have a green quality verdict.`
        : `No green quality verdict on ${named([...bad].sort())}.`,
  };
}

async function latencyItem(db: Client, code: string): Promise<ChecklistItem> {
  // rows-ok: a count over the (market, d) key prefix of one market's latency samples (one a night)
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM bar_latency_sample WHERE market = ?",
    args: [code],
  });
  const n = num(r.rows[0]?.n);
  return {
    id: "latency_measured",
    ok: n >= LATENCY_SAMPLES_REQUIRED,
    text: `${n} of ${LATENCY_SAMPLES_REQUIRED} bar-latency samples measured.`,
    evidence: "/health",
  };
}

/**
 * The checklist of market `code` for its next step. `to` defaults to `data_only` for a market that is off and to
 * `full` otherwise. Throws RangeError for the home market or an unbuilt code (AU is never switched).
 */
export async function checklist(
  db: Client,
  code: string,
  now: Date,
  o: { to?: ChecklistStep; deps?: ChecklistDeps } = {},
): Promise<Checklist> {
  if (code === HOME_MARKET || !builtMarkets().includes(code)) {
    throw new RangeError(
      "the switch-on checklist is for a built market other than the home market",
    );
  }
  let to = o.to;
  if (to === undefined) {
    // rows-ok: primary-key probe of one market row
    const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [code] });
    to = m.rows.length === 1 && String(m.rows[0]!.mode) === "off" ? "data_only" : "full";
  }
  const deps = o.deps ?? {};
  const items: ChecklistItem[] = [
    await profileItem(db, code),
    await evidenceItem(db, code, deps),
    await licenceItem(db, code, deps),
    await quotaItem(db, code, now, deps),
    await (deps.au ?? auItem)(db, now),
  ];
  if (to === "full") items.push(await greenItem(db, code, now), await latencyItem(db, code));
  return { code, to, complete: items.every((i) => i.ok), items };
}
