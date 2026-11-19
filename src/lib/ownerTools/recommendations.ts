// The Owner's recommendations (M21 B1, UXN-315, D-1216, D-1217, D-1219, F: money maths). Tonight's picks of every tier,
// each sized for the Owner's own capital with the night's maths (`sizeForAmount` through `sizeParcel`): the whole-share
// parcel at the limit price, the risk at the stop with both sides' fees, the chance line only where it is calibrated
// (O-75), the largest-sector line per tier. No language model writes any of it, and nothing here is read by a trading,
// learning or Cortex module: it is a display of stored picks (the pick rows are not touched).
import { costProfileOfMarket, feeFor } from "@/lib/arena/costs";
import { getConfig } from "@/lib/config/store";
import { familyStatusMap } from "@/lib/cortex/store/status";
import { loadProfile } from "@/lib/market/profile";
import { chanceDisplay, chanceLine } from "@/lib/picks/chance";
import type { BrokerLink } from "@/lib/preferences/brokerTemplate";
import { strategyNames } from "@/lib/ui/loaders/common";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { brokerLinksFor, type BrokerHref } from "./brokerLinks";
import { sectorLine, sizeParcel, type Parcel } from "./sizing";
import { TIER_ORDER, tierLabel } from "./tiers";

const MAX_PICK_ROWS = 30; // threshold-ok: three tiers of at most ten picks (the pick table's rank is 1 to 10)

/** The fixed words at the top of the page (D-1217). */
export const RECOMMENDATIONS_NOTICE =
  "Paper-tested ideas, not advice. Place and manage your own orders.";
export const ENTER_AMOUNT_TEXT = "Enter an amount above to see a parcel for each idea.";
export const TOO_SMALL_TEXT = "Too small for a parcel";

export type RecPick = {
  rank: number;
  code: string;
  company: string | null;
  strategy: string;
  limitMicro: string;
  stopMicro: string;
  parcel: Parcel | { kind: "withdrawn" };
  /** The chance line: a calibrated figure or "Not enough history yet". */
  chance: string;
  links: BrokerHref[];
};
export type RecGroup = {
  profile: string;
  tier: string;
  picks: RecPick[];
  /** The largest single-sector share of this tier's sized parcels, or null when none was sized. */
  concentration: string | null;
};
export type RecommendationsModel = {
  d: string | null;
  currency: string;
  capitalWhole: number;
  groups: RecGroup[];
};

type Caps = { maxPct: string; riskPct: string };

function capsOf(cfg: unknown, profile: string): Caps | null {
  if (typeof cfg !== "object" || cfg === null) return null;
  const row = (cfg as Record<string, unknown>)[profile];
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const max = r.max_pct_per_pick;
  const risk = r.risk_pct_per_pick;
  if (typeof max !== "number" || typeof risk !== "number") return null;
  return { maxPct: String(max), riskPct: String(risk) };
}

/**
 * Tonight's picks sized for `capitalWhole` (0 = not set: no size is computed). `links` are the Owner's broker templates;
 * both come from `ownerTools(...)`, the only reader of the Owner's capital and templates.
 */
export async function loadRecommendations(
  env: LoaderEnv,
  owner: { capitalWhole: number; links: readonly BrokerLink[] },
): Promise<RecommendationsModel> {
  const base: RecommendationsModel = {
    d: null,
    currency: env.currency,
    capitalWhole: owner.capitalWhole,
    groups: [],
  };
  // rows-ok: primary-key prefix read of the newest published day
  const latest = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM pick WHERE market = ?",
    args: [env.market],
  });
  const d = latest.rows[0]?.d ? String(latest.rows[0].d) : null;
  if (d === null) return base;

  // rows-ok: one day of one market: at most ten ranks for each of the profiles, LIMIT bounded
  const rows = await env.main.execute({
    sql: `SELECT p.profile, p.rank, p.code, p.family, p.buy_max_micro, p.stop_micro, i.name, i.sector,
                 (SELECT 1 FROM pick_check c WHERE c.market = p.market AND c.d = p.d
                   AND c.profile = p.profile AND c.rank = p.rank AND c.valid = 0 LIMIT 1) AS withdrawn
          FROM pick p LEFT JOIN instrument i ON i.market = p.market AND i.code = p.code
          WHERE p.market = ? AND p.d = ? ORDER BY p.profile, p.rank LIMIT ?`,
    args: [env.market, d, MAX_PICK_ROWS],
  });

  const cfg = await getConfig(env.main, "pick_profiles");
  const profile = await loadProfile(env.main, env.market);
  const costProfile = costProfileOfMarket(profile);
  const floor = profile.parcelFloorMicro ?? 0n;
  const fee = (n: bigint, side: "buy" | "sell", q: bigint): bigint =>
    feeFor(costProfile, n, side, { quantity: q });
  const names = await strategyNames(env.main);
  let statuses: Awaited<ReturnType<typeof familyStatusMap>> | null = null;
  try {
    statuses = await familyStatusMap(env.main, env.market, d);
  } catch {
    statuses = null;
  }

  const byProfile = new Map<string, RecPick[]>();
  const sized = new Map<string, { sector: string | null; valueMicro: bigint }[]>();
  for (const x of rows.rows) {
    const prof = String(x.profile);
    const code = String(x.code);
    const family = String(x.family);
    const limit = BigInt(String(x.buy_max_micro));
    const stop = BigInt(String(x.stop_micro));
    const caps = capsOf(cfg, prof);
    let parcel: RecPick["parcel"];
    if (x.withdrawn !== null && x.withdrawn !== undefined) parcel = { kind: "withdrawn" };
    else if (caps === null) parcel = { kind: "too_small" };
    else
      parcel = sizeParcel({
        capitalWhole: owner.capitalWhole,
        caps,
        limitMicro: limit,
        stopMicro: stop,
        parcelFloorMicro: floor,
        fee,
      });
    if (parcel.kind === "ok") {
      const list = sized.get(prof) ?? [];
      list.push({
        sector: x.sector === null || x.sector === undefined ? null : String(x.sector),
        valueMicro: parcel.valueMicro,
      });
      sized.set(prof, list);
    }
    // No stored probability exists for a night pick yet, so the line is the "not enough history" wording until a family is
    // allowed and calibrated (the same rule as the Picks page, UXN-308, O-75).
    const chance = chanceLine(
      chanceDisplay({
        status: statuses?.[family as keyof typeof statuses] ?? "shadow",
        p: null,
        lo: null,
        hi: null,
        nEff: null,
        slopeUb: null,
        hideBelow: 1,
      }),
    );
    const list = byProfile.get(prof) ?? [];
    list.push({
      rank: Number(x.rank), // money-float-ok: SQL integer column
      code,
      company: x.name === null || x.name === undefined ? null : String(x.name),
      strategy: names[family]?.name ?? family,
      limitMicro: limit.toString(),
      stopMicro: stop.toString(),
      parcel,
      chance,
      links: brokerLinksFor(owner.links, { code, market: env.market }),
    });
    byProfile.set(prof, list);
  }

  const order = [
    ...TIER_ORDER.filter((p) => byProfile.has(p)),
    ...[...byProfile.keys()].filter((p) => !TIER_ORDER.includes(p)).sort(),
  ];
  return {
    ...base,
    d,
    groups: order.map((p) => ({
      profile: p,
      tier: tierLabel(p) ?? p,
      picks: byProfile.get(p) ?? [],
      concentration: sectorLine(sized.get(p) ?? []),
    })),
  };
}
