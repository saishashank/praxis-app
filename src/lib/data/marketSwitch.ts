// The two-step switch-on and the rollback of a built market (MKT-111, AT-71, D-1100, D-1101, D-1190; M20 S1).
// HIGH-RISK (money, kill): Owner only, audit first, one main-DB write transaction (the `commit` pattern of
// controls.ts, which this module uses; it lives beside it only to keep controls.ts readable).
//
// `switchMarket` is the ONLY writer of `market.enabled` (D-994).
//
//   off -> data_only    needs the checklist (profile, AT-M evidence, licence rows, quota projection, AU MKT-105).
//                       Sets enabled 1, mode data_only, data_only_since today, work_status active; writes the
//                       market's source rows and its calendar years (rows are written on enable, D-1097/D-1128) and
//                       re-projects slots_json. No book is opened, no e-mail is sent.
//   data_only -> full  needs the same items plus five green sessions and ten bar-latency samples, and the RBA close of
//                       the activation day (ARN-119, D-1107): the seed is computed with `seedForMarket` and its
//                       record is stored in the switch row; books open the next trading day (BLD-030).
//   full -> off         the rollback: mode off, rollback_at now, enabled STAYS 1 until the `arena-kill:<CODE>` run has
//                       closed every open book at the open (reason market_off) and disabled the market in the same
//                       transaction as its last close row (src/lib/arena/kill.ts). Only the switch, audit and
//                       market_mode rows are written here; forever tables stay.
//   data_only -> off    no books exist: enabled 0 at once.
// Any other step is refused `two_step`; while a rollback awaits its kill every switch is refused `rollback_pending`.
// `PRAXIS_MARKETS_ENABLED` is the Owner's own step afterwards (D-994): the nightly invariant reminds.
import type { ChecklistDeps, ChecklistItem } from "@/lib/market/checklist";
import { checklist } from "@/lib/market/checklist";
import { seedForMarket } from "@/lib/arena/seed";
import { validateMarketModes } from "@/lib/config/keys";
import { ensureCalendarYears } from "@/lib/data/calendarEnable.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import {
  commit,
  MARKET_MODE_KEY,
  ownerCheck,
  Precondition,
  readConfigModes,
  localDay,
  type ControlBase,
  type ControlError,
  type Exec,
} from "@/lib/data/controls";
import { readSeedFx } from "@/lib/market/fxSeed";
import { builtMarkets, invalidateProfiles, loadProfile } from "@/lib/market/profile";
import { HOME_MARKET, slotsJson } from "@/lib/market/profileCore.mjs";

export type SwitchTarget = "data_only" | "full" | "off";
const SWITCH_TARGETS: readonly SwitchTarget[] = ["data_only", "full", "off"];
export const SWITCH_REASON_MAX = 200; // market_switch.reason CHECK

export type MarketSwitchInput = ControlBase & {
  market: unknown;
  to: unknown;
  /** Required for `off` (the rollback), recorded for every step. At most 200 characters. */
  reason?: unknown;
  /** Test seams of the checklist readers; production callers never set it. */
  checklistDeps?: ChecklistDeps;
};
export type SwitchResult =
  | { ok: true; changed: boolean; from: SwitchTarget; to: SwitchTarget }
  | { ok: false; error: ControlError; open?: ChecklistItem[] };

const failSwitch = (error: ControlError, open?: ChecklistItem[]): SwitchResult => ({
  ok: false,
  error,
  ...(open === undefined ? {} : { open }),
});

type SwitchRow = { mode: string; enabled: number; rollbackAt: string | null };

async function readSwitchRow(db: Exec, market: string): Promise<SwitchRow | null> {
  // rows-ok: primary-key probe of one market row
  const r = await db.execute({
    sql: "SELECT mode, enabled, rollback_at FROM market WHERE code = ?",
    args: [market],
  });
  if (r.rows.length !== 1) return null;
  const x = r.rows[0]!;
  return {
    mode: String(x.mode),
    enabled: Number(x.enabled),
    rollbackAt:
      x.rollback_at === null || x.rollback_at === undefined ? null : String(x.rollback_at),
  };
}

/** The mode the switch sees: a market that is not enabled is `off`. */
const fromOf = (row: SwitchRow): SwitchTarget =>
  row.enabled === 1 ? (row.mode as SwitchTarget) : "off";

export async function switchMarket(p: MarketSwitchInput): Promise<SwitchResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return failSwitch(denied);
  if (
    typeof p.market !== "string" ||
    p.market === HOME_MARKET ||
    !builtMarkets().includes(p.market)
  ) {
    return failSwitch("invalid");
  }
  if (typeof p.to !== "string" || !(SWITCH_TARGETS as readonly string[]).includes(p.to)) {
    return failSwitch("invalid");
  }
  const reasonRaw = p.reason ?? null;
  if (
    reasonRaw !== null &&
    (typeof reasonRaw !== "string" || reasonRaw.length > SWITCH_REASON_MAX)
  ) {
    return failSwitch("invalid");
  }
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() !== "" ? reasonRaw.trim() : null;
  const market = p.market;
  const to = p.to as SwitchTarget;
  try {
    const row = await readSwitchRow(p.mainDb, market);
    if (row === null) return failSwitch("invalid");
    if (row.rollbackAt !== null) return failSwitch("rollback_pending");
    const from = fromOf(row);
    if (from === to) return { ok: true, changed: false, from, to };
    const allowed =
      (from === "off" && to === "data_only") ||
      (from === "data_only" && (to === "full" || to === "off")) ||
      (from === "full" && to === "off");
    if (!allowed) return failSwitch("two_step");
    if (to === "off" && reason === null) return failSwitch("reason_required");
    const today = localDay(now);
    const items: Record<string, unknown>[] = [];
    let seedRecord: Record<string, unknown> | null = null;
    if (to !== "off") {
      const list = await checklist(p.mainDb, market, new Date(now), {
        to: to === "full" ? "full" : "data_only",
        ...(p.checklistDeps === undefined ? {} : { deps: p.checklistDeps }),
      });
      if (!list.complete) {
        return failSwitch(
          "checklist_open",
          list.items.filter((i) => !i.ok),
        );
      }
      for (const i of list.items) items.push({ id: i.id, ok: i.ok, evidence: i.evidence });
      if (to === "full") {
        // ARN-119 (D-1107): the seed must be computable from the activation day's RBA close before `full` is set.
        const profile = await loadProfile(p.mainDb, market);
        try {
          const fx = await readSeedFx(p.mainDb, market, today);
          const seed = seedForMarket(profile, fx);
          seedRecord = { ...seed.record, activation_day: today };
        } catch {
          return failSwitch("fx_missing");
        }
      }
    }
    const slots = to === "data_only" ? slotsJson(await loadProfile(p.mainDb, market)) : null;
    const result = await commit(p, now, {
      action: "market.switch",
      targetType: "market",
      targetId: market,
      detail: { market, from, to, reason },
      apply: async (tx) => {
        // the row is re-read inside the write transaction: a race with another change refuses and writes nothing
        const cur = await readSwitchRow(tx, market);
        if (cur === null || cur.rollbackAt !== null || fromOf(cur) !== from) {
          throw new Precondition("two_step");
        }
        const modes = await readConfigModes(tx);
        const next = { ...modes.map, [market]: to };
        if (validateMarketModes(next) !== null) throw new Precondition("invalid");
        const record = (enabledAfter: 0 | 1) =>
          tx.execute({
            // rows-ok: one append-only history row per switch
            sql:
              "INSERT INTO market_switch (market, from_mode, to_mode, enabled_after, reason, actor, at, " +
              "checklist_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [
              market,
              from,
              to,
              enabledAfter,
              reason,
              `user:${p.actorId}`,
              now,
              JSON.stringify({ items, ...(seedRecord === null ? {} : { seed: seedRecord }) }),
            ],
          });
        if (from === "off" && to === "data_only") {
          await tx.execute({
            sql: "UPDATE market SET enabled = 1, mode = 'data_only', data_only_since = ?, rollback_at = NULL WHERE code = ?",
            args: [today, market],
          });
          if (slots !== null) {
            await tx.execute({
              sql: "UPDATE market SET slots_json = ? WHERE code = ?",
              args: [slots, market],
            });
          }
          await tx.execute({
            sql: "UPDATE market_profile SET work_status = 'active', status_changed_at = ?, updated_at = ? WHERE code = ?",
            args: [now, now, market],
          });
          await ensureMarketSources(tx, market, { now: () => new Date(now) });
          await ensureCalendarYears(tx, market, undefined, { now: () => new Date(now) });
          await record(1);
        } else if (to === "full") {
          await tx.execute({
            sql: "UPDATE market SET mode = 'full' WHERE code = ? AND enabled = 1",
            args: [market],
          });
          await record(1);
        } else if (from === "full") {
          // the rollback: mode off, enabled stays 1 until the kill has run (D-1101)
          await tx.execute({
            sql: "UPDATE market SET mode = 'off', rollback_at = ? WHERE code = ? AND enabled = 1",
            args: [now, market],
          });
          await record(1);
        } else {
          // data_only -> off: no books; the history row first (the guard needs the market enabled), then disable
          await record(0);
          await tx.execute({
            sql: "UPDATE market SET enabled = 0, mode = 'off' WHERE code = ?",
            args: [market],
          });
        }
        await tx.execute({
          sql:
            "INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason) " +
            "VALUES (?, 'global', ?, ?, ?, ?, ?)",
          args: [
            MARKET_MODE_KEY,
            JSON.stringify(next),
            modes.raw,
            p.actorId,
            now,
            reason ?? "Market switch (Settings > Region)",
          ],
        });
      },
    });
    if (!result.ok) return failSwitch(result.error);
    invalidateProfiles();
    return { ok: true, changed: true, from, to };
  } catch {
    return failSwitch("unavailable");
  }
}
