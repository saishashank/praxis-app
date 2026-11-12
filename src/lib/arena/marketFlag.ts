// The `--market` flag of the arena and picks command lines (M19 B2; MKT-110 a, D-996). A script that writes
// market-keyed rows takes `--market <CODE>` with no literal default: omitted, it uses the single enabled market
// (and exits 2 "market required" when there is not exactly one); a market that is not enabled is refused before
// the first write, with the fixed words `refused: market not enabled` and no run record (a run record of that
// market would itself be a refused write). Production has AU as its single enabled market, so an omitted flag
// resolves to AU and the nightly jobs behave as before.
import type { Client } from "@libsql/client";
import { resolveScriptMarket } from "@/lib/market/scriptMarket.mjs";

export type MarketChoice =
  { readonly ok: true; readonly market: string } | { readonly ok: false; readonly line: string };

/** Fixed words for the two refusals (the workflows' log checks and the tests match them). */
export const MARKET_REQUIRED_LINE = "refused: market required";
export const MARKET_NOT_ENABLED_LINE = "refused: market not enabled";

function flagValue(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The market a command line runs for: `--market`, else the single enabled market. Reads the `market` table only.
 * Delegates to the one script resolver (`resolveScriptMarket`, M20 A2, D-1087) and keeps this module's fixed words.
 */
export async function resolveCliMarket(
  db: Pick<Client, "execute">,
  argv: readonly string[],
): Promise<MarketChoice> {
  const asked = flagValue(argv, "--market");
  const r = await resolveScriptMarket(db, asked);
  if (r.ok) return { ok: true, market: r.market };
  return { ok: false, line: asked === null ? MARKET_REQUIRED_LINE : MARKET_NOT_ENABLED_LINE };
}
