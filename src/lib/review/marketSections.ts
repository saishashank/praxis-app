// The further markets of the Evening Review (UXN-313, D-1124; M20 S1). The review of a date is built for the first
// enabled market as before (D-1061); every OTHER enabled market that is in `full` mode and trades on the date adds one
// section: its own facts (`buildFacts` is read-only and takes the market), projected to a handful of figures in its own
// currency, with its session close in its own zone and in Melbourne (`formatMarketTime`, D-1063). A market in data-only
// mode has no books and sends no e-mail, so it adds nothing (MKT-111). With no such market the facts are returned
// unchanged: a single-market review is byte-identical to the M19 one.
import type { Client } from "@libsql/client";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { isTradingDay, localToUtc } from "@/lib/data/calendar";
import { formatMarketTime } from "@/lib/health/format";
import { loadProfile } from "@/lib/market/profile";
import type { MarketSectionFact } from "@/lib/email/templates/marketSections";
import { buildFacts, type BuildOptions, type BuiltFacts } from "./assemble";

/** The section of one further market, or null when it does not trade on the date or is not in `full` mode. */
export async function marketSectionOf(
  db: Client,
  market: string,
  o: BuildOptions,
): Promise<MarketSectionFact | null> {
  // rows-ok: primary-key probe of one market row
  const m = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [market] });
  if (m.rows.length !== 1 || String(m.rows[0]!.mode) !== "full") return null;
  if (!isTradingDay(o.d, await loadCalendar(db, market))) return null;
  const profile = await loadProfile(db, market);
  if (profile.tz === null || profile.sessionClose === null || profile.currency === null)
    return null;
  const built = await buildFacts(db, { ...o, market });
  const ex = built.facts.executions.filter((e) => e.variant !== "L");
  const closeAt = formatMarketTime(localToUtc(o.d, profile.sessionClose, profile.tz), profile.tz);
  return {
    market,
    name: profile.name,
    currency: profile.currency,
    closeAt,
    strategies: ex.length,
    dayPlCents: ex.reduce((a, e) => a + e.dayPlCents, 0),
    navCents: ex.reduce((a, e) => a + e.navCents, 0),
    closed: (built.facts.closedTrades ?? []).length,
    queued: built.facts.queuedOrders ?? 0,
  };
}

/** The built facts with one section per further market that trades on the date; unchanged when there is none. */
export async function withMarketSections(
  db: Client,
  built: BuiltFacts,
  o: BuildOptions,
  enabled: readonly string[],
): Promise<BuiltFacts> {
  if (built.variant === "minimal") return built;
  const sections: MarketSectionFact[] = [];
  for (const market of enabled) {
    if (market === o.market) continue;
    const s = await marketSectionOf(db, market, o);
    if (s !== null) sections.push(s);
  }
  if (sections.length === 0) return built;
  return { ...built, facts: { ...built.facts, marketSections: sections } };
}
