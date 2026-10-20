// Worker master clock (M2 T3): slot schedule, local-time decision and GitHub workflow dispatch.
// HIGH-RISK: it starts production workflows, inside a 10 ms CPU budget. Opus reviews every line.
//
// Spec text this file implements (verbatim excerpts; file:line in the private spec v1, found
// with grep -n; docs/M2_design.md is in this repo):
//  - 02_platform_hosting_auth.md:81 PLT-070: "Limits (2026-09, [VERIFY]): 10 ms CPU per
//    invocation (network wait excluded), 5 cron triggers per account, 50 subrequests per
//    invocation, 100,000 requests/day."
//  - 02_platform_hosting_auth.md:82 PLT-071: "The Worker's per-minute cron is the master clock:
//    at configured local times it triggers GitHub Actions via `workflow_dispatch` **with `ref:
//    release`** (fine-grained token stored as a Worker secret). The repository's **default
//    branch is `release`**"
//  - 02_platform_hosting_auth.md:104 PLT-074 (s9): "Independent heartbeat. Outside the Worker:
//    two daily **Vercel Cron** checks (Hobby-permitted; configured as the 00:xx and 11:xx UTC
//    hours" (the morning check tests the Worker's last successful poll; this file writes the
//    daily `worker-clock` run record that System Health can read)
//  - 02_platform_hosting_auth.md:105 PLT-075 (s9): "keeps per-minute state in the database
//    (never Workers KV), and respects the shared ASX rate token (DAT-122)."
//  - 02_platform_hosting_auth.md:106 PLT-076 (s9): "Every workflow declares a concurrency key
//    (job, market, local date) without cancelling in-progress runs, and exits in its first step
//    if a success run record already exists for that key."
//  - 02_platform_hosting_auth.md:30 PLT-019: "The guard MUST use **which trigger fired**
//    (`github.event.schedule`) together with the current Melbourne UTC offset — never the
//    wall-clock time at start, because scheduled runs start 5–30 min late." (docs/M2_design.md
//    section 3: the Worker ticks every minute in UTC and decides on the local minute, which
//    "replaces the 'which trigger fired' guard of PLT-019 (TST-103 DST cases still apply,
//    decision 12)".)
//  - 10_nfr_testing.md:172 NFR-040: "a staging Worker whose cron is enabled only during test
//    windows"; staging dispatches `ref: main` (SEC-017 b-s below).
//  - 10_nfr_testing.md:85 SEC-017 (b): "Worker dispatch token | fine-grained, code repo only:
//    actions r/w; production Worker dispatches `ref: release`"
//  - 10_nfr_testing.md:86 SEC-017 (b-s): "staging Worker dispatch token | separate value, same
//    scope; dispatches `ref: main` in test windows only"
//  - 10_nfr_testing.md:159 TST-124: "Cloudflare Worker logic MUST run in the local Workers
//    runtime in CI: slot schedule, ≤ 720 ASX requests/day, CPU budget per tick (assert below
//    the free limit with margin), signed calls to Vercel, dispatch of batch 2, lock/duplicate
//    protection."
//  - 14_system_acceptance.md:12 AT-05 (clock parts): "With YAML schedules disabled, the Worker
//    dispatches every nightly job on time for 3 consecutive days; duplicate dispatch is a
//    no-op; ... Worker dispatches use `ref: release`; DST cases pass"
//  - docs/M2_design.md section 3 slot table (data in schedule.ts): "17:30 | Batch 1, stages 1..9
//    (DAT-020) | Actions `ingest-batch1` | complete by 18:10", "19:35 | Late sweep", "19:50 |
//    Marker check | Worker | in-app incident if missing"; "The Worker re-dispatches only when
//    the slot has passed and there is neither a success nor a running record for the key."
//
// How the rules apply here:
//  - The decision (`candidateSlots`, `decide`) is pure arithmetic on the Sydney local minute
//    (localtime.ts, no Intl). It runs in well under a millisecond.
//  - Idle minute: if no enabled slot's window is open and today's rollup is already known to this
//    isolate, NO database request is made. A cold isolate makes ONE request (the rollup insert).
//    With a window open: ONE request reads state, kill switch, market mode and calendar together.
//    A dispatch adds one request to claim and one to record. Worst case 4 of 50 subrequests plus
//    one GitHub call per due slot.
//  - Idempotency (PLT-076): `slot:<id>:<date>` in worker_state is claimed by a conditional write
//    BEFORE the dispatch; only the writer whose statement changed one row dispatches. A failed
//    dispatch is recorded and retried on the next minute, at most MAX_ATTEMPTS times in all.
//  - Kill switch: `worker_state.dispatch_enabled` must be "1" (default off). Set it from SQL:
//      INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '"1"',
//        '<now ISO>') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
//        updated_at = excluded.updated_at;   (use '"0"' to stop). The Owner toggle is T10.
//  - Errors never escape `runClock`; log lines carry slot ids and fixed words only.
import { dbConfigured, pipeline, type Arg, type DbEnv, type Stmt, type StmtResult } from "./db";
import { dispatchWorkflow, refFor, type DispatchEnv } from "./dispatch";
import { isWeekend, MINUTE_MS, sydneyLocal, type Local } from "./localtime";
import { AU_SLOTS, type Slot } from "./schedule";

export const CLOCK_JOB = "worker-clock";
export const MARKET = "AU";
export const MAX_ATTEMPTS = 3;
/** A claim with no recorded result after this long is treated as a crashed attempt. */
export const CLAIM_STALE_MS = 3 * MINUTE_MS;
export const DISPATCH_ENABLED_KEY = "dispatch_enabled";
/** M8 T8 (decision 32): JSON array of slot ids the Owner has switched on; absent = as configured. */
export const SLOTS_ENABLED_KEY = "slots_enabled";

export type ClockEnv = DbEnv &
  DispatchEnv & {
    BUILD_COMMIT?: string;
  };
export type ClockDeps = { fetch: typeof fetch; nowMs: () => number };

export type SlotState = { s: "claimed" | "dispatched" | "failed"; n: number; at: string };
/** `state` is null when the stored text is not a valid state (never dispatched over). */
export type StoredState = { raw: string; state: SlotState | null };

export type Action = {
  slot: Slot;
  key: string;
  attempt: number;
  prev: string | null;
  /** Workflow inputs for slots with `inputsKey`. */
  inputs?: Record<string, string>;
};

export type Facts = {
  dispatchEnabled: boolean;
  /** market.mode for AU, or null when unreadable (treated like "off" for market-bound slots). */
  marketMode: string | null;
  tradingDay: boolean;
  /** The runtime slot list (default: absent, i.e. today's behaviour). */
  slotsEnabled?: SlotList;
  /** Parsed workflow inputs by `worker_state` key; null = present but invalid (default: none). */
  slotInputs?: Readonly<Record<string, Record<string, string> | null>>;
};

/** The runtime list `worker_state.slots_enabled`: absent, a valid list, or unreadable (fail safe). */
export type SlotList =
  { kind: "absent" } | { kind: "malformed" } | { kind: "list"; ids: ReadonlySet<string> };

/** Why a slot that was due was not started (recorded in the tick summary; never a secret). */
export type SkipReason =
  | "not-released" // available in this build but no list yet: stays off
  | "not-listed" // a list exists and the slot is not in it
  | "list-malformed" // the list is unreadable: nothing new is dispatched
  | "inputs-missing"; // the slot's workflow inputs are absent or invalid
export type Skipped = { id: string; reason: SkipReason };

export const slotKey = (id: string, date: string): string => `slot:${id}:${date}`;
const rollupKey = (date: string): string => `${CLOCK_JOB}:${MARKET}:${date}`;

// ---- pure decision ---------------------------------------------------------------------------

/** Enabled, Worker-clock-dispatchable slots whose window is open at the local minute. */
export function candidateSlots(local: Local, slots: readonly Slot[] = AU_SLOTS): Slot[] {
  return slots
    .filter(
      (s) =>
        s.enabled &&
        s.runner === "actions" &&
        s.workflow !== null &&
        s.everyMin === undefined &&
        (!s.tradingDaysOnly || !isWeekend(local)) &&
        (s.monthly !== "first-saturday" || isFirstSaturday(local)) &&
        local.minute >= s.minute &&
        local.minute <= Math.min(s.minute + s.catchUpMin, 1439),
    )
    .sort((a, b) => a.priority - b.priority);
}

export function parseState(raw: string): SlotState | null {
  try {
    const v = JSON.parse(raw) as Partial<SlotState> | null;
    if (
      v !== null &&
      typeof v === "object" &&
      (v.s === "claimed" || v.s === "dispatched" || v.s === "failed") &&
      typeof v.n === "number" &&
      Number.isInteger(v.n) &&
      v.n >= 1 &&
      typeof v.at === "string"
    ) {
      return { s: v.s, n: v.n, at: v.at };
    }
  } catch {
    // fall through
  }
  return null;
}

/** "1" (string, number or boolean true) turns dispatch on; anything else, or absence, is off. */
export function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const v: unknown = JSON.parse(raw);
    return v === "1" || v === 1 || v === true;
  } catch {
    return false;
  }
}

/**
 * Parses `slots_enabled`. No row, SQL NULL or JSON null = absent (today's behaviour). A JSON array
 * of slot-id strings (possibly empty = nothing runs) is a list. ANYTHING else is malformed and fails
 * safe: the clock dispatches nothing new until the value is fixed.
 */
export function parseSlotsEnabled(raw: string | null | undefined): SlotList {
  if (raw === undefined || raw === null) return { kind: "absent" };
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null) return { kind: "absent" };
    if (
      Array.isArray(v) &&
      v.length <= 100 &&
      v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)
    ) {
      return { kind: "list", ids: new Set(v as string[]) };
    }
  } catch {
    // fall through
  }
  return { kind: "malformed" };
}

/**
 * null = the runtime list lets the slot run; else the reason it must not start. Pure.
 * The list gates ONLY go-live slots (`requiresListing`): the always-on slots (ingest-batch1,
 * maintenance, backup) run as today whatever the list says, so a list that forgets "backup" or is
 * unreadable can never stop backups.
 */
export function listSkip(slot: Slot, list: SlotList = { kind: "absent" }): SkipReason | null {
  if (!slot.requiresListing) return null;
  if (list.kind === "malformed") return "list-malformed";
  if (list.kind === "absent") return "not-released";
  return list.ids.has(slot.id) ? null : "not-listed";
}

const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,29}$/;

/** A JSON object of short strings (workflow_dispatch inputs), else null. */
export function parseInputs(raw: string | undefined): Record<string, string> | null {
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 10) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of entries) {
      if (!INPUT_NAME_RE.test(k) || typeof x !== "string" || x.length > 500) return null;
      out[k] = x;
    }
    return out;
  } catch {
    return null;
  }
}

/** True on the first Saturday of the local month. */
export const isFirstSaturday = (local: Local): boolean =>
  local.dow === 6 && Number(local.date.slice(8, 10)) <= 7;

/** What to dispatch now, in dispatch order. Pure: no I/O. */
export function decide(
  local: Local,
  facts: Facts,
  states: ReadonlyMap<string, StoredState>,
  nowMs: number,
  slots: readonly Slot[] = AU_SLOTS,
): Action[] {
  return decideWithSkips(local, facts, states, nowMs, slots).actions;
}

/** Like `decide`, plus every due slot that was held back by the runtime list or its inputs. */
export function decideWithSkips(
  local: Local,
  facts: Facts,
  states: ReadonlyMap<string, StoredState>,
  nowMs: number,
  slots: readonly Slot[] = AU_SLOTS,
): { actions: Action[]; skipped: Skipped[] } {
  const out: Action[] = [];
  const skipped: Skipped[] = [];
  if (!facts.dispatchEnabled) return { actions: out, skipped };
  for (const slot of candidateSlots(local, slots)) {
    if (slot.marketBound && (facts.marketMode === null || facts.marketMode === "off")) continue;
    if (slot.tradingDaysOnly && !facts.tradingDay) continue;
    const why = listSkip(slot, facts.slotsEnabled);
    if (why !== null) {
      skipped.push({ id: slot.id, reason: why });
      continue;
    }
    let inputs: Record<string, string> | undefined;
    if (slot.inputsKey !== undefined) {
      const got = facts.slotInputs?.[slot.inputsKey] ?? null;
      if (got === null || (slot.requiredInputs ?? []).some((k) => (got[k] ?? "").trim() === "")) {
        skipped.push({ id: slot.id, reason: "inputs-missing" });
        continue;
      }
      inputs = got;
    }
    const key = slotKey(slot.id, local.date);
    const stored = states.get(key);
    if (stored === undefined) {
      out.push({ slot, key, attempt: 1, prev: null, inputs });
      continue;
    }
    const st = stored.state;
    if (st === null || st.s === "dispatched") continue; // unreadable state: never dispatch over it
    const stale = st.s === "claimed" && nowMs - Date.parse(st.at) >= CLAIM_STALE_MS;
    if ((st.s === "failed" || stale) && st.n < MAX_ATTEMPTS) {
      out.push({ slot, key, attempt: st.n + 1, prev: stored.raw, inputs });
    }
  }
  return { actions: out, skipped };
}

// ---- I/O -------------------------------------------------------------------------------------

let rollupDate: string | null = null;
/** Test hook: forget what this isolate knows. */
export function resetClockCache(): void {
  rollupDate = null;
}

export type TickSummary = {
  requests: number;
  dispatched: string[];
  failed: string[];
  /** Due slots held back by the runtime list or missing inputs, with the reason (M8 T8). */
  skipped: Skipped[];
};

const iso = (ms: number) => new Date(ms).toISOString();
const COMMIT_RE = /^[0-9a-f]{40}$/;
const errName = (e: unknown) => (e instanceof Error && e.name ? e.name.slice(0, 40) : "Error");

function rollupInsert(env: ClockEnv, local: Local, nowMs: number): Stmt {
  return {
    // The partial unique index (status = 'success') makes a second daily record impossible.
    sql:
      "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, " +
      "details_json, commit_sha) VALUES (?, ?, ?, ?, ?, 'success', ?, ?) " +
      "ON CONFLICT (concurrency_key) WHERE status = 'success' DO NOTHING",
    args: [
      CLOCK_JOB,
      MARKET,
      rollupKey(local.date),
      local.date,
      iso(nowMs),
      JSON.stringify({ kind: "daily-rollup", env: env.PRAXIS_ENV }),
      env.BUILD_COMMIT && COMMIT_RE.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : null,
    ],
  };
}

/**
 * A malformed `slots_enabled` is recorded once per local day as a failed `worker-clock` run record
 * (the Owner sees it on System Health); the tick dispatches nothing. One extra request, only in this
 * failure state. Never throws.
 */
async function recordMalformed(
  env: ClockEnv,
  local: Local,
  deps: ClockDeps,
  summary: TickSummary,
): Promise<void> {
  try {
    const at = iso(deps.nowMs());
    const key = `slots-malformed:${local.date}`;
    summary.requests++;
    await pipeline(
      env,
      [
        {
          sql:
            "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, " +
            "ended_at, status, error_summary, details_json) SELECT ?, ?, ?, ?, ?, ?, 'failed', ?, ? " +
            "WHERE NOT EXISTS (SELECT 1 FROM run_record WHERE concurrency_key = ?)",
          args: [
            CLOCK_JOB,
            MARKET,
            key,
            local.date,
            at,
            at,
            "slots_enabled unreadable: no new dispatch",
            JSON.stringify({ kind: "slots-malformed" }),
            key,
          ],
        },
      ],
      deps.fetch,
    );
  } catch (e) {
    console.log(`clock: record error ${errName(e)}`);
  }
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** One clock tick. Never throws. See the header for the request budget. */
export async function runClock(
  env: ClockEnv,
  scheduledTime: number,
  deps: ClockDeps,
  slots: readonly Slot[] = AU_SLOTS,
): Promise<TickSummary> {
  const summary: TickSummary = { requests: 0, dispatched: [], failed: [], skipped: [] };
  try {
    if (!dbConfigured(env) || refFor(env.PRAXIS_ENV) === null) return summary;
    const local = sydneyLocal(scheduledTime);
    const cands = candidateSlots(local, slots);
    const needRollup = rollupDate !== local.date;
    if (!needRollup && cands.length === 0) return summary; // idle minute: no request at all

    // ---- request 1: rollup (once per day per isolate) + everything the decision needs --------
    const nowMs = deps.nowMs();
    const first: Stmt[] = [];
    if (needRollup) first.push(rollupInsert(env, local, nowMs));
    const keys = cands.map((s) => slotKey(s.id, local.date));
    const inputKeys = [...new Set(cands.flatMap((s) => (s.inputsKey ? [s.inputsKey] : [])))];
    let iState = -1;
    let iMode = -1;
    let iCal = -1;
    if (cands.length > 0) {
      iState = first.length;
      first.push({
        sql: `SELECT key, value_json FROM worker_state WHERE key IN (${placeholders(keys.length + inputKeys.length + 2)})`,
        args: [DISPATCH_ENABLED_KEY, SLOTS_ENABLED_KEY, ...inputKeys, ...keys],
      });
      if (cands.some((s) => s.marketBound)) {
        iMode = first.length;
        first.push({ sql: "SELECT mode FROM market WHERE code = ?", args: [MARKET] });
      }
      if (cands.some((s) => s.tradingDaysOnly)) {
        iCal = first.length;
        first.push({
          sql: "SELECT kind FROM trading_calendar WHERE market = ? AND d = ?",
          args: [MARKET, local.date],
        });
      }
    }
    let r1: StmtResult[];
    try {
      summary.requests++;
      r1 = await pipeline(env, first, deps.fetch);
    } catch (e) {
      console.log(`clock: db error ${errName(e)}`);
      return summary;
    }
    if (needRollup) rollupDate = local.date;
    if (cands.length === 0) return summary;

    const states = new Map<string, StoredState>();
    let enabledRaw: string | undefined;
    let listRaw: string | null | undefined;
    const slotInputs: Record<string, Record<string, string> | null> = {};
    for (const row of r1[iState].rows) {
      const k = String(row[0]);
      const raw = String(row[1]);
      if (k === DISPATCH_ENABLED_KEY) enabledRaw = raw;
      else if (k === SLOTS_ENABLED_KEY) listRaw = row[1] === null ? null : raw;
      else if (inputKeys.includes(k)) slotInputs[k] = parseInputs(raw);
      else states.set(k, { raw, state: parseState(raw) });
    }
    const mode = iMode >= 0 ? r1[iMode].rows[0]?.[0] : undefined;
    const calKind = iCal >= 0 ? r1[iCal].rows[0]?.[0] : undefined;
    const facts: Facts = {
      dispatchEnabled: parseEnabled(enabledRaw),
      marketMode: typeof mode === "string" ? mode : null,
      tradingDay: !isWeekend(local) && calKind !== "holiday",
      slotsEnabled: parseSlotsEnabled(listRaw),
      slotInputs,
    };
    const { actions, skipped } = decideWithSkips(local, facts, states, nowMs, slots);
    summary.skipped = skipped;
    // "not-released" is the normal state before the Owner lists a slot: no log line for it.
    for (const sk of skipped) {
      if (sk.reason !== "not-released") console.log(`clock: skipped ${sk.id} ${sk.reason}`);
    }
    if (facts.dispatchEnabled && facts.slotsEnabled?.kind === "malformed") {
      await recordMalformed(env, local, deps, summary);
    }
    if (actions.length === 0) return summary;

    // ---- request 2: claim every action (conditional write; 1 changed row = we own it) --------
    const claimAt = iso(deps.nowMs());
    const claimStmts: Stmt[] = actions.map((a) => {
      const v = JSON.stringify({ s: "claimed", n: a.attempt, at: claimAt } satisfies SlotState);
      return a.prev === null
        ? {
            sql:
              "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
              "ON CONFLICT (key) DO NOTHING",
            args: [a.key, v, claimAt],
          }
        : {
            sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ? AND value_json = ?",
            args: [v, claimAt, a.key, a.prev],
          };
    });
    let claims: StmtResult[];
    try {
      summary.requests++;
      claims = await pipeline(env, claimStmts, deps.fetch);
    } catch (e) {
      console.log(`clock: db error ${errName(e)}`);
      return summary;
    }
    const owned = actions.filter((_, i) => claims[i].affected === 1);

    // ---- dispatch (sequential, priority order), then request 3: record every outcome ---------
    const record: Stmt[] = [];
    for (const a of owned) {
      const res = await dispatchWorkflow(env, a.slot.workflow ?? "", deps.fetch, a.inputs);
      const at = iso(deps.nowMs());
      const st: SlotState = { s: res.ok ? "dispatched" : "failed", n: a.attempt, at };
      record.push({
        sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ?",
        args: [JSON.stringify(st), at, a.key],
      });
      if (res.ok) {
        summary.dispatched.push(a.slot.id);
        record.push({
          sql:
            "UPDATE run_record SET items_processed = items_processed + 1, ended_at = ? " +
            "WHERE concurrency_key = ? AND status = 'success'",
          args: [at, rollupKey(local.date)],
        });
        console.log(`clock: dispatched ${a.slot.id} attempt ${a.attempt}`);
      } else {
        summary.failed.push(a.slot.id);
        const args: Arg[] = [
          CLOCK_JOB,
          MARKET,
          `dispatch-failed:${a.slot.id}:${local.date}:${a.attempt}`,
          local.date,
          at,
          at,
          `dispatch ${a.slot.id} ${res.detail}`.slice(0, 120),
          JSON.stringify({ slot: a.slot.id, attempt: a.attempt, ref: refFor(env.PRAXIS_ENV) }),
        ];
        record.push({
          sql:
            "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, " +
            "ended_at, status, error_summary, details_json) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)",
          args,
        });
        console.log(`clock: dispatch failed ${a.slot.id} attempt ${a.attempt}`);
      }
    }
    if (record.length > 0) {
      // One retry: a lost result write would later look like a crashed attempt (PLT-076 makes a
      // re-dispatch a no-op, but a recorded result is better).
      for (let tries = 0; tries < 2; tries++) {
        try {
          summary.requests++;
          await pipeline(env, record, deps.fetch);
          break;
        } catch (e) {
          console.log(`clock: record error ${errName(e)}`);
        }
      }
    }
  } catch (e) {
    console.log(`clock: error ${errName(e)}`);
  }
  return summary;
}
