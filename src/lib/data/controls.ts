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
import { marketDate } from "@/lib/data/calendar";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import {
  CONFIG_KEYS,
  MODE_MARKETS,
  SELECTABLE_MODES,
  validateMarketModes,
} from "@/lib/config/keys";

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

const fail = (error: ControlError): ControlResult => ({ ok: false, error });
const NOOP: ControlResult = { ok: true, changed: false };

/** A condition re-checked inside the write transaction failed (a race with another change). */
class Precondition extends Error {
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
async function ownerCheck(authDb: Client, actorId: number): Promise<ControlError | null> {
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

type Step = {
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  apply: (tx: Transaction) => Promise<void>;
};

/** Audit first, then ONE main-DB write transaction, then a `_failed` event if that fails. */
async function commit(p: ControlBase, now: string, step: Step): Promise<ControlResult> {
  const meta = p.meta ?? NO_META;
  const base = {
    at: now,
    actorUserId: p.actorId,
    targetType: step.targetType,
    targetId: step.targetId,
  };
  try {
    await audit(p.authDb, p.env, meta, { ...base, action: step.action, detail: step.detail });
  } catch {
    return fail("unavailable"); // nothing has changed
  }
  let tx: Transaction | undefined;
  try {
    tx = await p.mainDb.transaction("write");
    await step.apply(tx);
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
        if (source === ASX_SOURCE_ID) await writeSwitch(tx, ASX_ENABLED_KEY, false, now);
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
 * Sets a market's mode to `off` or `data_only`. `full` is refused (M3). Writes the versioned
 * `market_mode` config value AND `market.mode` in one transaction (see the header).
 */
export async function setMarketMode(p: MarketModeInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (typeof p.market !== "string" || !(MODE_MARKETS as readonly string[]).includes(p.market)) {
    return fail("invalid");
  }
  if (p.mode === "full") return fail("not_available");
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
    return await commit(p, now, {
      action: "controls.market_mode",
      targetType: "market",
      targetId: market,
      detail: { market, from: columnMode, to },
      apply: async (tx) => {
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
