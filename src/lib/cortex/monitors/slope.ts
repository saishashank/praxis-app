// CXA-010 monitor 3 (M23 task M1; D-1617): the calibration slope's 90 % upper bound per family per quarter. The alarm
// "Confidence figures are over-stated for <family>" fires when the bound is below 0.7. The existing rule that hides the
// confidence figure below 1.0 (`slopeHiddenFromUb`, statusRules.mjs) is NOT changed: this only watches, so what the AU
// night reads is untouched. An undefined bound is not an alarm (the figure is already hidden). Reads `family_status` only.
import type { Client } from "@libsql/client";
import { familyBadge } from "@/lib/ui/familyBadge";
import { DEFAULT_HIDE_UB, slopeHiddenFromUb } from "../statusRules.mjs";
import { quarterRange, quarterlyPeriod, r4, type MonitorDef, type MonitorResult } from "./store";

/** The alarm line: the slope's upper bound below this value (D-1617). */
export const SLOPE_ALARM_UB = 0.7; // threshold-ok: D-1617 alarm bound

export type SlopeRead = { readonly family: string; readonly slopeUb90: number | null };

/** True when the bound is below the alarm line (exactly at it is not an alarm). */
export const slopeAlarm = (ub: number | null): boolean => ub !== null && ub < SLOPE_ALARM_UB;

/** Monitor 3 from plain rows. */
export function slopeMonitor(rows: readonly SlopeRead[]): MonitorResult {
  const sorted = [...rows].sort((a, b) => (a.family < b.family ? -1 : 1));
  const items = sorted
    .filter((r) => slopeAlarm(r.slopeUb90))
    .map((r) => `Confidence figures are over-stated for ${familyBadge(r.family).label}`);
  return {
    value: {
      alarm_ub: SLOPE_ALARM_UB,
      families: sorted.map((r) => ({
        family: r.family,
        slope_ub90: r.slopeUb90 === null ? null : r4(r.slopeUb90),
        hidden: slopeHiddenFromUb(r.slopeUb90, DEFAULT_HIDE_UB),
        alarm: slopeAlarm(r.slopeUb90),
      })),
    },
    alarm: items.length > 0,
    ownerItems: items,
  };
}

/** The latest stored slope bound of each family as of the end of the quarter. */
export async function loadSlopes(db: Client, market: string, period: string): Promise<SlopeRead[]> {
  const { to } = quarterRange(period);
  // rows-ok: family status history up to the quarter end (a row per change); newest first, capped at 200
  const r = await db.execute({
    sql: `SELECT family, evidence_json FROM family_status WHERE market = ? AND since_d <= ?
          ORDER BY since_d DESC LIMIT 200`,
    args: [market, to],
  });
  const seen = new Set<string>();
  const out: SlopeRead[] = [];
  for (const row of r.rows) {
    const family = String(row.family);
    if (seen.has(family)) continue;
    seen.add(family);
    let ub: number | null = null;
    try {
      const v = (JSON.parse(String(row.evidence_json)) as Record<string, unknown>).slope_ub90;
      ub = typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      ub = null;
    }
    out.push({ family, slopeUb90: ub });
  }
  return out;
}

export const slopeDef: MonitorDef = {
  monitor: 3,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    return slopeMonitor(await loadSlopes(db, market, period));
  },
};
