// What-if (UX-119, ROL-102a; M7 T19b; docs/M7_design.md decision 54; D-148 draft). Answers come ONLY
// from rows the nightly batch already stored in `replay_stat` (the cost-profile re-cost and the
// uniform price-shock rows of batch 3, D-132). The request reads and looks up: no simulation, no
// trading-table write, no LLM and no external call, so the same stored rows always give the same
// answer. Anything the stored tables cannot answer is refused with `not_available` ("not available in
// this version", no queue in M7) and does not use up the day's budget.
//
// Budget (ROL-102a, `what_if_daily_limit_per_user`, 5 by default, reset 00:00 Melbourne): the number of
// `what_if.run` audit events of the user inside the Melbourne day. A run that returns figures writes
// that audit event first, then answers; a refusal or a "no data yet" answer writes nothing. The
// Melbourne day is [00:00, next 00:00) converted to UTC with the zone database, so a 23 or 25 hour
// DST day is counted correctly.
import type { Client } from "@libsql/client";
import {
  RECOST_KEYS,
  SHOCK_PCTS,
  costMetric,
  costScope,
  shockMetric,
  shockScope,
} from "@/lib/arena/recost";
import { parseCohortParams } from "@/lib/arena/cohort";
import { COST_PROFILES } from "@/lib/arena/costs";
import { requireKey, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { can } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { addDays, localToUtc, marketDate } from "@/lib/data/calendar";
import { appendAudit, auditKey } from "@/lib/db/audit";
import { strategyNames } from "@/lib/ui/loaders/common";
import type { WhatIfOptions, WhatIfView } from "./options";

export type { WhatIfOptions, WhatIfView } from "./options";

export const WHATIF_TZ = "Australia/Melbourne";
export const WHATIF_KINDS = ["cost", "shock", "custom"] as const;
export type WhatIfKind = (typeof WHATIF_KINDS)[number];
export const WHATIF_ACTION = "what_if.run";
export const PROFILE_KEYS: readonly string[] = RECOST_KEYS;
export const SHOCK_STEPS: readonly number[] = SHOCK_PCTS;

const MAX_KEY = 40; // threshold-ok: id length guard (as the arena controls)
const HTTP_BAD = 400; // threshold-ok: HTTP status
const HTTP_FORBIDDEN = 403; // threshold-ok: HTTP status
const HTTP_NOT_FOUND = 404; // threshold-ok: HTTP status
const HTTP_CONFLICT = 409; // threshold-ok: HTTP status
const HTTP_TOO_MANY = 429; // threshold-ok: HTTP status
const HTTP_UNAVAILABLE = 503; // threshold-ok: HTTP status

export type WhatIfCtx = {
  readonly mainDb: Client;
  readonly authDb: Client;
  readonly env: AuthEnv;
  readonly meta: RequestMeta;
  readonly now?: () => Date;
};

export type WhatIfResult = { readonly status: number; readonly body: Record<string, unknown> };
const res = (status: number, body: Record<string, unknown>): WhatIfResult => ({ status, body });

const str = (v: unknown): string => String(v);

// ---- budget -----------------------------------------------------------------------------------------------------

/** The Melbourne calendar day of an instant and its UTC bounds [start, end). */
export function melbourneDayBounds(now: Date): { d: string; startIso: string; endIso: string } {
  const d = marketDate(now, WHATIF_TZ);
  return {
    d,
    startIso: localToUtc(d, "00:00", WHATIF_TZ).toISOString(),
    endIso: localToUtc(addDays(d, 1), "00:00", WHATIF_TZ).toISOString(),
  };
}

export async function dailyLimit(db: Client): Promise<number> {
  const v = await getConfig(db, "what_if_daily_limit_per_user");
  return typeof v === "number" && Number.isInteger(v) && v >= 0
    ? v
    : (CONFIG_KEYS.what_if_daily_limit_per_user.default as number);
}

export async function runsToday(authDb: Client, userId: number, now: Date): Promise<number> {
  const b = melbourneDayBounds(now);
  const r = await authDb.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_event
          WHERE actor_user_id = ? AND action = ? AND at >= ? AND at < ?`,
    args: [userId, WHATIF_ACTION, b.startIso, b.endIso],
  });
  return Number(r.rows[0]?.n ?? 0); // money-float-ok: SQL count
}

export type Budget = { limit: number; used: number; remaining: number };

export async function budgetFor(
  mainDb: Client,
  authDb: Client,
  userId: number,
  now: Date,
): Promise<Budget> {
  const [limit, used] = await Promise.all([dailyLimit(mainDb), runsToday(authDb, userId, now)]);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// ---- options ----------------------------------------------------------------------------------------------------

export type LiveCohort = {
  execution: string;
  cohortId: string;
  family: string;
  ownProfile: string;
  /** "U" plain shares or "L" with the leverage sleeve (D-191: L is not offered). */
  variant: string;
};

async function liveCohorts(db: Client): Promise<LiveCohort[]> {
  const r = await db.execute(
    `SELECT c.id, c.execution_id, e.family, e.variant, c.params_json
     FROM cohort c JOIN execution e ON e.id = c.execution_id
     WHERE e.kind = 'E' AND c.terminal_kind IS NULL AND c.control_idx IS NULL
     ORDER BY c.execution_id, c.id`,
  );
  const out = new Map<string, LiveCohort>();
  for (const x of r.rows) {
    let ownProfile = "";
    try {
      ownProfile = parseCohortParams(str(x.params_json)).costProfile;
    } catch {
      ownProfile = "";
    }
    // one live round per strategy; the newest id wins
    out.set(str(x.execution_id), {
      execution: str(x.execution_id),
      cohortId: str(x.id),
      family: str(x.family),
      ownProfile,
      variant: str(x.variant),
    });
  }
  return [...out.values()];
}

export async function loadOptions(db: Client): Promise<WhatIfOptions> {
  const [cohorts, names] = await Promise.all([liveCohorts(db), strategyNames(db)]);
  return {
    // D-191/D-200: only the six strategies that use their own money are offered
    strategies: cohorts
      .filter((c) => c.variant !== "L")
      .map((c) => ({ id: c.execution, name: names[c.family]?.name ?? c.family })),
    profiles: [...PROFILE_KEYS],
    profileNames: Object.fromEntries(
      Object.values(COST_PROFILES).map((p) => [p.code, p.name] as const),
    ),
    shocks: [...SHOCK_STEPS],
  };
}

// ---- the run ----------------------------------------------------------------------------------------------------

export type WhatIfInput = { kind: unknown; key: unknown; profile: unknown; pct: unknown };

const keyOk = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= MAX_KEY && /^[A-Za-z0-9_-]+$/.test(s);

/** An integer micro string -> bigint, or null. */
const micro = (v: unknown): bigint | null => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return null;
};
const asNumber = (v: bigint): number | null =>
  v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;

async function newestRow(
  db: Client,
  scope: string,
  metric: string,
): Promise<{ d: string; value: Record<string, unknown> } | null> {
  const r = await db.execute({
    sql: `SELECT d, value_json FROM replay_stat WHERE scope = ? AND metric = ?
          ORDER BY d DESC, run_id DESC LIMIT 1`,
    args: [scope, metric],
  });
  if (r.rows.length === 0) return null;
  try {
    const v = JSON.parse(str(r.rows[0]!.value_json)) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? { d: str(r.rows[0]!.d), value: v as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

async function answer(
  db: Client,
  c: LiveCohort,
  name: string,
  kind: "cost" | "shock",
  profile: string,
  pct: number,
): Promise<WhatIfView | null> {
  if (kind === "cost") {
    const [chosen, own] = await Promise.all([
      newestRow(db, costScope(c.cohortId), costMetric(profile as (typeof RECOST_KEYS)[number])),
      newestRow(
        db,
        costScope(c.cohortId),
        costMetric(c.ownProfile as (typeof RECOST_KEYS)[number]),
      ),
    ]);
    if (!chosen || !own) return null;
    const liq = micro(chosen.value.liq_nav_micro);
    const ownLiq = micro(own.value.liq_nav_micro);
    const fees = micro(chosen.value.fees_micro);
    const ownFees = micro(own.value.fees_micro);
    if (liq === null || ownLiq === null || fees === null || ownFees === null) return null;
    const nums = [liq, ownLiq, liq - ownLiq, fees, ownFees].map(asNumber);
    if (nums.some((n) => n === null)) return null;
    const [a, b, diff, f, of] = nums as number[];
    return {
      execution: c.execution,
      name,
      d: chosen.d,
      result: {
        kind: "cost",
        profile,
        ownProfile: c.ownProfile,
        liqNavMicro: a!,
        ownLiqNavMicro: b!,
        diffMicro: diff!,
        feesMicro: f!,
        ownFeesMicro: of!,
      },
    };
  }
  const row = await newestRow(db, shockScope(c.cohortId), shockMetric(pct));
  if (!row) return null;
  const pnl = micro(row.value.pnl_micro);
  const value = micro(row.value.value_micro);
  const after = micro(row.value.nav_after_micro);
  if (pnl === null || value === null || after === null) return null;
  const nums = [pnl, value, after].map(asNumber);
  if (nums.some((n) => n === null)) return null;
  return {
    execution: c.execution,
    name,
    d: row.d,
    result: {
      kind: "shock",
      pct,
      pnlMicro: nums[0]!,
      valueMicro: nums[1]!,
      navAfterMicro: nums[2]!,
    },
  };
}

/**
 * Owner and Editor (`what_if`). Error codes: forbidden, invalid, not_available (the stored tables
 * cannot answer it; no budget used), not_found (no such running strategy), no_data (nothing stored yet;
 * no budget used), limit_reached, unavailable.
 */
export async function runWhatIf(
  c: WhatIfCtx,
  user: CurrentUser,
  b: WhatIfInput,
): Promise<WhatIfResult> {
  if (!can(user.role, "what_if")) return res(HTTP_FORBIDDEN, { error: "forbidden" });
  if (typeof b.kind !== "string" || !(WHATIF_KINDS as readonly string[]).includes(b.kind))
    return res(HTTP_BAD, { error: "invalid" });
  const kind = b.kind as WhatIfKind;
  if (kind === "custom") return res(HTTP_CONFLICT, { error: "not_available" });
  if (!keyOk(b.key)) return res(HTTP_BAD, { error: "invalid" });

  let profile = "";
  let pct = 0;
  if (kind === "cost") {
    if (typeof b.profile !== "string") return res(HTTP_BAD, { error: "invalid" });
    if (!PROFILE_KEYS.includes(b.profile)) return res(HTTP_CONFLICT, { error: "not_available" });
    profile = b.profile;
  } else {
    const n = typeof b.pct === "string" && /^[+-]?\d{1,4}$/.test(b.pct) ? Number(b.pct) : null; // money-float-ok: whole percent step
    if (n === null) return res(HTTP_BAD, { error: "invalid" });
    if (!SHOCK_STEPS.includes(n)) return res(HTTP_CONFLICT, { error: "not_available" });
    pct = n;
  }

  const now = c.now ? c.now() : new Date();
  let budget: Budget;
  let cohort: LiveCohort | undefined;
  let name: string;
  let view: WhatIfView | null;
  try {
    budget = await budgetFor(c.mainDb, c.authDb, user.id, now);
    if (budget.remaining <= 0) return res(HTTP_TOO_MANY, { error: "limit_reached", ...budget });
    cohort = (await liveCohorts(c.mainDb)).find((x) => x.execution === b.key);
    if (!cohort) return res(HTTP_NOT_FOUND, { error: "not_found" });
    name = (await strategyNames(c.mainDb))[cohort.family]?.name ?? cohort.family;
    view = await answer(c.mainDb, cohort, name, kind, profile, pct);
  } catch {
    return res(HTTP_UNAVAILABLE, { error: "unavailable" });
  }
  if (view === null) return res(HTTP_CONFLICT, { error: "no_data" });

  try {
    await appendAudit(c.authDb, auditKey(requireKey(c.env)), {
      at: now.toISOString(),
      actorUserId: user.id,
      action: WHATIF_ACTION,
      targetType: "what_if",
      targetId: `${cohort.execution}:${kind}`,
      detail: {
        kind,
        execution: cohort.execution,
        profile: profile || null,
        pct: kind === "shock" ? pct : null,
        d: view.d,
      },
      ip: c.meta.ip,
      userAgent: c.meta.userAgent,
    });
  } catch {
    return res(HTTP_UNAVAILABLE, { error: "unavailable" }); // no audit, no answer
  }
  return res(200, {
    ok: true,
    view,
    budget: { limit: budget.limit, used: budget.used + 1, remaining: budget.remaining - 1 },
  });
}
