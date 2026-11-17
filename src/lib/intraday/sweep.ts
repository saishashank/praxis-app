// AGT-147 whole-market intraday sweep (M22 E5, D-1443): extends the catalyst-first scan to the codes of tiers U1 and U2 in
// batches. It plans only when BOTH conditions hold: the switch `intraday_sweep_enabled` is "on" AND the batch quote source's
// register row (`yahoo_delayed_batch`) is `enabled` (accepted). Otherwise it plans nothing and the scan universe is exactly what
// `scanUniverse` returns. Armed picks come first, the sweep never spends more than `intraday_sweep_requests_per_slot` requests
// nor more than the requests the scan has left inside the existing quote budget (the caller passes that number, after the
// armed-pick reserve), and a code the scan already quotes is not asked for twice. Read only: nothing is fetched or written here.
import type { Exec } from "@/lib/cortex/store/common";
import { getConfig } from "@/lib/config/store";
import { tierCodes } from "./universe";

/** The register id of the batch quote endpoint (a pending row until the Owner accepts it). */
export const SWEEP_SOURCE = "yahoo_delayed_batch";
/** Codes one batch request carries. The endpoint's own limit is [VERIFY] at acceptance; the plan never exceeds this. */
export const SWEEP_CODES_PER_REQUEST = 20; // threshold-ok: assumed batch size, [VERIFY] with the endpoint (D-1529)

export type SweepStatus = "off" | "not_accepted" | "no_budget" | "planned";
export type SweepPlan = {
  status: SweepStatus;
  /** One list of codes per request, armed picks first. */
  batches: string[][];
  /** Requests the plan uses (= batches.length). */
  requests: number;
};

const none = (status: SweepStatus): SweepPlan => ({ status, batches: [], requests: 0 });

/** True when the batch source's register row exists and is `enabled`. A failed read is false (fails closed). */
export async function sweepAccepted(db: Exec): Promise<boolean> {
  try {
    // rows-ok: source_register primary key probe
    const r = await db.execute({
      sql: "SELECT status FROM source_register WHERE source = ?",
      args: [SWEEP_SOURCE],
    });
    return r.rows.length === 1 && String(r.rows[0].status) === "enabled";
  } catch {
    return false;
  }
}

/** Both conditions of D-1443. The switch is read first so an off sweep never reads the register. */
export async function sweepStatus(db: Exec): Promise<"off" | "not_accepted" | "ready"> {
  let on: boolean;
  try {
    on = (await getConfig(db, "intraday_sweep_enabled")) === "on";
  } catch {
    on = false;
  }
  if (!on) return "off";
  return (await sweepAccepted(db)) ? "ready" : "not_accepted";
}

export type SweepInput = {
  market: string;
  /** The session date (YYYY-MM-DD). */
  d: string;
  /** Codes the scan already quotes this slot (never asked for again). */
  scanned: readonly string[];
  /** Codes with an armed pick alert, first in line. */
  armed: readonly string[];
  /** Requests the scan has left in this slot inside the existing quote budget, after the armed-pick reserve. */
  requestsLeft: number;
};

/** The sweep's batches for one slot; empty unless both conditions hold. */
export async function planSweep(db: Exec, o: SweepInput): Promise<SweepPlan> {
  const status = await sweepStatus(db);
  if (status !== "ready") return none(status);
  const perSlot = Number(await getConfig(db, "intraday_sweep_requests_per_slot"));
  const requests = Math.min(
    Number.isInteger(perSlot) ? perSlot : 0,
    Math.max(0, Math.floor(o.requestsLeft)),
  );
  if (requests <= 0) return none("no_budget");
  const capacity = requests * SWEEP_CODES_PER_REQUEST;
  const skip = new Set(o.scanned);
  const chosen: string[] = [];
  const seen = new Set<string>();
  const take = (code: string): void => {
    if (chosen.length >= capacity || skip.has(code) || seen.has(code)) return;
    seen.add(code);
    chosen.push(code);
  };
  for (const code of [...o.armed].sort()) take(code); // armed picks first
  // the universe read needs at most capacity + what is already skipped or taken to find `capacity` fresh codes
  const rows = await tierCodes(db, o.market, o.d, capacity + skip.size + o.armed.length);
  for (const c of rows) take(c.code);
  const batches: string[][] = [];
  for (let i = 0; i < chosen.length; i += SWEEP_CODES_PER_REQUEST) {
    batches.push(chosen.slice(i, i + SWEEP_CODES_PER_REQUEST));
  }
  return { status: "planned", batches, requests: batches.length };
}
