// The Worker's go-live slots and the Owner switch that lists them (M8 T11; docs/M8_design.md
// decision 32; D-155). The Worker (worker/src/schedule.ts) marks every go-live slot
// `requiresListing`: such a slot runs only when its id is in the JSON array
// `worker_state.slots_enabled`. backup, maintenance and ingest-batch1 are NOT gated and always run
// (D-155). The Worker's table cannot be imported into the app bundle, so this list is kept here and
// tests/golive/slots.test.ts keeps it equal to the Worker table (ids, times, order).
//
// The write goes through the D-066 controls runner (src/lib/data/controls.ts commit): Owner check,
// confirm, audit event FIRST, one write transaction, a `_failed` event if it fails. It is allowed
// while the market is data-only (it is how the Owner lists slots before `full`).
import type { Client } from "@libsql/client";
import { JOBS } from "@/lib/jobs/registry.mjs";
import {
  commit,
  fail,
  NOOP,
  ownerCheck,
  type ControlBase,
  type ControlResult,
} from "@/lib/data/controls";

export const SLOTS_ENABLED_KEY = "slots_enabled";

export type GoLiveSlot = { readonly id: string; readonly time: string; readonly label: string };

/**
 * The `requiresListing` slots of worker/src/schedule.ts in PLT-073 order (time of day, 07:00 on).
 * Derived from the job registry (src/lib/jobs/registry.mjs, D-840): the registry lists the go-live
 * jobs in this order, and tests/jobs/registry.test.ts keeps it equal to the Worker table.
 */
export const GO_LIVE_SLOTS: readonly GoLiveSlot[] = JOBS.filter((j) => j.safety === "go-live").map(
  (j) => ({ id: j.id, time: j.time, label: j.label }),
);

export const GO_LIVE_SLOT_IDS: readonly string[] = GO_LIVE_SLOTS.map((s) => s.id);

/** These always run, whatever the list says (D-155). Shown on the block. */
export const ALWAYS_ON_SLOTS: readonly string[] = ["backup", "maintenance", "ingest-batch1"];

export type SlotsView = {
  /** null = no list stored (go-live slots stay off). */
  listed: string[] | null;
  /** The stored value is not a valid list (the Worker dispatches nothing new until it is fixed). */
  malformed: boolean;
};

export async function loadSlotsView(db: Pick<Client, "execute">): Promise<SlotsView> {
  const r = await db.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = ?",
    args: [SLOTS_ENABLED_KEY],
  });
  if (r.rows.length === 0 || r.rows[0]!.value_json === null) {
    return { listed: null, malformed: false };
  }
  try {
    const v: unknown = JSON.parse(String(r.rows[0]!.value_json));
    if (v === null) return { listed: null, malformed: false };
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return { listed: v as string[], malformed: false };
    }
  } catch {
    // fall through
  }
  return { listed: null, malformed: true };
}

/** The canonical stored text: known ids only, in PLT-073 order, no duplicates. */
export function slotsJson(ids: readonly string[]): string {
  const set = new Set(ids);
  return JSON.stringify(GO_LIVE_SLOT_IDS.filter((id) => set.has(id)));
}

export type SlotsInput = ControlBase & { slots: unknown; confirmed: unknown };

/**
 * Owner only. Writes `worker_state.slots_enabled` as a JSON array of go-live slot ids. Error codes:
 * forbidden, invalid (not a list of known go-live slot ids), confirm_required, unavailable. A list
 * equal to the stored one changes nothing and writes nothing.
 */
export async function setSlotsEnabled(p: SlotsInput): Promise<ControlResult> {
  const now = (p.now ?? new Date()).toISOString();
  const denied = await ownerCheck(p.authDb, p.actorId);
  if (denied) return fail(denied);
  if (
    !Array.isArray(p.slots) ||
    p.slots.length > GO_LIVE_SLOT_IDS.length ||
    !p.slots.every((x) => typeof x === "string" && GO_LIVE_SLOT_IDS.includes(x)) ||
    new Set(p.slots as string[]).size !== p.slots.length
  ) {
    return fail("invalid");
  }
  if (p.confirmed !== true) return fail("confirm_required");
  const to = slotsJson(p.slots as string[]);
  try {
    const cur = await p.mainDb.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [SLOTS_ENABLED_KEY],
    });
    const from = cur.rows.length === 0 ? null : String(cur.rows[0]!.value_json);
    if (from === to) return NOOP;
    return await commit(p, now, {
      action: "controls.slots_enabled",
      targetType: "control",
      targetId: SLOTS_ENABLED_KEY,
      detail: { from, to },
      apply: async (tx) => {
        await tx.execute({
          sql:
            "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, " +
            "updated_at = excluded.updated_at",
          args: [SLOTS_ENABLED_KEY, to, now],
        });
      },
    });
  } catch {
    return fail("unavailable");
  }
}
