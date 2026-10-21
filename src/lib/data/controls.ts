// Owner data controls (M2 T10): the switches that turn on production dispatch and contact with
// outside sources. HIGH-RISK: Owner-only, audit-first. Opus reviews every line.
//
// Spec text this file implements (verbatim; file:line in the private spec v1, found with grep -n;
// docs/M2_design.md is in this repo):
//  - 12_build_plan.md:62 BLD-024 (s9): "Production data-only mode from M2. From M2 the production
//    deployment runs the real nightly data pipeline and universe snapshots (DAT-130) with the
//    Arena, emails and decision agents (A2–A8) disabled — the A1 Sentinel polling and the DAT-125
//    backfill do run — so real-data days accumulate and quotas are measured on production; staging
//    never calls ASX/Yahoo (DAT-122, NFR-040) and uses recorded fixtures."
//  - 02_platform_hosting_auth.md:104 PLT-074 (s9): "Heartbeat routes are GET (Vercel Cron)
//    authenticated with `CRON_SECRET`, idempotent, and **no-op outside the production
//    environment** (staging never raises heartbeat incidents)." (the routes are in
//    src/lib/heartbeat/handler.ts; the morning check "tests the Worker's last successful poll",
//    the evening check "the Worker's last poll, today's completion marker and email record (email
//    checks skipped for markets in data-only mode)")
//  - 02_platform_hosting_auth.md:29 PLT-018: "the Sentinel MUST implement its own retry with
//    backoff and a "Sentinel blind" alert (email via Chapter 04) when no successful poll occurs
//    for 15 minutes during MAP hours."
//  - 15_configuration_reference.md:156-157: "| sentinel_blind_alert | 15 min | O | PLT-018 |" and
//    "| heartbeat_crons | Vercel Cron in the 00:xx and 11:xx UTC hours (fires anywhere in the hour;
//    production only; wording PLT-011) | O | PLT-074 |"
//  - market_mode: docs/M2_design.md section 6 decision 3 and D-057 #3: "Data-only switch: new
//    config key `market_mode` (`off` | `data_only` | `full`, per market; production AU starts
//    `data_only` for BLD-024)."
//  - 00_README_and_progress.md:55 O-23: "ASX announcements: accept the risk of automated
//    personal-use access; owner will seek confirmation from ASX in parallel" (2026-09-24)
//  - 00_README_and_progress.md:58 O-26: "Accept the risk of automated personal-use access to
//    Yahoo Finance EOD data (kill switch; keep looking for a cleaner free source)" (2026-09-24)
//  - 06_data_layer.md:66 DAT-120: "Per source: terms URL, permitted use, rate limits, last-checked
//    date, risk rating, status (`enabled` / `disabled` / `owner-accepted-risk` with O-n
//    reference). A source whose terms forbid the intended use is disabled unless an Owner risk
//    acceptance is recorded (currently O-23 ASX, O-26 Yahoo)."
//  - 13_review_errata_and_addenda.md:149 DAT-123: "A single configuration switch MUST turn ASX
//    fetching off instantly (e.g. if ASX objects or blocks), after which the Sentinel continues on
//    other sources and the Evening Review states that ASX feed is off." (06_data_layer.md:69:
//    "Kill switch per source: off within one cycle")
//    The reset of a tripped source by the Owner is `resetAsxTrip` (asxToken.ts), wired to a
//    button by the System Health page.
//  - 14_system_acceptance.md:12 AT-05 (what it needs here): "with the Worker stopped, the Vercel
//    Cron heartbeat raises an incident ... heartbeats no-op on staging"
//  - docs/M2_design.md T10 row: "Data-only mode, heartbeat routes, watchdog, DAT-101 report,
//    "M2 data start:" PR | `src/lib/config/keys.ts`, `src/app/api/cron/heartbeat/route.ts`, ..."
//
// Source of truth for the market mode: the `market.mode` column. The Worker (clock.ts, asx/slots.ts)
// and the Batch 1 pipeline read it on every run, and one request each is all their CPU budget
// allows. The versioned `market_mode` config value is the history of Owner changes; setMarketMode
// writes BOTH in ONE main-DB transaction, after the audit event. System Health shows "out of
// sync" if the two ever differ.
//
// Atomicity (two databases, so no single transaction; the D-047 / calendarAdmin.ts pattern): the
// audit event (auth DB) is appended FIRST. If that fails nothing has changed. Only then is the
// main-DB change written in ONE write transaction; if that fails, a compensating `<action>_failed`
// event is appended (best effort). A change never exists without an audit row. A request that
// would change nothing writes nothing and appends no event (idempotent).
//
// What these switches do NOT do: set `ASX_LIVE` or `ASX_USER_AGENT` (Worker variables the Owner
// sets in Cloudflare; the Worker does not report them, so the page says "not known"), clear a
// tripped ASX source (that is the separate reset button), or make `full` selectable (M3).
import type { Client, Transaction } from "@libsql/client";
import { addDays, marketDate } from "@/lib/data/calendar";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { UNIVERSE_SOURCE } from "@/lib/data/schema";
import {
  CONFIG_KEYS,
  MODE_MARKETS,
  SELECTABLE_MODES,
  validateMarketModes,
} from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { anyMarketFull, fullModeRefusal, isProductionEnv } from "@/lib/golive/interlock";
import {
  EMAIL_MODE_KEY,
  EMAIL_MODES,
  EMAIL_REVIEW_TEST_DATE_KEY,
  isRealDate,
  readEmailSwitch,
  type EmailMode,
} from "@/lib/email/switch";
import type { AttentionItem } from "@/lib/health/attention";
import {
  ATTENTION_SNOOZE_DB_MAX_DAYS,
  CREDENTIAL_NAMES,
  CREDENTIAL_NAME_LIST,
  HEALTH_COMPONENTS,
  WATCH_LIST_MAX_DAYS,
  type CredentialName,
  type HealthComponent,
} from "@/lib/sentinel/schema";

export const DISPATCH_ENABLED_KEY = "dispatch_enabled";
export const ASX_ENABLED_KEY = "asx_enabled";
export const ASX_SOURCE_ID = "asx_announcements";
export const YAHOO_SOURCE_ID = "yahoo_eod";
export const MARKET_MODE_KEY = "market_mode";

/** The sources whose use needs an Owner risk acceptance (DAT-120). Nothing else can be switched. */
export const SOURCE_CONTROLS = {
  [ASX_SOURCE_ID]: {
    ref: "O-23",
    label: "ASX announcements",
    riskText:
      "ASX's website terms prohibit robots and scrapers and limit announcements to private " +
      "personal use. By accepting you take on the risk of automated personal-use access " +
      "(decision O-23): one polite client, at least 65 seconds between requests, at most 720 a " +
      "day, headlines and links only. ASX may object or block access at any time. You are asking " +
      "ASX for written confirmation in parallel; record the answer when it arrives. A kill " +
      "switch stops the contact at once.",
  },
  [YAHOO_SOURCE_ID]: {
    ref: "O-26",
    label: "Yahoo Finance end-of-day prices",
    riskText:
      "Yahoo Finance data is unofficial, meant for personal use and rate-limited. Its terms may " +
      "not permit automated access. By accepting you take on the risk of automated personal-use " +
      "access (decision O-26): the data may be wrong, change shape or be blocked without notice. " +
      "A kill switch stops it, and the build keeps looking for a cleaner free source.",
  },
} as const;
export type ControlSource = keyof typeof SOURCE_CONTROLS;
const isControlSource = (s: unknown): s is ControlSource =>
  typeof s === "string" && Object.prototype.hasOwnProperty.call(SOURCE_CONTROLS, s);

export type SourceStatus = "pending" | "enabled" | "disabled";

export type ControlError =
  | "forbidden"
  | "invalid"
  | "risk_not_acknowledged"
  | "source_pending"
  | "calendar_unconfirmed"
  | "not_available"
  | "data_only_market"
  | "email_mode_required"
  | "signoff_required"
  | "email_off"
  | "market_full"
  | "confirm_required"
  | "items_missing"
  | "commit_unknown"
  | "unknown_code"
  | "already_listed"
  | "item_not_found"
  | "snooze_red"
  | "snooze_deadline"
  | "unavailable";
export type ControlResult = { ok: true; changed: boolean } | { ok: false; error: ControlError };

export type ControlBase = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  now?: Date;
};

export const fail = (error: ControlError): ControlResult => ({ ok: false, error });
export const NOOP: ControlResult = { ok: true, changed: false };

/** A condition re-checked inside the write transaction failed (a race with another change). */
export class Precondition extends Error {
  constructor(readonly code: ControlError) {
    super(code);
  }
}

// ---- shared pieces ----------------------------------------------------------------------------

/** "1" (string, number or boolean true) is on; anything else, or absence, is off. */
export function parseOn(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const v: unknown = JSON.parse(raw);
    return v === "1" || v === 1 || v === true;
  } catch {
    return false;
  }
}

const onValue = (on: boolean): string => JSON.stringify(on ? "1" : "0");

type Exec = Pick<Client, "execute"> | Pick<Transaction, "execute">;

async function readSwitch(db: Exec, key: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = ?",
    args: [key],
  });
  return r.rows.length === 1 ? parseOn(r.rows[0].value_json) : false;
}

async function writeSwitch(tx: Transaction, key: string, on: boolean, now: string): Promise<void> {
  await tx.execute({
    sql:
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, " +
      "updated_at = excluded.updated_at",
    args: [key, onValue(on), now],
  });
}

async function readRegisterStatus(db: Exec, source: string): Promise<SourceStatus | null> {
  const r = await db.execute({
    sql: "SELECT status FROM source_register WHERE source = ?",
    args: [source],
  });
  const s = r.rows[0]?.status;
  return s === "pending" || s === "enabled" || s === "disabled" ? s : null;
}

/** True when the AU calendar for the current Sydney year has rows and none is unconfirmed. */
async function calendarConfirmed(db: Exec, now: string): Promise<boolean> {
  const year = marketDate(new Date(now), "Australia/Sydney").slice(0, 4);
  const r = await db.execute({
    sql:
      "SELECT COUNT(*) AS total, COALESCE(SUM(confirmed = 0), 0) AS open FROM trading_calendar " +
      "WHERE market = 'AU' AND d >= ? AND d <= ?",
    args: [`${year}-01-01`, `${year}-12-31`],
  });
  return Number(r.rows[0].total) > 0 && Number(r.rows[0].open) === 0;
}

/** Defence in depth: the caller passed requireUser("admin"); the actor must be the active Owner. */
export async function ownerCheck(authDb: Client, actorId: number): Promise<ControlError | null> {
  try {
    const r = await authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [actorId],
    });
    return r.rows.length === 1 ? null : "forbidden";
  } catch {
    return "unavailable";
  }
}

export type Step = {
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  apply: (tx: Transaction, auditRef: string) => Promise<void>;
};

/** Audit first, then ONE main-DB write transaction, then a `_failed` event if that fails. */
export async function commit(p: ControlBase, now: string, step: Step): Promise<ControlResult> {
  const meta = p.meta ?? NO_META;
  const base = {
    at: now,
    actorUserId: p.actorId,
    targetType: step.targetType,
    targetId: step.targetId,
  };
  let auditId: number;
  try {
    auditId = await audit(p.authDb, p.env, meta, {
      ...base,
      action: step.action,
      detail: step.detail,
    });
  } catch {
    return fail("unavailable"); // nothing has changed
  }
  let tx: Transaction | undefined;
  try {
    tx = await p.mainDb.transaction("write");
    await step.apply(tx, `audit:${auditId}`);
    await tx.commit();
    return { ok: true, changed: true };
  } catch (e) {
    try {
      await audit(p.authDb, p.env, meta, {
        ...base,
        action: `${step.action}_failed`,
        detail: step.detail,
      });
    } catch {
      // best effort: the change did not happen either way
    }
    return fail(e instanceof Precondition ? e.code : "unavailable");
  } finally {
    tx?.close(); // rolls back anything not committed
  }
}

// ---- a. dispatch switch -----------------------------------------------------------------------

export type SwitchInput = ControlBase & { enabled: unknown };

/**
 * Production dispatch switch (`worker_state.dispatch_enabled`). Turning it ON starts the nightly
 * jobs, including Batch 1 which reads Yahoo, so it is refused while O-26 is not accepted
 * (DAT-120) and while the AU trading calendar of the current Sydney year is not fully confirmed
 * (DAT-160). Turning it off is always allowed.
 */
export async function setDispatchEnabled(p: SwitchInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.enabled !== "boolean") return fail("invalid");
  const to = p.enabled;
  try {
    const from = await readSwitch(p.mainDb, DISPATCH_ENABLED_KEY);
    if (from === to) return NOOP;
    if (to && (await readRegisterStatus(p.mainDb, YAHOO_SOURCE_ID)) !== "enabled") {
      return fail("source_pending");
    }
    if (to && !(await calendarConfirmed(p.mainDb, now))) return fail("calendar_unconfirmed");
    return await commit(p, now, {
      action: "controls.dispatch_enabled",
      targetType: "control",
      targetId: DISPATCH_ENABLED_KEY,
      detail: { from, to },
      apply: async (tx) => {
        if (to && (await readRegisterStatus(tx, YAHOO_SOURCE_ID)) !== "enabled") {
          throw new Precondition("source_pending");
        }
        if (to && !(await calendarConfirmed(tx, now)))
          throw new Precondition("calendar_unconfirmed");
        await writeSwitch(tx, DISPATCH_ENABLED_KEY, to, now);
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- b. ASX contact switch --------------------------------------------------------------------

/**
 * ASX contact switch (`worker_state.asx_enabled`, DAT-123). ON only while the source register
 * holds `enabled` for ASX (O-23 accepted). The Worker also needs ASX_LIVE=1 and ASX_USER_AGENT.
 */
export async function setAsxEnabled(p: SwitchInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.enabled !== "boolean") return fail("invalid");
  const to = p.enabled;
  try {
    const from = await readSwitch(p.mainDb, ASX_ENABLED_KEY);
    if (from === to) return NOOP;
    if (to && (await readRegisterStatus(p.mainDb, ASX_SOURCE_ID)) !== "enabled") {
      return fail("source_pending");
    }
    return await commit(p, now, {
      action: "controls.asx_enabled",
      targetType: "control",
      targetId: ASX_ENABLED_KEY,
      detail: { from, to },
      apply: async (tx) => {
        if (to && (await readRegisterStatus(tx, ASX_SOURCE_ID)) !== "enabled") {
          throw new Precondition("source_pending");
        }
        await writeSwitch(tx, ASX_ENABLED_KEY, to, now);
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- c. source risk acceptance ----------------------------------------------------------------

export type SourceInput = ControlBase & {
  source: unknown;
  /** true = accept the risk (enable), false = disable. */
  accept: unknown;
  /** The Owner ticked the box next to the exact risk text. Required to accept. */
  acknowledged?: unknown;
};

/**
 * Records the Owner's acceptance of a source's risk (O-23 / O-26): `source_register.status`
 * pending|disabled -> enabled; the register's history trigger logs the change. The reverse
 * disables it, sets its kill switch off in `source_status` and, for ASX, `asx_enabled` to off in
 * the same transaction (disabling a source must stop contact).
 */
export async function setSourceAccepted(p: SourceInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (!isControlSource(p.source) || typeof p.accept !== "boolean") return fail("invalid");
  const source = p.source;
  const accept = p.accept;
  if (accept && p.acknowledged !== true) return fail("risk_not_acknowledged");
  const def = SOURCE_CONTROLS[source];
  try {
    const from = await readRegisterStatus(p.mainDb, source);
    if (from === null) return fail("invalid");
    if (accept ? from === "enabled" : from === "disabled") return NOOP;
    return await commit(p, now, {
      action: accept ? "controls.source_accept" : "controls.source_disable",
      targetType: "source",
      targetId: source,
      detail: accept
        ? { source, ref: def.ref, from, to: "enabled", riskText: def.riskText }
        : { source, ref: def.ref, from, to: "disabled" },
      apply: async (tx) => {
        if (accept) {
          await tx.execute({
            sql:
              "UPDATE source_register SET status = 'enabled' " +
              "WHERE source = ? AND status IN ('pending', 'disabled')",
            args: [source],
          });
          // D-067: the ASX listed-companies file is covered by the same O-23 acceptance.
          if (source === ASX_SOURCE_ID) {
            await tx.execute({
              sql:
                "UPDATE source_register SET status = 'enabled' " +
                "WHERE source = ? AND status IN ('pending', 'disabled')",
              args: [UNIVERSE_SOURCE],
            });
          }
          // An Owner-set `off` is lifted; a `tripped` source stays tripped until it is reset.
          await tx.execute({
            sql:
              "UPDATE source_status SET mode = 'on', since = ?, reason = NULL, tripped_by = NULL " +
              "WHERE source = ? AND mode = 'off'",
            args: [now, source],
          });
          return;
        }
        await tx.execute({
          sql: "UPDATE source_register SET status = 'disabled' WHERE source = ? AND status != 'disabled'",
          args: [source],
        });
        await tx.execute({
          sql:
            "UPDATE source_status SET mode = 'off', since = ?, reason = 'owner_disabled', " +
            "tripped_by = NULL WHERE source = ? AND mode != 'off'",
          args: [now, source],
        });
        if (source === ASX_SOURCE_ID) {
          await tx.execute({
            sql: "UPDATE source_register SET status = 'disabled' WHERE source = ? AND status != 'disabled'",
            args: [UNIVERSE_SOURCE],
          });
          await writeSwitch(tx, ASX_ENABLED_KEY, false, now);
        }
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- d. market mode ---------------------------------------------------------------------------

export type MarketModeInput = ControlBase & { market: unknown; mode: unknown };

type ModeMap = Record<string, unknown>;

const isModeMap = (v: unknown): v is ModeMap =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readConfigModes(db: Exec): Promise<{ raw: string | null; map: ModeMap }> {
  const r = await db.execute({
    sql:
      "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' " +
      "ORDER BY id DESC LIMIT 1",
    args: [MARKET_MODE_KEY],
  });
  const raw = r.rows.length ? String(r.rows[0].value_json) : null;
  let parsed: unknown = CONFIG_KEYS.market_mode.default;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  return { raw, map: isModeMap(parsed) ? parsed : {} };
}

/**
 * Sets a market's mode to `off`, `data_only` or `full`. In production `full` is refused with
 * `signoff_required` (no go_live_signoff row) or `email_off` (email_mode is off), before any audit
 * row and again inside the write transaction (M8 T11, decision 33); staging is free. Writes the versioned
 * `market_mode` config value AND `market.mode` in one transaction (see the header).
 */
export async function setMarketMode(p: MarketModeInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.market !== "string" || !(MODE_MARKETS as readonly string[]).includes(p.market)) {
    return fail("invalid");
  }
  if (typeof p.mode !== "string" || !(SELECTABLE_MODES as readonly string[]).includes(p.mode)) {
    return fail("invalid");
  }
  const market = p.market;
  const to = p.mode;
  try {
    const row = await p.mainDb.execute({
      sql: "SELECT mode FROM market WHERE code = ?",
      args: [market],
    });
    if (row.rows.length !== 1) return fail("invalid");
    const columnMode = String(row.rows[0].mode);
    const { map } = await readConfigModes(p.mainDb);
    if (columnMode === to && map[market] === to) return NOOP;
    const today = localDay(now);
    if (to === "full") {
      const refused = await fullModeRefusal(p.mainDb, p.env, market, today);
      if (refused !== null) return fail(refused);
    }
    return await commit(p, now, {
      action: "controls.market_mode",
      targetType: "market",
      targetId: market,
      detail: { market, from: columnMode, to },
      apply: async (tx) => {
        if (to === "full") {
          const refused = await fullModeRefusal(tx, p.env, market, today);
          if (refused !== null) throw new Precondition(refused);
        }
        const cur = await readConfigModes(tx);
        const next = { ...cur.map, [market]: to };
        if (validateMarketModes(next) !== null) throw new Precondition("invalid");
        await tx.execute({
          sql:
            "INSERT INTO config_version (key, scope, value_json, previous_json, " +
            "changed_by_user_id, changed_at, reason) VALUES (?, 'global', ?, ?, ?, ?, ?)",
          args: [
            MARKET_MODE_KEY,
            JSON.stringify(next),
            cur.raw,
            p.actorId,
            now,
            "Data controls (System Health)",
          ],
        });
        await tx.execute({ sql: "UPDATE market SET mode = ? WHERE code = ?", args: [to, market] });
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- e. M5 email and alert controls (docs/M5_design.md 4.12, 4.7, 3; D-096, D-097) ---------------
//
// Same rules as above: Owner only, audit event first, one main-DB write transaction, a `_failed`
// event if that fails, and a request that changes nothing writes nothing. The confirmation step is
// in the form (DataControlForm). Spec text these implement:
//  - 04_email_and_notifications.md EML-023 (s13): the attention reminder is one email a day; the
//    Owner can snooze an item; (design 4.7) "red items and items within 2 days of a deadline cannot
//    be snoozed - the snooze action refuses them".
//  - 06 AGT-014: "Watch-list = ... Owner-added codes (Owner only, with expiry <= 90 days)".
//  - 02 PLT-074 / 10 NFR-006: token expiry dates per SEC-017; one combined "tokens due" email at
//    14, 7 and 2 days. Only the secret NAME and the date are stored, never a value (EML-005).
//  - 12 BLD-024: emails stay off in production data-only mode (the `email_mode` switch).

const MELBOURNE = "Australia/Melbourne";
const localDay = (nowIso: string): string => marketDate(new Date(nowIso), MELBOURNE);
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );

/** Longest one-off review test date ahead of today (D-097). */
export const REVIEW_TEST_DATE_MAX_AHEAD_DAYS = 31;
/** Largest distance ahead of today a credential expiry may be entered (D-097: about five years). */
export const CREDENTIAL_EXPIRY_MAX_AHEAD_DAYS = 1830;
/** An attention item this close to its deadline (or past it) cannot be snoozed (EML-023). */
export const SNOOZE_DEADLINE_GUARD_DAYS = 2;

/** Registry default of attention_snooze_max_days (ch.15 l.198). */
const DEFAULT_SNOOZE_MAX_DAYS = 7;
const WATCH_CODE_RE = /^[A-Z0-9]{2,6}$/;
const ITEM_KEY_RE = /^[a-z0-9_.:-]{1,80}$/;

async function writeText(tx: Transaction, key: string, value: string, now: string): Promise<void> {
  await tx.execute({
    sql:
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, " +
      "updated_at = excluded.updated_at",
    args: [key, JSON.stringify(value), now],
  });
}

async function anyMarketDataOnly(db: Exec): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM market WHERE mode = 'data_only'",
    args: [],
  });
  return Number(r.rows[0].n) > 0;
}

export type EmailModeInput = ControlBase & { mode: unknown };

/**
 * Production email switch (`worker_state.email_mode`): off | incidents | full. `full` is refused
 * while any market is data-only (BLD-024: until go-live). Leaving `incidents` also clears the
 * one-off review test date in the same transaction, so a stale date can never re-arm the review.
 */
export async function setEmailMode(p: EmailModeInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.mode !== "string" || !(EMAIL_MODES as readonly string[]).includes(p.mode)) {
    return fail("invalid");
  }
  const to = p.mode as EmailMode;
  try {
    const cur = await readEmailSwitch(p.mainDb, localDay(now));
    if (cur.mode === to) return NOOP;
    if (to === "full" && (await anyMarketDataOnly(p.mainDb))) return fail("data_only_market");
    const guardOff = to === "off" && isProductionEnv(p.env);
    if (guardOff && (await anyMarketFull(p.mainDb))) return fail("market_full");
    return await commit(p, now, {
      action: "controls.email_mode",
      targetType: "control",
      targetId: EMAIL_MODE_KEY,
      detail: { from: cur.mode, to, clearsReviewTestDate: to !== "incidents" },
      apply: async (tx) => {
        if (to === "full" && (await anyMarketDataOnly(tx))) {
          throw new Precondition("data_only_market");
        }
        if (guardOff && (await anyMarketFull(tx))) throw new Precondition("market_full");
        await writeText(tx, EMAIL_MODE_KEY, to, now);
        if (to !== "incidents") {
          await tx.execute({
            sql: "DELETE FROM worker_state WHERE key = ?",
            args: [EMAIL_REVIEW_TEST_DATE_KEY],
          });
        }
      },
    });
  } catch {
    return fail("unavailable");
  }
}

export type ReviewTestDateInput = ControlBase & { date: unknown };

/**
 * One-off review test date (`worker_state.email_review_test_date`, the TST-115 forced run): a
 * Melbourne date from today to 31 days ahead, only while the mode is `incidents`. It expires on
 * its own after that date. `null` clears it.
 */
export async function setEmailReviewTestDate(p: ReviewTestDateInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  const today = localDay(now);
  const to = p.date;
  if (to !== null) {
    if (!isRealDate(to)) return fail("invalid");
    if (to < today || to > addDays(today, REVIEW_TEST_DATE_MAX_AHEAD_DAYS)) return fail("invalid");
  }
  try {
    const cur = await readEmailSwitch(p.mainDb, today);
    const stored = await p.mainDb.execute({
      sql: "SELECT 1 FROM worker_state WHERE key = ?",
      args: [EMAIL_REVIEW_TEST_DATE_KEY],
    });
    if (to === null) {
      if (stored.rows.length === 0) return NOOP;
    } else {
      if (cur.mode !== "incidents") return fail("email_mode_required");
      if (cur.reviewTestDate === to) return NOOP;
    }
    return await commit(p, now, {
      action: "controls.email_review_test_date",
      targetType: "control",
      targetId: EMAIL_REVIEW_TEST_DATE_KEY,
      detail: { from: cur.reviewTestDate, to },
      apply: async (tx) => {
        if (to === null) {
          await tx.execute({
            sql: "DELETE FROM worker_state WHERE key = ?",
            args: [EMAIL_REVIEW_TEST_DATE_KEY],
          });
          return;
        }
        if ((await readEmailSwitch(tx, today)).mode !== "incidents") {
          throw new Precondition("email_mode_required");
        }
        await writeText(tx, EMAIL_REVIEW_TEST_DATE_KEY, to, now);
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- watch-list (AGT-014) ----

export type WatchListAddInput = ControlBase & {
  market: unknown;
  code: unknown;
  /** Days until the entry expires; defaults to the longest allowed (`owner_add_expiry_days`). */
  days?: unknown;
};

async function ownerAddExpiryDays(db: Client): Promise<number> {
  const v = await getConfig(db, "owner_add_expiry_days");
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= WATCH_LIST_MAX_DAYS
    ? v
    : WATCH_LIST_MAX_DAYS;
}

async function activeWatchRows(db: Exec, market: string, code: string, today: string) {
  const r = await db.execute({
    sql:
      "SELECT id FROM watch_list_owner WHERE market = ? AND code = ? AND removed_at IS NULL " +
      "AND expires_d >= ?",
    args: [market, code, today],
  });
  return r.rows.map((x) => String(x.id));
}

/**
 * Adds a code to the Owner watch-list with an expiry of at most 90 days (and at most the
 * `owner_add_expiry_days` key). The code must be a listed instrument of the market. A code that is
 * already on the list (not removed, not expired) changes nothing.
 */
export async function addWatchListCode(p: WatchListAddInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.market !== "string" || !(MODE_MARKETS as readonly string[]).includes(p.market)) {
    return fail("invalid");
  }
  if (typeof p.code !== "string" || !WATCH_CODE_RE.test(p.code)) return fail("invalid");
  if (p.days !== undefined && (typeof p.days !== "number" || !Number.isInteger(p.days))) {
    return fail("invalid");
  }
  const market = p.market;
  const code = p.code;
  const today = localDay(now);
  try {
    const max = await ownerAddExpiryDays(p.mainDb);
    const days = p.days === undefined ? max : p.days;
    if (days < 1 || days > max) return fail("invalid");
    const inst = await p.mainDb.execute({
      sql: "SELECT 1 FROM instrument WHERE market = ? AND code = ? AND delisted_on IS NULL",
      args: [market, code],
    });
    if (inst.rows.length !== 1) return fail("unknown_code");
    if ((await activeWatchRows(p.mainDb, market, code, today)).length > 0) return NOOP;
    const expiresD = addDays(today, days);
    return await commit(p, now, {
      action: "controls.watch_list_add",
      targetType: "watch_list",
      targetId: `${market}:${code}`,
      detail: { market, code, days, expires_d: expiresD },
      apply: async (tx) => {
        const res = await tx.execute({
          sql:
            "INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) " +
            "SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM watch_list_owner " +
            "WHERE market = ? AND code = ? AND removed_at IS NULL AND expires_d >= ?) " +
            "ON CONFLICT DO NOTHING",
          args: [
            `wl:${market}:${code}:${now}`,
            market,
            code,
            p.actorId,
            now,
            expiresD,
            market,
            code,
            today,
          ],
        });
        if (res.rowsAffected !== 1) throw new Precondition("already_listed");
      },
    });
  } catch {
    return fail("unavailable");
  }
}

export type WatchListRemoveInput = ControlBase & { market: unknown; code: unknown };

/** Removes an Owner watch-list code (sets `removed_at` once; the row stays for the audit trail). */
export async function removeWatchListCode(p: WatchListRemoveInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.market !== "string" || !(MODE_MARKETS as readonly string[]).includes(p.market)) {
    return fail("invalid");
  }
  if (typeof p.code !== "string" || !WATCH_CODE_RE.test(p.code)) return fail("invalid");
  const market = p.market;
  const code = p.code;
  try {
    const open = await p.mainDb.execute({
      sql: "SELECT id FROM watch_list_owner WHERE market = ? AND code = ? AND removed_at IS NULL",
      args: [market, code],
    });
    if (open.rows.length === 0) return NOOP;
    return await commit(p, now, {
      action: "controls.watch_list_remove",
      targetType: "watch_list",
      targetId: `${market}:${code}`,
      detail: { market, code, entries: open.rows.length },
      apply: async (tx) => {
        await tx.execute({
          sql:
            "UPDATE watch_list_owner SET removed_at = ? " +
            "WHERE market = ? AND code = ? AND removed_at IS NULL",
          args: [now, market, code],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- credential expiry (SEC-017, PLT-074, NFR-006) ----

export type CredentialExpiryInput = ControlBase & { name: unknown; expiresOn: unknown };

/**
 * Records when a SEC-017 secret expires (name from the fixed list, date from today to about five
 * years ahead). Drives the combined tokens-due email at 14, 7 and 2 days. Stores no secret value.
 * The table logs every change in its history.
 */
export async function setCredentialExpiry(p: CredentialExpiryInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.name !== "string" || !(CREDENTIAL_NAME_LIST as string[]).includes(p.name)) {
    return fail("invalid");
  }
  if (!isRealDate(p.expiresOn)) return fail("invalid");
  const name = p.name as CredentialName;
  const to = p.expiresOn;
  const today = localDay(now);
  if (to < today || to > addDays(today, CREDENTIAL_EXPIRY_MAX_AHEAD_DAYS)) return fail("invalid");
  try {
    const cur = await p.mainDb.execute({
      sql: "SELECT expires_on FROM credential_expiry WHERE name = ?",
      args: [name],
    });
    const from = cur.rows.length ? String(cur.rows[0].expires_on) : null;
    if (from === to) return NOOP;
    return await commit(p, now, {
      action: "controls.credential_expiry",
      targetType: "credential",
      targetId: name,
      detail: { name, from, to },
      apply: async (tx) => {
        await tx.execute({
          sql:
            "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (name) DO UPDATE SET expires_on = excluded.expires_on, " +
            "set_at = excluded.set_at, set_by = excluded.set_by",
          args: [name, to, now, p.actorId],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- attention snooze (EML-023) ----

export type AttentionSnoozeInput = ControlBase & {
  component: unknown;
  itemKey: unknown;
  days: unknown;
  /**
   * The item as the SERVER knows it (latest health snapshot, src/lib/health/attention.ts), never
   * taken from the form: its state and deadline decide whether it may be snoozed.
   */
  item: AttentionItem | null;
};

/**
 * Snoozes one attention item for 1..`attention_snooze_max_days` days from today. Refused for a red
 * item (state `down`) and for an item whose deadline is within 2 days or past (EML-023). A snooze
 * already covering the same period changes nothing.
 */
export async function snoozeAttention(p: AttentionSnoozeInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (
    typeof p.component !== "string" ||
    !(HEALTH_COMPONENTS as readonly string[]).includes(p.component)
  ) {
    return fail("invalid");
  }
  if (typeof p.itemKey !== "string" || !ITEM_KEY_RE.test(p.itemKey)) return fail("invalid");
  if (typeof p.days !== "number" || !Number.isInteger(p.days) || p.days < 1) return fail("invalid");
  const component = p.component as HealthComponent;
  const itemKey = p.itemKey;
  const days = p.days;
  const item = p.item;
  if (item === null) return fail("item_not_found");
  if (item.component !== component || item.key !== itemKey) return fail("invalid");
  const today = localDay(now);
  try {
    const cfg = await getConfig(p.mainDb, "attention_snooze_max_days");
    const max =
      typeof cfg === "number" && Number.isInteger(cfg) && cfg >= 1
        ? Math.min(cfg, ATTENTION_SNOOZE_DB_MAX_DAYS)
        : DEFAULT_SNOOZE_MAX_DAYS;
    if (days > max) return fail("invalid");
    if (item.state === "down") return fail("snooze_red");
    if (
      item.deadlineD !== null &&
      daysBetween(today, item.deadlineD) <= SNOOZE_DEADLINE_GUARD_DAYS
    ) {
      return fail("snooze_deadline");
    }
    const untilD = addDays(today, days);
    const covered = await p.mainDb.execute({
      sql:
        "SELECT 1 FROM attention_snooze WHERE component = ? AND item_key = ? " +
        "AND from_d <= ? AND until_d >= ?",
      args: [component, itemKey, today, untilD],
    });
    if (covered.rows.length > 0) return NOOP;
    return await commit(p, now, {
      action: "controls.attention_snooze",
      targetType: "attention_item",
      targetId: `${component}:${itemKey}`,
      detail: { component, item_key: itemKey, days, from_d: today, until_d: untilD },
      apply: async (tx) => {
        const res = await tx.execute({
          sql:
            "INSERT INTO attention_snooze (id, component, item_key, from_d, until_d, created_at, " +
            "created_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          args: [
            `sn:${component}:${itemKey}:${untilD}:${now}`,
            component,
            itemKey,
            today,
            untilD,
            now,
            p.actorId,
          ],
        });
        if (res.rowsAffected !== 1) throw new Precondition("already_listed");
      },
    });
  } catch {
    return fail("unavailable");
  }
}

// ---- read model for System Health -------------------------------------------------------------

export type SourceView = {
  source: ControlSource;
  label: string;
  ref: string;
  status: SourceStatus | "unknown";
};
export type MarketView = {
  market: string;
  /** market.mode, the column the Worker and the pipeline read. */
  mode: string;
  /** The latest versioned `market_mode` value for the market (default when never changed). */
  configMode: string | null;
  inSync: boolean;
};
export type WorkerVar = "set" | "not set" | "not known";
export type ControlsView = {
  dispatchEnabled: boolean;
  asxEnabled: boolean;
  asxTripped: boolean;
  /** Owner only (absent for other roles). */
  asxTrippedReason?: string | null;
  sources: SourceView[];
  markets: MarketView[];
  /** True when at least one market is data-only and none is full (BLD-024). */
  dataOnly: boolean;
  /** Current Sydney year of the AU calendar fully confirmed (needed to turn dispatch on). */
  calendarConfirmed: boolean;
  /** From the latest worker-selfcheck run record: present / absent only, never the value. */
  workerVars: { asxLive: WorkerVar; asxUserAgent: WorkerVar };
};

async function loadWorkerVars(db: Exec): Promise<ControlsView["workerVars"]> {
  const unknown = { asxLive: "not known", asxUserAgent: "not known" } as const;
  const r = await db.execute({
    sql: "SELECT details_json FROM run_record WHERE job = 'worker-selfcheck' ORDER BY started_at DESC, id DESC LIMIT 1",
    args: [],
  });
  if (!r.rows.length || typeof r.rows[0].details_json !== "string") return { ...unknown };
  let list: unknown;
  try {
    list = JSON.parse(r.rows[0].details_json);
  } catch {
    return { ...unknown };
  }
  const pick = (name: string): WorkerVar => {
    const hit = Array.isArray(list)
      ? list.find(
          (x) => typeof x === "object" && x !== null && (x as { name?: unknown }).name === name,
        )
      : undefined;
    const d = (hit as { detail?: unknown } | undefined)?.detail;
    return d === "set" || d === "not set" ? d : "not known";
  };
  return { asxLive: pick("ASX_LIVE"), asxUserAgent: pick("ASX_USER_AGENT") };
}

/** Throws on a database error (the caller shows "unavailable"). */
export async function loadControlsView(
  db: Pick<Client, "execute">,
  owner: boolean,
  now: Date = new Date(),
): Promise<ControlsView> {
  const dispatchEnabled = await readSwitch(db, DISPATCH_ENABLED_KEY);
  const asxEnabled = await readSwitch(db, ASX_ENABLED_KEY);
  const st = await db.execute({
    sql: "SELECT mode, reason FROM source_status WHERE source = ?",
    args: [ASX_SOURCE_ID],
  });
  const asxTripped = st.rows[0]?.mode === "tripped";
  const sources: SourceView[] = [];
  for (const source of Object.keys(SOURCE_CONTROLS) as ControlSource[]) {
    const status = await readRegisterStatus(db, source);
    sources.push({
      source,
      label: SOURCE_CONTROLS[source].label,
      ref: SOURCE_CONTROLS[source].ref,
      status: status ?? "unknown",
    });
  }
  const { map } = await readConfigModes(db);
  const rows = await db.execute({ sql: "SELECT code, mode FROM market ORDER BY code", args: [] });
  const markets: MarketView[] = rows.rows.map((r) => {
    const market = String(r.code);
    const mode = String(r.mode);
    const cfg = typeof map[market] === "string" ? (map[market] as string) : null;
    return { market, mode, configMode: cfg, inSync: cfg === mode };
  });
  const nowIso = now.toISOString();
  const view: ControlsView = {
    dispatchEnabled,
    asxEnabled,
    asxTripped,
    sources,
    markets,
    dataOnly:
      markets.some((m) => m.mode === "data_only") && markets.every((m) => m.mode !== "full"),
    calendarConfirmed: await calendarConfirmed(db, nowIso),
    workerVars: await loadWorkerVars(db),
  };
  if (owner) {
    view.asxTrippedReason =
      asxTripped && typeof st.rows[0]?.reason === "string" ? st.rows[0].reason : null;
  }
  return view;
}

// ---- read model for the M5 controls (System Health, Owner only) -------------------------------

export type EmailControlsView = {
  mode: EmailMode;
  reviewTestDate: string | null;
  /** True while a market is data-only: `full` stays unavailable (BLD-024). */
  dataOnly: boolean;
  watchList: { market: string; code: string; expiresD: string }[];
  /** The longest an added code can stay (`owner_add_expiry_days`). */
  watchListMaxDays: number;
  credentials: { name: CredentialName; label: string; expiresOn: string | null }[];
  attention: { item: AttentionItem; snoozedUntil: string | null }[];
  attentionSnoozeMaxDays: number;
};

/** Throws on a database error (the caller shows "unavailable"). */
export async function loadEmailControlsView(
  db: Client,
  attention: AttentionItem[],
  now: Date = new Date(),
): Promise<EmailControlsView> {
  const nowIso = now.toISOString();
  const today = localDay(nowIso);
  const sw = await readEmailSwitch(db, today);
  const wl = await db.execute({
    sql:
      "SELECT market, code, expires_d FROM watch_list_owner WHERE removed_at IS NULL " +
      "AND expires_d >= ? ORDER BY market, code",
    args: [today],
  });
  const exp = await db.execute({
    sql: "SELECT name, expires_on FROM credential_expiry",
    args: [],
  });
  const expiry = new Map(exp.rows.map((r) => [String(r.name), String(r.expires_on)]));
  const sn = await db.execute({
    sql:
      "SELECT component, item_key, MAX(until_d) AS until_d FROM attention_snooze " +
      "WHERE from_d <= ? AND until_d >= ? GROUP BY component, item_key",
    args: [today, today],
  });
  const snoozed = new Map(sn.rows.map((r) => [`${r.component}:${r.item_key}`, String(r.until_d)]));
  const cfg = await getConfig(db, "attention_snooze_max_days");
  return {
    mode: sw.mode,
    reviewTestDate: sw.reviewTestDate,
    dataOnly: await anyMarketDataOnly(db),
    watchList: wl.rows.map((r) => ({
      market: String(r.market),
      code: String(r.code),
      expiresD: String(r.expires_d),
    })),
    watchListMaxDays: await ownerAddExpiryDays(db),
    credentials: CREDENTIAL_NAME_LIST.map((name) => ({
      name,
      label: CREDENTIAL_NAMES[name],
      expiresOn: expiry.get(name) ?? null,
    })),
    attention: attention.map((item) => ({
      item,
      snoozedUntil: snoozed.get(`${item.component}:${item.key}`) ?? null,
    })),
    attentionSnoozeMaxDays:
      typeof cfg === "number" && Number.isInteger(cfg) && cfg >= 1
        ? Math.min(cfg, ATTENTION_SNOOZE_DB_MAX_DAYS)
        : DEFAULT_SNOOZE_MAX_DAYS,
  };
}
