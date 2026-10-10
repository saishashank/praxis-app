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
import type { Client, Transaction } from "@libsql/client";
import { auditTx, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";

export const THEMES = ["dark", "light", "system", "midnight", "dim", "high_contrast"] as const;
export const TIME_FORMATS = ["24h", "12h"] as const;
export const ALERT_DELIVERY = ["immediate", "digest"] as const;
// Only active markets are selectable: AU until a second market activates (ROL-107).
export const SELECTABLE_MARKETS = ["AU"] as const;

export type Theme = (typeof THEMES)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];
export type AlertDelivery = (typeof ALERT_DELIVERY)[number];

export type Preferences = {
  theme: Theme;
  default_market: (typeof SELECTABLE_MARKETS)[number];
  time_format: TimeFormat;
  alert_p1: AlertDelivery;
  alert_p2: AlertDelivery;
};

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "dark",
  default_market: "AU",
  time_format: "24h",
  alert_p1: "immediate",
  alert_p2: "digest",
});

const ALLOWED: { [K in keyof Preferences]: readonly string[] } = {
  theme: THEMES,
  default_market: SELECTABLE_MARKETS,
  time_format: TIME_FORMATS,
  alert_p1: ALERT_DELIVERY,
  alert_p2: ALERT_DELIVERY,
};
const FIELDS = Object.keys(ALLOWED) as Array<keyof Preferences>;

export type PrefError = "invalid" | "forbidden" | "unavailable";
export type PrefResult = { ok: true; changed: string[] } | { ok: false; error: PrefError };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Defaults overlaid with every stored value that is still valid; anything else keeps its default.
function merge(raw: unknown): Preferences {
  const out: Record<string, string> = { ...DEFAULT_PREFERENCES };
  if (isRecord(raw)) {
    for (const f of FIELDS) {
      const v = raw[f];
      if (typeof v === "string" && ALLOWED[f].includes(v)) out[f] = v;
    }
  }
  return out as Preferences;
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

// Whole-patch validation: any unknown key or invalid value rejects everything.
function validate(patch: unknown): Partial<Preferences> | null {
  if (!isRecord(patch)) return null;
  const clean: Record<string, string> = {};
  for (const key of Object.keys(patch)) {
    if (!(FIELDS as string[]).includes(key)) return null;
    const v = patch[key];
    if (typeof v !== "string" || !ALLOWED[key as keyof Preferences].includes(v)) return null;
    clean[key] = v;
  }
  return clean as Partial<Preferences>;
}

export async function updatePreferences(
  db: Client,
  env: AuthEnv,
  meta: RequestMeta | undefined,
  actor: { id: number },
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
    const who = await tx.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND status = 'active'",
      args: [actor.id],
    });
    if (!who.rows.length) {
      await tx.rollback();
      return { ok: false, error: "forbidden" };
    }
    const cur = await getPreferences(tx, actor.id);
    const next: Preferences = { ...cur, ...clean };
    const changed = FIELDS.filter((f) => next[f] !== cur[f]);
    if (!changed.length) {
      await tx.rollback();
      return { ok: true, changed: [] };
    }
    const at = now.toISOString();
    await tx.execute({
      sql: `INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
      args: [actor.id, JSON.stringify(next), at],
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
