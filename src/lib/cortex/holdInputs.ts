// Re-reads what the nightly scoring used for one closed would-have hold (M23 T4; CXA-011, D-1750): the bars of the code, the
// decision's plan, the cohort's cost profile and the average traded value. It builds the very input `scoreOutcomes` (stage.ts)
// hands to `wouldHaveOutcome`, so a comparison walks the same hold the app scored; it only reads and writes nothing. It lives
// beside the Cortex because it needs the arena's cost and price readers, which the research modules do not import.
import type { Client } from "@libsql/client";
import type { ViewBar } from "@/lib/agents/decisionView";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { COST_PROFILES, cohortCostProfile, type CostProfile } from "@/lib/arena/costs";
import { parseCohortParams } from "@/lib/arena/cohort";
import { priceMicro } from "@/lib/arena/marketData";
import { listingFloor } from "@/lib/data/listing";
import type { Micro } from "@/lib/money/micro";
import { atr20Micro, familyPlan, type WouldHaveInput } from "./night";
import { latestMaps } from "./store/maps";

const BAR_LIMIT = 720; // threshold-ok: bars read per hold (the 250-bar ATR history plus a long hold and the margin)
const ATR_HISTORY = 250; // threshold-ok: the history the scoring's ATR reads
const V1_FAMILIES = ["F1", "F4"] as const; // the families the scoring walks (the others are recorded cancelled)

/** The decision of a hold as stored (cortex_decision). */
export type HoldDecision = {
  readonly d: string;
  readonly bookId: string;
  readonly code: string;
  readonly family: string;
  readonly limitMicro: Micro;
  readonly qty: bigint;
  readonly ruleVersion: string | null;
};

export type HoldInputs = {
  readonly input: Omit<WouldHaveInput, "raiseStop">;
  /** The raw bars up to and including the decision night. */
  readonly history: readonly ViewBar[];
};

/** Reads that stay the same for every hold of a night: the parameters, the rule versions and the cost profiles. */
export type HoldContext = {
  readonly params: AgentParams;
  readonly rules: ReadonlyMap<string, { readonly plan?: "time_hold"; readonly hold?: number }>;
  readonly profiles: Map<string, CostProfile>;
};

/** Loads the night's context once. */
export async function loadHoldContext(db: Client, market: string): Promise<HoldContext> {
  const params = await loadAgentParams(db);
  const rules = new Map<string, { plan?: "time_hold"; hold?: number }>();
  for (const m of await latestMaps(db, market)) {
    const p = m.params as unknown as Record<string, unknown>;
    const hold = typeof p.hold === "number" && Number.isFinite(p.hold) ? p.hold : undefined;
    rules.set(
      `${m.family}|${m.ruleVersion}`,
      p.plan === "time_hold" && hold !== undefined ? { plan: "time_hold", hold } : {},
    );
  }
  return { params, rules, profiles: new Map() };
}

async function profileOf(db: Client, ctx: HoldContext, bookId: string): Promise<CostProfile> {
  const hit = ctx.profiles.get(bookId);
  if (hit !== undefined) return hit;
  // rows-ok: one cohort row by primary key per book of the night's holds
  const rs = await db.execute({
    sql: "SELECT params_json FROM cohort WHERE id = ?",
    args: [bookId],
  });
  const profile =
    rs.rows.length === 0
      ? COST_PROFILES.P5
      : cohortCostProfile(parseCohortParams(String(rs.rows[0]!.params_json)));
  ctx.profiles.set(bookId, profile);
  return profile;
}

/** The scoring input of one closed hold, or null when the family has no plan or the decision was never sized. */
export async function loadHoldInputs(
  db: Client,
  market: string,
  dec: HoldDecision,
  exitD: string,
  ctx: HoldContext,
): Promise<HoldInputs | null> {
  if (!(V1_FAMILIES as readonly string[]).includes(dec.family) || dec.qty <= 0n) return null;
  // rows-ok: one code's bars up to the exit by primary key range (market, code, d) descending, LIMIT 720; a few holds a night
  const rs = await db.execute({
    sql:
      `SELECT d, o, h, l, c, volume FROM price_bar WHERE market = ? AND code = ? AND d <= ? AND ${listingFloor("price_bar")} ` +
      "ORDER BY d DESC LIMIT ?",
    args: [market, dec.code, exitD, BAR_LIMIT],
  });
  const all: ViewBar[] = rs.rows
    .map((r): ViewBar => ({
      d: String(r.d),
      open: priceMicro(r.o),
      high: priceMicro(r.h),
      low: priceMicro(r.l),
      close: priceMicro(r.c),
      volume: BigInt(r.volume as number | bigint),
    }))
    .reverse();
  const upTo = all.filter((b) => b.d <= dec.d);
  const after = all.filter((b) => b.d > dec.d);
  const atr = atr20Micro(upTo.slice(-ATR_HISTORY));
  const rule = ctx.rules.get(`${dec.family}|${dec.ruleVersion ?? ""}`);
  const plan = familyPlan(
    dec.family as "F1" | "F4",
    ctx.params,
    atr,
    dec.ruleVersion === null ? undefined : rule,
  );
  if (plan === null) return null;
  const advBars = upTo.slice(-ctx.params.windows.adv);
  let value = 0n;
  for (const b of advBars) value += b.close * b.volume;
  const advMicro = advBars.length === 0 ? 0n : value / BigInt(advBars.length);
  return {
    history: upTo,
    input: {
      code: dec.code,
      family: dec.family as "F1" | "F4",
      qty: dec.qty,
      limitMicro: dec.limitMicro,
      plan,
      atrMicro: atr,
      bars: after,
      profile: await profileOf(db, ctx, dec.bookId),
      advMicro,
    },
  };
}
