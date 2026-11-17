// The live-tested progress meter (M23 M3; CXA-005, D-1624, D-1720). The rule is unchanged (a family's statement is publishable
// at `n_eff_live` >= 150, and a family may trade at `cortex_min_neff_trade`); this only shows progress. Per family F1 to F6 and
// night, two `research_meter` rows: `neff_live_<family>` against 150 and `neff_trade_<family>` against the trade floor. The figure
// is the `n_eff_live` of the family's latest evaluated quarterly look (it moves once a quarter, like the look). The pace is
// that figure per session: between the last two evaluated looks when there are two, else since the start of the first look's
// quarter; the projected date walks that pace over the trading calendar. No evaluation, no look, nothing written to a family.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { FAMILIES, LIVE_TESTED_MIN_NEFF } from "@/lib/cortex/statusRules.mjs";
import { projectDate } from "../lineages/annAngles";
import type { ResearchNightOptions } from "../night";
import { closedAfter, sessionsBetween, str, writeMeter, type MeterStatus } from "./common";

const STATUS_LOOK_KIND = "status_look"; // the kind of a family's quarterly look cell (src/lib/cortex/look.ts)
const MAX_CELLS = 40; // threshold-ok: a bound on the quarterly look cells of one family read (ten years)
const QUARTER_FIRST_MONTHS = ["01", "04", "07", "10"] as const;

export const neffLiveLineage = (family: string): string => `neff_live_${family}`;
export const neffTradeLineage = (family: string): string => `neff_trade_${family}`;

/** First calendar day of a quarter written like "2031Q2", or null for any other text. */
export function quarterStart(q: string): string | null {
  const m = /^(\d{4})Q([1-4])$/.exec(q);
  return m === null ? null : `${m[1]}-${QUARTER_FIRST_MONTHS[Number(m[2]) - 1]}-01`;
}

export type LookPoint = { readonly quarter: string; readonly to: string; readonly nEff: number };

/** The evaluated quarterly looks of a family that carry a live n_eff, oldest first. */
export async function lookPoints(db: Client, market: string, family: string): Promise<LookPoint[]> {
  // rows-ok: the family's quarterly look cells by the (market, family, kind) index, at most 40 rows (one a quarter)
  const r = await db.execute({
    sql:
      "SELECT spec_json, result_json FROM cortex_ledger_cell WHERE market = ? AND family = ? AND kind = ? " +
      "AND result_json IS NOT NULL ORDER BY logged_at LIMIT ?",
    args: [market, family, STATUS_LOOK_KIND, MAX_CELLS],
  });
  const out: LookPoint[] = [];
  for (const x of r.rows) {
    try {
      const spec = JSON.parse(str(x.spec_json)) as { quarter?: unknown; to?: unknown };
      const res = JSON.parse(str(x.result_json)) as { outcome?: unknown; n_eff_live?: unknown };
      if (
        res.outcome === "evaluated" &&
        typeof res.n_eff_live === "number" &&
        Number.isFinite(res.n_eff_live) &&
        typeof spec.quarter === "string" &&
        typeof spec.to === "string"
      )
        out.push({ quarter: spec.quarter, to: spec.to, nEff: res.n_eff_live });
    } catch {
      // a cell that cannot be read adds no point
    }
  }
  return out.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** n_eff per session: between the last two looks, or since the start of the only look's quarter; null when it cannot be formed. */
export async function liveRate(
  db: Client,
  market: string,
  points: readonly LookPoint[],
): Promise<number | null> {
  const last = points[points.length - 1];
  if (last === undefined) return null;
  const prev = points[points.length - 2];
  const [from, gained] =
    prev === undefined
      ? [quarterStart(last.quarter), last.nEff]
      : [dayAfter(prev.to), last.nEff - prev.nEff];
  if (from === null || !(gained > 0)) return null;
  const sessions = await sessionsBetween(db, market, from, last.to);
  return sessions > 0 ? gained / sessions : null;
}

function dayAfter(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

async function tradeFloor(db: Client): Promise<number> {
  const v = await getConfig(db, "cortex_min_neff_trade" as ConfigKey);
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v);
}

export type LiveMeter = {
  readonly family: string;
  readonly nEff: number;
  readonly liveStatus: MeterStatus;
  readonly tradeStatus: MeterStatus;
  readonly liveProjectedD: string | null;
  readonly tradeProjectedD: string | null;
};

/** One night for one market: two meter rows for each of F1 to F6. Exported for the tests; the meters step calls it. */
export async function runLiveTested(db: Client, o: ResearchNightOptions): Promise<LiveMeter[]> {
  const floor = await tradeFloor(db);
  const closed = await closedAfter(db, o.market, o.d);
  const out: LiveMeter[] = [];
  for (const family of FAMILIES.filter((f: string) => f !== "F7")) {
    const points = await lookPoints(db, o.market, family);
    const nEff = points.length === 0 ? 0 : points[points.length - 1]!.nEff;
    const rate = await liveRate(db, o.market, points);
    const row = async (lineage: string, target: number): Promise<[MeterStatus, string | null]> => {
      const status: MeterStatus = nEff >= target ? "met" : "collecting";
      const projectedD =
        status === "collecting" && rate !== null
          ? projectDate(o.d, target - nEff, rate, closed)
          : null;
      await writeMeter(db, {
        market: o.market,
        lineage,
        d: o.d,
        n: Math.floor(nEff),
        target,
        status,
        projectedD,
        now: o.now,
      });
      return [status, projectedD];
    };
    const [liveStatus, liveProjectedD] = await row(neffLiveLineage(family), LIVE_TESTED_MIN_NEFF);
    const [tradeStatus, tradeProjectedD] = await row(neffTradeLineage(family), floor);
    out.push({ family, nEff, liveStatus, tradeStatus, liveProjectedD, tradeProjectedD });
  }
  return out;
}
