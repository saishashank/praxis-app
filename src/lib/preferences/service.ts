// Personal preferences (UX-110, UXN-280, ROL-102a, DAT-150). Per-user rows in the auth DB (ROL-101a).
//
// Spec text (verbatim):
// UX-110 "Personal (all roles): theme, default market, alert display preferences (per-tier immediate
//   vs digest toggle; P0 cannot be turned off) (s11, UXP-R1-12), time format (stored as
//   user_preference; the only other Viewer write besides alert acknowledgement — ROL-102a)."
// ROL-102a row: "| Own user_preference; own alert acknowledgement | ✓ | ✓ | ✓ |" (Owner, Editor,
//   Viewer). The matrix is "server-enforced; anything not listed is Owner-only".
// UX-004 "Role-aware. Controls a role cannot use are hidden for Viewers and visible-but-disabled-
//   with-reason for Editors (s11, UXP-R2-03); all controls are refused server-side per the role ×
//   action matrix (ROL-102a). A small role badge shows the signed-in role."
// UXN-280 "App themes — Settings → Appearance MUST offer six themes: Dark (default, O-35
//   preference), Light, Match device (follows the OS setting), Midnight (true black for OLED), Dim
//   (softer blue-grey dark) and High contrast (white on black, yellow accent, ≥ 7:1 text contrast)
//   ... The choice is stored per user (server-side, so it follows the user across devices)".
// UXN-160 "... the existing rule that P0 alerts cannot be turned off (UX-110), quiet hours and
//   snooze MUST NOT suppress P0 delivery — only P1/P2."
// DAT-150 lists the entity "user_preference" (indicative name; DDL is the build agent's job).
// Default market: no MKT-* rule fixes a default; ROL-107 / D-040 say AU is the only market until a
//   second one activates, so AU is the only selectable value. Time format: no rule beyond UX-110;
//   24h is the default because the app has always shown 24 h Melbourne time.
//
// Design: P0 is not a field at all (it can never be changed, so there is nothing to store or
// accept); the page states it as fixed. Unknown fields are rejected (never ignored). The target is
// always the actor: there is no user id in the patch. A change and its audit event commit in one
// write transaction (ROL-104). Audit detail names the changed fields only, never values.
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { builtMarkets } from "@/lib/market/seed/index.mjs";
import type { Client, Transaction } from "@libsql/client";
import { auditTx, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { parseBrokerLinks, readBrokerLinks, type BrokerLink } from "./brokerTemplate";

export const THEMES = ["dark", "light", "system", "midnight", "dim", "high_contrast"] as const;
export const TIME_FORMATS = ["24h", "12h"] as const;
export const ALERT_DELIVERY = ["immediate", "digest"] as const;
// UXN-281 "Motion" switch; UXN-282 "whether times show in Melbourne or exchange-local time".
export const MOTIONS = ["on", "off"] as const;
// Usability pass 2026-11-10: "Text size" (Appearance); "large" scales every rem-based size by 125 %.
export const TEXT_SIZES = ["normal", "large"] as const;
export const TIME_ZONES = ["melbourne", "exchange"] as const;
// M17 (D-444): pick alerts and their e-mails (ARN-112, EML-038..040); the pick order (UXN-309).
export const ON_OFF = ["on", "off"] as const;
export const PICK_SORTS = ["chance", "expected_gain"] as const;
// A stored default market is any built market (the seed registry, D-1808); the Settings form offers, and the
// action accepts, only the enabled ones, and `resolveMarket` ignores a stored choice that is not enabled (D-1812).

export type Theme = (typeof THEMES)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];
export type AlertDelivery = (typeof ALERT_DELIVERY)[number];
export type Motion = (typeof MOTIONS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type TimeZoneChoice = (typeof TIME_ZONES)[number];
export type OnOff = (typeof ON_OFF)[number];
export type PickSort = (typeof PICK_SORTS)[number];

export type Preferences = {
  theme: Theme;
  default_market: string;
  time_format: TimeFormat;
  alert_p1: AlertDelivery;
  alert_p2: AlertDelivery;
  motion: Motion;
  text_size: TextSize;
  times_in: TimeZoneChoice;
  /**
   * Pick alerts (ARN-112). The role-blind default is "off"; the Owner's effective default is "on"
   * (config `pick_alerts_default_owner`, D-385) and applies while the field is not stored: only an
   * explicit choice is ever written (see PICK_FIELDS), so the alert poll can tell "never chose".
   */
  pick_alerts: OnOff;
  /** E-mail for a cleared pick (below_stop, above_chase_cap; EML-039). */
  cleared_pick_emails: OnOff;
  /** E-mail "Attention needed: new intraday candidate" (EML-040). */
  intraday_candidate_emails: OnOff;
  /** Pick order on Picks and Home; `sortPicks(rows, basis)` takes exactly these two values. */
  picks_sort: PickSort;
  /**
   * E-mail when a pick reaches its stop (EML-043, D-1226). The role-blind default here is "off"; the effective default
   * is the config key `stop_hit_email_default` while the field is not stored (see PICK_FIELDS, effectiveStopHitEmails).
   */
  stop_hit_emails: OnOff;
  /** The Owner's own capital for sizing, whole units of the home-market currency, 0 = not set (D-1217). Owner only. */
  real_capital: number;
  /** Up to five broker link templates the Owner typed (D-1218). Owner only. */
  broker_links: BrokerLink[];
};

/** Whole units of the home-market currency the Owner may enter as capital (D-1217). */
export const REAL_CAPITAL_MAX = 10_000_000; // threshold-ok: input bound of a typed amount

/** Fields that are stored only once the user chose them (their default depends on role or on config). */
export const PICK_FIELDS = [
  "pick_alerts",
  "cleared_pick_emails",
  "intraday_candidate_emails",
  "picks_sort",
  "stop_hit_emails",
] as const;

/** Structured fields have their own validators and are written by the Owner only (D-1217, D-1218). */
export const STRUCTURED_FIELDS = ["real_capital", "broker_links"] as const;
type StructuredField = (typeof STRUCTURED_FIELDS)[number];
type EnumField = Exclude<keyof Preferences, StructuredField>;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "light", // D-884: Owner 2026-11-04 "white background, navy blue" (was dark, O-35)
  default_market: HOME_MARKET,
  time_format: "24h",
  alert_p1: "immediate",
  alert_p2: "digest",
  motion: "on",
  text_size: "normal",
  times_in: "melbourne",
  pick_alerts: "off",
  cleared_pick_emails: "on",
  intraday_candidate_emails: "on",
  picks_sort: "chance",
  stop_hit_emails: "off",
  real_capital: 0,
  broker_links: [],
});

const ALLOWED: { [K in EnumField]: readonly string[] } = {
  theme: THEMES,
  default_market: builtMarkets(),
  time_format: TIME_FORMATS,
  alert_p1: ALERT_DELIVERY,
  alert_p2: ALERT_DELIVERY,
  motion: MOTIONS,
  text_size: TEXT_SIZES,
  times_in: TIME_ZONES,
  pick_alerts: ON_OFF,
  cleared_pick_emails: ON_OFF,
  intraday_candidate_emails: ON_OFF,
  picks_sort: PICK_SORTS,
  stop_hit_emails: ON_OFF,
};
const ENUM_FIELDS = Object.keys(ALLOWED) as EnumField[];
const FIELDS = [...ENUM_FIELDS, ...STRUCTURED_FIELDS] as Array<keyof Preferences>;

const isWholeCapital = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= REAL_CAPITAL_MAX;

/** The stop-hit e-mail setting in force: the stored choice, else the config default (D-1226). */
export function effectiveStopHitEmails(stored: string | null, configDefault: unknown): OnOff {
  if (stored === "on" || stored === "off") return stored;
  return configDefault === "on" ? "on" : "off";
}

export type PrefError = "invalid" | "forbidden" | "unavailable";
export type PrefResult = { ok: true; changed: string[] } | { ok: false; error: PrefError };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Defaults overlaid with every stored value that is still valid; anything else keeps its default.
function merge(raw: unknown): Preferences {
  const out: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  if (isRecord(raw)) {
    for (const f of ENUM_FIELDS) {
      const v = raw[f];
      if (typeof v === "string" && ALLOWED[f].includes(v)) out[f] = v;
    }
  }
  const o = out as unknown as Preferences;
  o.real_capital = isRecord(raw) && isWholeCapital(raw.real_capital) ? raw.real_capital : 0;
  o.broker_links = isRecord(raw) ? readBrokerLinks(raw.broker_links) : [];
  return o;
}

function parseStored(json: unknown): unknown {
  try {
    return JSON.parse(String(json));
  } catch {
    return null;
  }
}

export async function getPreferences(
  db: Pick<Client, "execute">,
  userId: number,
): Promise<Preferences> {
  const r = await db.execute({
    sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
    args: [userId],
  });
  return merge(r.rows.length ? parseStored(r.rows[0].prefs_json) : null);
}

// Quiet hours (alerts API, M5 T6) live in the same prefs_json; an update of the D-048 fields keeps them.
async function storedExtras(
  db: Pick<Client, "execute">,
  userId: number,
): Promise<Record<string, unknown>> {
  const r = await db.execute({
    sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
    args: [userId],
  });
  const v = r.rows.length ? parseStored(r.rows[0].prefs_json) : null;
  if (!isRecord(v)) return {};
  // Everything that is not one of the D-048 fields stays as stored: quiet hours, the remembered
  // Strategies sort (M7 T12) and later per-user keys.
  const keep: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!(FIELDS as string[]).includes(k)) keep[k] = v[k];
  return keep;
}

// The pick fields the user has stored explicitly (they are written only once chosen).
async function storedPickKeys(db: Pick<Client, "execute">, userId: number): Promise<Set<string>> {
  const r = await db.execute({
    sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
    args: [userId],
  });
  const v = r.rows.length ? parseStored(r.rows[0].prefs_json) : null;
  const out = new Set<string>();
  if (isRecord(v)) for (const f of [...PICK_FIELDS, ...STRUCTURED_FIELDS]) if (f in v) out.add(f);
  return out;
}

// Whole-patch validation: any unknown key or invalid value rejects everything.
function validate(patch: unknown): Partial<Preferences> | null {
  if (!isRecord(patch)) return null;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!(FIELDS as string[]).includes(key)) return null;
    const v = patch[key];
    if (key === "real_capital") {
      if (!isWholeCapital(v)) return null;
    } else if (key === "broker_links") {
      const links = parseBrokerLinks(v);
      if (links === null) return null;
      clean[key] = links;
      continue;
    } else if (typeof v !== "string" || !ALLOWED[key as EnumField].includes(v)) return null;
    clean[key] = v;
  }
  return clean as Partial<Preferences>;
}

// next without the pick fields the user never chose (their defaults must not become stored choices).
function storable(
  next: Preferences,
  clean: Partial<Preferences>,
  explicit: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  for (const f of [...PICK_FIELDS, ...STRUCTURED_FIELDS]) {
    if (!(f in clean) && !explicit.has(f)) delete out[f];
  }
  return out;
}

export async function updatePreferences(
  db: Client,
  env: AuthEnv,
  meta: RequestMeta | undefined,
  actor: { id: number; pinnedOwner?: boolean },
  patch: unknown,
  now: Date = new Date(),
): Promise<PrefResult> {
  const clean = validate(patch);
  if (!clean) return { ok: false, error: "invalid" };
  let tx: Transaction;
  try {
    tx = await db.transaction("write");
  } catch {
    return { ok: false, error: "unavailable" };
  }
  try {
    // rows-ok: app_user primary-key read
    const who = await tx.execute({
      sql: "SELECT role FROM app_user WHERE id = ? AND status = 'active'",
      args: [actor.id],
    });
    // The Owner's own tools (capital, broker templates) are for the PINNED Owner only (D-1214, D-1217, D-1218): the caller
    // passes pinnedOwner from isPinnedOwner (role owner and the pinned e-mail); any other actor is forbidden.
    const ownerOnly = (STRUCTURED_FIELDS as readonly string[]).some((f) => f in clean);
    if (
      !who.rows.length ||
      (ownerOnly && (actor.pinnedOwner !== true || String(who.rows[0]!.role) !== "owner"))
    ) {
      await tx.rollback();
      return { ok: false, error: "forbidden" };
    }
    const cur = await getPreferences(tx, actor.id);
    const keep = await storedExtras(tx, actor.id);
    const next: Preferences = { ...cur, ...clean };
    const explicit = await storedPickKeys(tx, actor.id);
    // A pick field counts as changed when it is chosen for the first time, even to its default.
    const changed = FIELDS.filter(
      (f) =>
        JSON.stringify(next[f]) !== JSON.stringify(cur[f]) ||
        (([...PICK_FIELDS, ...STRUCTURED_FIELDS] as readonly string[]).includes(f) &&
          f in clean &&
          !explicit.has(f)),
    );
    if (!changed.length) {
      await tx.rollback();
      return { ok: true, changed: [] };
    }
    const at = now.toISOString();
    await tx.execute({
      sql: `INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
      args: [actor.id, JSON.stringify({ ...keep, ...storable(next, clean, explicit) }), at],
    });
    await auditTx(tx, env, meta ?? NO_META, {
      at,
      actorUserId: actor.id,
      action: "user.preferences_update",
      targetType: "user_preference",
      targetId: String(actor.id),
      detail: { changed },
    });
    await tx.commit();
    return { ok: true, changed };
  } catch {
    try {
      await tx.rollback();
    } catch {
      // closed below either way
    }
    return { ok: false, error: "unavailable" };
  } finally {
    tx.close();
  }
}
