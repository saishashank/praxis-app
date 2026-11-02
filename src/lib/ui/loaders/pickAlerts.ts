// Pick alerts and the intraday watch on screen (M17 WP8; UXN-301..306, UXN-310, D-471..D-478).
// Reads only: the `pick_alert` / `pick_alert_mail` / `intraday_candidate` / `quote_run` rows that WP3/WP5
// wrote, plus the user's stored preferences. Everything here is shadow (design line 10): a candidate is
// "Unrated", the stream is "unvalidated". Masking (ROL-107): a masked user sees letters ("Stock A"), words
// and times, never a price, a limit or a headline.
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { formatDate, isoWeek, MISSING } from "@/lib/view/format";
import type { AlertStateName, ClearReason } from "@/lib/alerts/pick/types";
import { maskKit, marketOf, money, todayD, type LoaderEnv, type MoneyView } from "./shell";

const SESSIONS_SHOWN = 30; // threshold-ok: UXN-303 "the last 30 sessions"
const MAX_ROWS = 300; // threshold-ok: bound of the My alerts read
const MAX_CANDIDATES_READ = 60; // threshold-ok: bound of the candidate read per session

const MEL = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "14:35" in Melbourne time; MISSING when the stored value is not a time. */
export function melTime(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? MISSING : MEL.format(new Date(t));
}

const num = (v: unknown): number => Number(v); // money-float-ok: SQL integer column
const str = (v: unknown): string => String(v);

// ---- alert chips ------------------------------------------------------------------------------------

export type AlertChipView = {
  alertId: string;
  state: AlertStateName;
  /** Buy-price limit; null for a masked user. */
  limit: MoneyView | null;
  /** Hit time (Melbourne, "14:35") for state `hit`. */
  hitTime: string | null;
  reason: ClearReason | null;
  /** Session the alert was last changed in (date; ISO week when masked). */
  session: string;
};

export type PickKey = { d: string; profile: string; rank: number };
export const pickKeyText = (k: PickKey): string => `${k.d}.${k.profile}.${k.rank}`;

const CHIP_SQL = `SELECT a.alert_id, a.pick_d, a.profile, a.rank, a.state, a.limit_micro, a.at, a.quote_at,
       a.clear_reason, a.session_d, a.code
  FROM pick_alert a
  WHERE a.user_id = ? AND a.market = ?
    AND a.seq = (SELECT MAX(b.seq) FROM pick_alert b WHERE b.alert_id = a.alert_id)`;

function chipOf(x: Record<string, unknown>, masked: boolean): AlertChipView {
  const state = str(x.state) as AlertStateName;
  return {
    alertId: str(x.alert_id),
    state,
    limit: masked ? null : money(str(x.limit_micro)),
    hitTime: state === "hit" ? melTime(str(x.quote_at ?? x.at)) : null,
    reason: x.clear_reason === null ? null : (str(x.clear_reason) as ClearReason),
    session: masked ? (isoWeek(str(x.session_d)) ?? MISSING) : str(x.session_d),
  };
}

/** The current alert chip of each pick of one list date, keyed `d.profile.rank`. The user's own rows only. */
export async function loadAlertChips(
  env: LoaderEnv,
  d: string,
): Promise<Map<string, AlertChipView>> {
  const out = new Map<string, AlertChipView>();
  try {
    const r = await env.main.execute({
      sql: CHIP_SQL + " AND a.pick_d = ?",
      args: [str(env.user.id), marketOf(env), d],
    });
    for (const x of r.rows) {
      out.set(
        pickKeyText({ d: str(x.pick_d), profile: str(x.profile), rank: num(x.rank) }),
        chipOf(x, env.mask.masked),
      );
    }
  } catch {
    // The alert tables are optional for the page: no chip is better than no list.
  }
  return out;
}

/** The chip of every pick of one stock (company page header; unmasked callers only). */
export async function loadChipsForCode(
  env: LoaderEnv,
  code: string,
): Promise<Array<AlertChipView & { profile: string; pickD: string; rank: number }>> {
  try {
    const r = await env.main.execute({
      sql: CHIP_SQL + " AND a.code = ? ORDER BY a.pick_d DESC, a.profile LIMIT 5",
      args: [str(env.user.id), marketOf(env), code],
    });
    return r.rows.map((x) => ({
      ...chipOf(x, env.mask.masked),
      profile: str(x.profile),
      pickD: str(x.pick_d),
      rank: num(x.rank),
    }));
  } catch {
    return [];
  }
}

// ---- intraday watch ---------------------------------------------------------------------------------

export type IntradayRow = {
  code: string;
  /** Code, or "Stock A" for a masked user. */
  stock: string;
  company: string | null;
  foundTime: string;
  /** Plain catalyst words; the announcement title only for an unmasked user. */
  catalyst: string;
  materiality: number;
  /** Move so far, ppm of the previous close (a derived figure, shown to every role). */
  movePpm: number;
  /** Indicative limit / stop; null for a masked user or when none was computed. */
  limit: MoneyView | null;
  stop: MoneyView | null;
  /** Latest-quote time, Melbourne. */
  quoteTime: string | null;
  decisionOutcome: string | null;
  href: string | null;
};

export type IntradayModel = {
  masked: boolean;
  /** Session the rows belong to (date; ISO week when masked); null when nothing was ever found. */
  session: string | null;
  /** True when the rows are today's; false = "yesterday's" (the last session that has any). */
  today: boolean;
  /** Time of the last scan of today (Melbourne), null when none ran. */
  lastScan: string | null;
  total: number;
  rows: IntradayRow[];
  /** Candidates beyond the shown maximum ("n more"). */
  more: number;
  /** Quote delay in minutes (NFR-041 help text). */
  delayMin: number;
};

const CATEGORY_WORDS: Record<string, string> = {
  results: "Company results",
  guidance: "Guidance update",
  capital_raise: "Capital raising",
  contract: "New contract",
  takeover: "Takeover news",
  trading_halt: "Trading halt",
};
const POLARITY_WORDS: Record<string, string> = {
  positive: "good news",
  negative: "bad news",
  neutral: "mixed news",
};

export function catalystWords(category: string | null, polarity: string | null): string {
  const c = category
    ? (CATEGORY_WORDS[category] ?? "Company announcement")
    : "Company announcement";
  const p = polarity ? POLARITY_WORDS[polarity] : undefined;
  return p ? `${c}, ${p}` : c;
}

async function cfgNum(env: LoaderEnv, key: ConfigKey, def: number): Promise<number> {
  try {
    const v = await getConfig(env.main, key);
    return typeof v === "number" && Number.isFinite(v) ? v : def;
  } catch {
    return def;
  }
}

export async function loadIntraday(env: LoaderEnv): Promise<IntradayModel> {
  const market = marketOf(env);
  const masked = env.mask.masked;
  const shownMax = await cfgNum(env, "intraday_candidates_shown_max", 5);
  const delayMin = await cfgNum(env, "intraday_quote_delay_min", 20);
  const empty: IntradayModel = {
    masked,
    session: null,
    today: false,
    lastScan: null,
    total: 0,
    rows: [],
    more: 0,
    delayMin,
  };
  try {
    const today = todayD(env);
    const latest = await env.main.execute({
      sql: "SELECT MAX(session_d) AS d FROM intraday_candidate WHERE market = ? AND session_d <= ?",
      args: [market, today],
    });
    const scan = await env.main.execute({
      sql: "SELECT MAX(started_at) AS t FROM quote_run WHERE market = ? AND session_d = ? AND purpose = 'scan'",
      args: [market, today],
    });
    const lastScan = scan.rows[0]?.t ? melTime(str(scan.rows[0].t)) : null;
    const d = latest.rows[0]?.d ? str(latest.rows[0].d) : null;
    if (d === null) return { ...empty, today: true, lastScan };
    const r = await env.main.execute({
      sql: `SELECT c.code, c.found_at, c.item_category, c.polarity, c.materiality, c.move_ppm, c.sector_adj_ppm,
                   c.indicative_limit_micro, c.indicative_stop_micro, c.latest_quote_at, c.decision_outcome,
                   i.name, (SELECT a.title FROM announcement a WHERE a.source = c.item_source
                     AND a.ann_id = c.item_ann_id LIMIT 1) AS title
            FROM intraday_candidate c LEFT JOIN instrument i ON i.market = c.market AND i.code = c.code
            WHERE c.market = ? AND c.session_d = ?
            ORDER BY c.materiality DESC, COALESCE(c.sector_adj_ppm, c.move_ppm) DESC, c.code
            LIMIT ?`,
      args: [market, d, MAX_CANDIDATES_READ],
    });
    const kit = masked
      ? await maskKit(
          env,
          d,
          r.rows.map((x) => str(x.code)),
        )
      : null;
    const rows: IntradayRow[] = r.rows.map((x) => {
      const code = str(x.code);
      const words = catalystWords(
        x.item_category === null ? null : str(x.item_category),
        x.polarity === null ? null : str(x.polarity),
      );
      const title = !masked && x.title !== null ? str(x.title) : null;
      return {
        code,
        stock: kit ? kit.aliases.label(code) : code,
        company: masked || x.name === null ? null : str(x.name),
        foundTime: melTime(str(x.found_at)),
        catalyst: title ? `${words}: ${title}` : words,
        materiality: num(x.materiality),
        movePpm: num(x.move_ppm),
        limit:
          masked || x.indicative_limit_micro === null ? null : money(str(x.indicative_limit_micro)),
        stop:
          masked || x.indicative_stop_micro === null ? null : money(str(x.indicative_stop_micro)),
        quoteTime: x.latest_quote_at === null ? null : melTime(str(x.latest_quote_at)),
        decisionOutcome: x.decision_outcome === null ? null : str(x.decision_outcome),
        href: masked ? null : `/market/${encodeURIComponent(code)}`,
      };
    });
    return {
      masked,
      session: masked ? (isoWeek(d) ?? MISSING) : d,
      today: d === today,
      lastScan,
      total: rows.length,
      rows: rows.slice(0, shownMax),
      more: Math.max(0, rows.length - shownMax),
      delayMin,
    };
  } catch {
    return empty;
  }
}

/** The candidate of one stock in the latest session (company page header; unmasked callers only). */
export async function loadCandidateForCode(
  env: LoaderEnv,
  code: string,
): Promise<{ session: string; foundTime: string; catalyst: string } | null> {
  try {
    const r = await env.main.execute({
      sql: `SELECT c.session_d, c.found_at, c.item_category, c.polarity,
                   (SELECT a.title FROM announcement a WHERE a.source = c.item_source
                     AND a.ann_id = c.item_ann_id LIMIT 1) AS title
            FROM intraday_candidate c WHERE c.market = ? AND c.code = ? AND c.session_d <= ?
            ORDER BY c.session_d DESC LIMIT 1`,
      args: [marketOf(env), code, todayD(env)],
    });
    const x = r.rows[0];
    if (!x) return null;
    const words = catalystWords(
      x.item_category === null ? null : str(x.item_category),
      x.polarity === null ? null : str(x.polarity),
    );
    const title = x.title === null ? null : str(x.title);
    return {
      session: str(x.session_d),
      foundTime: melTime(str(x.found_at)),
      catalyst: title ? `${words}: ${title}` : words,
    };
  } catch {
    return null;
  }
}

// ---- Home rows --------------------------------------------------------------------------------------

export type AlertHomeFacts = {
  /** Hits among the user's alerts in the last two calendar days. */
  hits: number;
  /** Candidates found in the latest session. */
  candidates: number;
  /** Candidates whose e-mail the daily cap suppressed (UXN-305): they appear in "Needs you". */
  suppressed: number;
};

export async function loadAlertHomeFacts(
  env: LoaderEnv,
  sinceIso: string,
): Promise<AlertHomeFacts> {
  const out: AlertHomeFacts = { hits: 0, candidates: 0, suppressed: 0 };
  try {
    const market = marketOf(env);
    const hits = await env.main.execute({
      sql: "SELECT COUNT(DISTINCT alert_id) AS n FROM pick_alert WHERE user_id = ? AND market = ? AND state = 'hit' AND at >= ?",
      args: [str(env.user.id), market, sinceIso],
    });
    out.hits = num(hits.rows[0]?.n ?? 0);
    const d = (
      await env.main.execute({
        sql: "SELECT MAX(session_d) AS d FROM intraday_candidate WHERE market = ? AND session_d <= ?",
        args: [market, todayD(env)],
      })
    ).rows[0]?.d;
    if (d) {
      const c = await env.main.execute({
        sql: "SELECT COUNT(*) AS n FROM intraday_candidate WHERE market = ? AND session_d = ?",
        args: [market, str(d)],
      });
      out.candidates = num(c.rows[0]?.n ?? 0);
      const s = await env.main.execute({
        sql: `SELECT COUNT(DISTINCT m.alert_id) AS n FROM pick_alert_mail m
              WHERE m.alert_id LIKE ? AND m.status = 'suppressed_cap'`,
        args: [`cand:${market}:${str(d)}:%`],
      });
      out.suppressed = num(s.rows[0]?.n ?? 0);
    }
  } catch {
    // keep the zeros
  }
  return out;
}

// ---- My alerts ---------------------------------------------------------------------------------------

export type MailStatus = "sent" | "batched" | "suppressed" | "held" | "off" | "none";

export type MyAlertRow = {
  alertId: string;
  stock: string;
  profile: string;
  rank: number;
  pickDate: string;
  state: AlertStateName;
  reason: ClearReason | null;
  limit: MoneyView | null;
  hitTime: string | null;
  session: string;
  mail: MailStatus;
  /** Only an armed alert can be muted. */
  canMute: boolean;
};

export type MyAlertsModel = {
  masked: boolean;
  /** Effective "alerts for all picks" value for this user. */
  alertsOn: boolean;
  rows: MyAlertRow[];
};

const MAIL_WORD: Record<string, MailStatus> = {
  sent: "sent",
  batched: "batched",
  suppressed_cap: "suppressed",
  held: "held",
  held_to_review: "held",
  off: "off",
};

/** Raw stored preferences of the signed-in user (no defaults applied). */
async function storedPrefs(env: LoaderEnv): Promise<Record<string, unknown>> {
  const r = await env.auth.execute({
    sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
    args: [env.user.id],
  });
  if (!r.rows.length || r.rows[0].prefs_json === null) return {};
  try {
    const v: unknown = JSON.parse(str(r.rows[0].prefs_json));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export type AlertSettingsModel = {
  /** Effective values: the stored choice, else what `sendPickMail` / the poll would apply (D-472). */
  pickAlerts: "on" | "off";
  clearedEmails: "on" | "off";
  candidateEmails: "on" | "off";
  picksSort: "chance" | "expected_gain";
  /** True while the user never chose `pick_alerts` (the default applies). */
  alertsIsDefault: boolean;
  dailyCap: number | null;
  quietStart: string | null;
  quietEnd: string | null;
};

/**
 * The effective alert settings. Mirrors `readPrefs` of `src/lib/email/pickMail.ts` and `alertRecipients`:
 * `pick_alerts` stored "on"/"off" wins, else the Owner is on when config `pick_alerts_default_owner` is on and
 * every other role is off; the two e-mail switches are on unless stored "off". `getPreferences` cannot be
 * used: it returns the role-blind "off" for the Owner who never chose.
 */
export async function loadAlertSettings(env: LoaderEnv): Promise<AlertSettingsModel> {
  const v = await storedPrefs(env).catch(() => ({}) as Record<string, unknown>);
  let ownerOn = false;
  try {
    ownerOn = str(await getConfig(env.main, "pick_alerts_default_owner")) === "on";
  } catch {
    ownerOn = false;
  }
  const stored = v.pick_alerts === "on" || v.pick_alerts === "off" ? v.pick_alerts : null;
  const pickAlerts = stored ?? (env.user.role === "owner" && ownerOn ? "on" : "off");
  const q = v.quiet_hours;
  const qo = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : {};
  const cap = await cfgNum(env, "pick_alert_emails_per_day", -1);
  return {
    pickAlerts,
    clearedEmails: v.cleared_pick_emails === "off" ? "off" : "on",
    candidateEmails: v.intraday_candidate_emails === "off" ? "off" : "on",
    picksSort: v.picks_sort === "expected_gain" ? "expected_gain" : "chance",
    alertsIsDefault: stored === null,
    dailyCap: cap < 0 ? null : cap,
    quietStart: typeof qo.start === "string" ? qo.start : null,
    quietEnd: typeof qo.end === "string" ? qo.end : null,
  };
}

/** The user's stored pick order (UXN-309); default chance. */
export async function loadPicksSort(env: LoaderEnv): Promise<"chance" | "expected_gain"> {
  const v = await storedPrefs(env).catch(() => ({}) as Record<string, unknown>);
  return v.picks_sort === "expected_gain" ? "expected_gain" : "chance";
}

export async function loadMyAlerts(env: LoaderEnv): Promise<MyAlertsModel> {
  const masked = env.mask.masked;
  const settings = await loadAlertSettings(env);
  const base: MyAlertsModel = { masked, alertsOn: settings.pickAlerts === "on", rows: [] };
  try {
    const market = marketOf(env);
    const r = await env.main.execute({
      sql: `${CHIP_SQL}
              AND a.session_d IN (SELECT DISTINCT session_d FROM pick_alert WHERE user_id = ? AND market = ?
                                  ORDER BY session_d DESC LIMIT ?)
            ORDER BY a.session_d DESC, a.profile, a.rank LIMIT ?`,
      args: [str(env.user.id), market, str(env.user.id), market, SESSIONS_SHOWN, MAX_ROWS],
    });
    const ids = r.rows.map((x) => str(x.alert_id));
    const mail = new Map<string, MailStatus>();
    for (const id of ids) {
      const m = await env.main.execute({
        sql: "SELECT status FROM pick_alert_mail WHERE alert_id = ? ORDER BY id DESC LIMIT 1",
        args: [id],
      });
      mail.set(id, m.rows[0] ? (MAIL_WORD[str(m.rows[0].status)] ?? "none") : "none");
    }
    const kit = masked
      ? await maskKit(
          env,
          null,
          r.rows.map((x) => str(x.code)),
        )
      : null;
    const rows: MyAlertRow[] = r.rows.map((x) => {
      const chip = chipOf(x, masked);
      const code = str(x.code);
      return {
        alertId: chip.alertId,
        stock: kit ? kit.aliases.label(code) : code,
        profile: str(x.profile),
        rank: num(x.rank),
        pickDate: masked ? (isoWeek(str(x.pick_d)) ?? MISSING) : formatDate(str(x.pick_d)),
        state: chip.state,
        reason: chip.reason,
        limit: chip.limit,
        hitTime: chip.hitTime,
        session: chip.session,
        mail: mail.get(chip.alertId) ?? "none",
        canMute: chip.state === "armed",
      };
    });
    return { ...base, rows };
  } catch {
    return base;
  }
}
