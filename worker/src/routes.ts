// Worker route runner (M5 T10; docs/M5_design.md 4.1 "New runner kind `route`"; D-096 decision 41;
// D-029 wire format). HIGH-RISK: posts signed requests from the Worker to the production app.
//
// A `route` slot is a signed POST to a Vercel route. The slots (schedule.ts) are: alert-flush (odd
// minutes, only when `alert_flush_due` has passed), pre-open / pre-open-retry (09:54, 09:58) and
// evening-review / evening-review-late (20:00-22:00), and the M17 quote-poll (10:00-16:00 every 5 min)
// and intraday-scan (10:32-15:32 every 30 min) recurring slots (disabled or listed-only; the routes refuse until the
// quote source is accepted). All are DISABLED; the dispatch clock
// (clock.ts) never fires them, this runner does.
//
// Per tick, nothing happens (no database request, no log) unless an enabled route slot is due at
// the Sydney minute. Then, in order:
//   1. APP_BASE_URL (https), WORKER_HMAC_SECRET, a database and a known PRAXIS_ENV, else nothing;
//   2. ONE read: the kill switch `dispatch_enabled` (gates route slots too), the market mode and
//      the calendar day when a due slot needs them, `alert_flush_due`, the single-shot slot states;
//   3. recurring slots (`everyMin`) post once per matching minute with no slot state - the route is
//      idempotent and the next tick is the retry; single-shot slots claim `slot:<id>:<date>` first
//      (a conditional write, PLT-076) and are tried at most `maxAttempts` times (default 3), a
//      failed attempt is recorded as a failed `run_record` (the in-app notice, PLT-012);
//   4. the body is `{ purpose, env, d, slot, ...extra }`, signed with the timestamp and a single-use
//      nonce (D-029), `redirect: "manual"`, `AbortSignal.timeout`. HTTP 200 = done.
// Logs carry slot ids and fixed words only; never a URL, header, secret or body.
import {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  SLOTS_ENABLED_KEY,
  listSkip,
  parseEnabled,
  parseSlotsEnabled,
  parseState,
  slotKey,
  type SlotList,
} from "./clock";
import { dbConfigured, pipeline, type Arg, type DbEnv, type Stmt, type StmtResult } from "./db";
import { isWeekend, sydneyLocal, type Local } from "./localtime";
import { isTradingDayKind } from "../../src/lib/data/calendarCore.mjs";
import { AU_SLOTS, type Slot } from "./schedule";
import { randomHex, signHeaders } from "./selfcheck";

export const MAX_ROUTE_ATTEMPTS = MAX_ATTEMPTS;
export const ROUTE_TIMEOUT_MS = 28_000;
export const DISPATCH_ENABLED_KEY = "dispatch_enabled";
export const FLUSH_DUE_KEY = "alert_flush_due";
export const ROUTE_JOB = "worker-route";
export const MARKET = "AU";

export type RouteEnv = DbEnv & {
  PRAXIS_ENV: string;
  APP_BASE_URL?: string;
  WORKER_HMAC_SECRET?: string;
};
export type RouteDeps = { fetch: typeof fetch; nowMs: () => number };

export type RouteFacts = {
  dispatchEnabled: boolean;
  /** market.mode for AU, or null when unreadable (treated like "off" for market-bound slots). */
  marketMode: string | null;
  tradingDay: boolean;
  /** `alert_flush_due` is set and has passed. */
  flushDue: boolean;
  /** The runtime slot list (M8 T8, decision 32); default absent = as configured. */
  slotsEnabled?: SlotList;
};

export type RouteAction = {
  slot: Slot;
  /** worker_state key of a single-shot slot, else null (recurring slots keep no state). */
  key: string | null;
  attempt: number;
  prev: string | null;
};

export type StoredState = { raw: string; state: ReturnType<typeof parseState> };

const isRoute = (s: Slot): boolean => s.runner === "route" && typeof s.route === "string";

function untilMinute(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

/** Enabled route slots whose window is open at the local minute (pure). */
export function routeSlotsDue(local: Local, slots: readonly Slot[] = AU_SLOTS): Slot[] {
  return slots
    .filter((s) => {
      if (!s.enabled || !isRoute(s)) return false;
      if (s.tradingDaysOnly && isWeekend(local)) return false;
      if (s.everyMin !== undefined) {
        const until = s.until !== undefined ? untilMinute(s.until) : s.minute;
        return (
          local.minute >= s.minute &&
          local.minute <= until &&
          (local.minute - s.minute) % s.everyMin === 0
        );
      }
      return local.minute >= s.minute && local.minute <= Math.min(s.minute + s.catchUpMin, 1439);
    })
    .sort((a, b) => a.priority - b.priority);
}

/** What to post now, in order (pure). */
export function decideRoutes(
  local: Local,
  facts: RouteFacts,
  states: ReadonlyMap<string, StoredState>,
  nowMs: number,
  slots: readonly Slot[] = AU_SLOTS,
): RouteAction[] {
  if (!facts.dispatchEnabled) return [];
  const out: RouteAction[] = [];
  for (const slot of routeSlotsDue(local, slots)) {
    if (listSkip(slot, facts.slotsEnabled) !== null) continue; // not listed / list unreadable
    if (slot.marketBound && (facts.marketMode === null || facts.marketMode === "off")) continue;
    if (slot.tradingDaysOnly && !facts.tradingDay) continue;
    if (slot.needs === "alert_flush_due" && !facts.flushDue) continue;
    if (slot.everyMin !== undefined) {
      out.push({ slot, key: null, attempt: 1, prev: null });
      continue;
    }
    if (slot.after !== undefined) {
      const first = states.get(slotKey(slot.after, local.date))?.state;
      if (first?.s === "dispatched") continue; // the first attempt worked: no second one
    }
    const key = slotKey(slot.id, local.date);
    const stored = states.get(key);
    const max = slot.maxAttempts ?? MAX_ROUTE_ATTEMPTS;
    if (stored === undefined) {
      out.push({ slot, key, attempt: 1, prev: null });
      continue;
    }
    const st = stored.state;
    if (st === null || st.s === "dispatched") continue; // unreadable state: never post over it
    const stale = st.s === "claimed" && nowMs - Date.parse(st.at) >= CLAIM_STALE_MS;
    if ((st.s === "failed" || stale) && st.n < max) {
      out.push({ slot, key, attempt: st.n + 1, prev: stored.raw });
    }
  }
  return out;
}

/** The absolute URL of a route on the app origin, or null (https only). */
export function routeUrl(base: string | undefined, path: string): string | null {
  if (typeof base !== "string" || base.trim() === "") return null;
  try {
    const u = new URL(base.trim());
    if (u.protocol !== "https:") return null;
    return new URL(path, u.origin).toString();
  } catch {
    return null;
  }
}

/** `purpose` of a route = its last path segment (the route's own constant). */
export const purposeOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export type PostResult = { ok: boolean; detail: string };

/** One signed POST. Never throws; detail is a fixed word or the error NAME. */
export async function postSigned(
  env: RouteEnv,
  slot: Slot,
  d: string,
  deps: RouteDeps,
): Promise<PostResult> {
  const url = routeUrl(env.APP_BASE_URL, slot.route ?? "");
  const secret = (env.WORKER_HMAC_SECRET ?? "").trim();
  if (url === null || secret === "") return { ok: false, detail: "not-configured" };
  try {
    const body = JSON.stringify({
      purpose: purposeOf(slot.route ?? ""),
      env: env.PRAXIS_ENV,
      d,
      slot: slot.id,
      ...(slot.extra ?? {}),
    });
    const headers = await signHeaders(secret, body, Math.floor(deps.nowMs() / 1000), randomHex(16));
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "manual", // a redirect must never carry the signed request elsewhere
      signal: AbortSignal.timeout(slot.timeoutMs ?? ROUTE_TIMEOUT_MS),
    });
    return res.status === 200
      ? { ok: true, detail: "HTTP 200" }
      : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && e.name ? e.name.slice(0, 40) : "Error" };
  }
}

/** Concurrent signed posts in one tick (the Workers limit is six simultaneous connections). */
export const POST_CONCURRENCY = 3;

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

export type RouteSummary = { requests: number; posted: string[]; failed: string[] };

const iso = (ms: number) => new Date(ms).toISOString();
const errName = (e: unknown) => (e instanceof Error && e.name ? e.name.slice(0, 40) : "Error");
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function flushDue(raw: string | undefined, nowMs: number): boolean {
  if (raw === undefined) return false;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" && Date.parse(v) <= nowMs;
  } catch {
    return false;
  }
}

/** One tick. Never throws. Does nothing, and logs nothing, when no route slot is due. */
export async function runRoutes(
  env: RouteEnv,
  scheduledTime: number,
  deps: RouteDeps,
  slots: readonly Slot[] = AU_SLOTS,
): Promise<RouteSummary> {
  const summary: RouteSummary = { requests: 0, posted: [], failed: [] };
  try {
    const local = sydneyLocal(scheduledTime);
    const due = routeSlotsDue(local, slots);
    if (due.length === 0) return summary; // idle minute: no request at all
    if (env.PRAXIS_ENV !== "production" && env.PRAXIS_ENV !== "staging") return summary;
    if (!dbConfigured(env)) return summary;
    if (routeUrl(env.APP_BASE_URL, "/") === null) return summary;
    if ((env.WORKER_HMAC_SECRET ?? "").trim() === "") return summary;

    // ---- request 1: switch, mode, calendar, flush marker, single-shot states -----------------
    const nowMs = deps.nowMs();
    const keys: string[] = [DISPATCH_ENABLED_KEY, SLOTS_ENABLED_KEY];
    if (due.some((s) => s.needs === "alert_flush_due")) keys.push(FLUSH_DUE_KEY);
    for (const s of due) {
      if (s.everyMin !== undefined) continue;
      keys.push(slotKey(s.id, local.date));
      if (s.after !== undefined) keys.push(slotKey(s.after, local.date));
    }
    const first: Stmt[] = [
      {
        sql: `SELECT key, value_json FROM worker_state WHERE key IN (${placeholders(keys.length)})`,
        args: keys,
      },
    ];
    let iMode = -1;
    let iCal = -1;
    if (due.some((s) => s.marketBound)) {
      iMode = first.length;
      first.push({ sql: "SELECT mode FROM market WHERE code = ?", args: [MARKET] });
    }
    if (due.some((s) => s.tradingDaysOnly)) {
      iCal = first.length;
      first.push({
        sql: "SELECT kind FROM trading_calendar WHERE market = ? AND d = ?",
        args: [MARKET, local.date],
      });
    }
    let r1: StmtResult[];
    try {
      summary.requests++;
      r1 = await pipeline(env, first, deps.fetch);
    } catch (e) {
      console.log(`routes: db error ${errName(e)}`);
      return summary;
    }
    const states = new Map<string, StoredState>();
    let enabledRaw: string | undefined;
    let flushRaw: string | undefined;
    let listRaw: string | null | undefined;
    for (const row of r1[0].rows) {
      const k = String(row[0]);
      const raw = String(row[1]);
      if (k === DISPATCH_ENABLED_KEY) enabledRaw = raw;
      else if (k === SLOTS_ENABLED_KEY) listRaw = row[1] === null ? null : raw;
      else if (k === FLUSH_DUE_KEY) flushRaw = raw;
      else states.set(k, { raw, state: parseState(raw) });
    }
    const mode = iMode >= 0 ? r1[iMode].rows[0]?.[0] : undefined;
    const calKind = iCal >= 0 ? r1[iCal].rows[0]?.[0] : undefined;
    const facts: RouteFacts = {
      dispatchEnabled: parseEnabled(enabledRaw),
      marketMode: typeof mode === "string" ? mode : null,
      // V1-S3 / D-711: fail safe, a weekday with no calendar row is NOT a trading day.
      tradingDay: isTradingDayKind(local.date, typeof calKind === "string" ? calKind : null),
      flushDue: flushDue(flushRaw, nowMs),
      slotsEnabled: parseSlotsEnabled(listRaw),
    };
    if (facts.dispatchEnabled && facts.slotsEnabled?.kind === "malformed") {
      console.log("routes: skipped all list-malformed");
    }
    const actions = decideRoutes(local, facts, states, nowMs, slots);
    if (actions.length === 0) return summary;

    // ---- request 2: claim single-shot actions (1 changed row = we own it) -----------------------
    const claimAt = iso(deps.nowMs());
    const claimed = actions.filter((a) => a.key !== null);
    const owned = new Set<RouteAction>(actions.filter((a) => a.key === null));
    if (claimed.length > 0) {
      const stmts: Stmt[] = claimed.map((a) => {
        const v = JSON.stringify({ s: "claimed", n: a.attempt, at: claimAt });
        return a.prev === null
          ? {
              sql:
                "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
                "ON CONFLICT (key) DO NOTHING",
              args: [a.key as string, v, claimAt],
            }
          : {
              sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ? AND value_json = ?",
              args: [v, claimAt, a.key as string, a.prev],
            };
      });
      let claims: StmtResult[];
      try {
        summary.requests++;
        claims = await pipeline(env, stmts, deps.fetch);
      } catch (e) {
        console.log(`routes: db error ${errName(e)}`);
        return summary;
      }
      claimed.forEach((a, i) => {
        if (claims[i].affected === 1) owned.add(a);
      });
    }

    // ---- post (bounded parallel, results in priority order), then request 3: record outcomes -----
    // V1-I8 (D-774): the posts are independent signed requests to idempotent routes; one tick used to
    // wait for each in turn (up to 28 s apiece). At most POST_CONCURRENCY are in flight; the records
    // below are still written in priority order from the collected results.
    const record: Stmt[] = [];
    const todo = actions.filter((a) => owned.has(a));
    const results = await mapBounded(todo, POST_CONCURRENCY, (a) =>
      postSigned(env, a.slot, local.date, deps),
    );
    for (const [i, a] of todo.entries()) {
      const res = results[i];
      if (res.ok) summary.posted.push(a.slot.id);
      else summary.failed.push(a.slot.id);
      console.log(`routes: ${res.ok ? "posted" : "failed"} ${a.slot.id} attempt ${a.attempt}`);
      if (a.key === null) {
        // V2-B1 (D-668): a recurring slot has no state row, so its failure is recorded once per slot
        // and local day (first failure wins; the guarded insert is idempotent) for System Health.
        if (!res.ok) {
          const at = iso(deps.nowMs());
          const key = `route-failed:${a.slot.id}:${local.date}:recurring`;
          record.push({
            sql:
              "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, " +
              "ended_at, status, error_summary, details_json) SELECT ?, ?, ?, ?, ?, ?, 'failed', ?, ? " +
              "WHERE NOT EXISTS (SELECT 1 FROM run_record WHERE concurrency_key = ?)",
            args: [
              ROUTE_JOB,
              MARKET,
              key,
              local.date,
              at,
              at,
              `route ${a.slot.id} ${res.detail}`.slice(0, 120),
              JSON.stringify({ slot: a.slot.id, recurring: true }),
              key,
            ],
          });
        }
        continue;
      }
      const at = iso(deps.nowMs());
      record.push({
        sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ?",
        args: [
          JSON.stringify({ s: res.ok ? "dispatched" : "failed", n: a.attempt, at }),
          at,
          a.key,
        ],
      });
      if (!res.ok) {
        const args: Arg[] = [
          ROUTE_JOB,
          MARKET,
          `route-failed:${a.slot.id}:${local.date}:${a.attempt}`,
          local.date,
          at,
          at,
          `route ${a.slot.id} ${res.detail}`.slice(0, 120),
          JSON.stringify({ slot: a.slot.id, attempt: a.attempt }),
        ];
        record.push({
          sql:
            "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, " +
            "ended_at, status, error_summary, details_json) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)",
          args,
        });
      }
    }
    if (record.length > 0) {
      for (let tries = 0; tries < 2; tries++) {
        try {
          summary.requests++;
          await pipeline(env, record, deps.fetch);
          break;
        } catch (e) {
          console.log(`routes: record error ${errName(e)}`);
        }
      }
    }
  } catch (e) {
    console.log(`routes: error ${errName(e)}`);
  }
  return summary;
}
