// Loader of the golden-set labelling page (M21 L1; UXN-318, D-1227). Owner only: the page guard runs before this is called.
// It reads the enabled markets, the market's count of labelled items and the next unanswered announcement, and nothing
// else: never `text_label` or any other model label, so the Owner's answer stays independent (AT-82).
import type { Client } from "@libsql/client";
import { GOLDEN_TARGET, goldenCount, nextUnlabelled, type NextItem } from "@/lib/labels/golden";
import { safeSourceUrl } from "@/lib/http/safeLink";
import { enabledMarkets } from "@/lib/market/profile";

export type LabelsPage = {
  readonly markets: readonly string[];
  readonly market: string | null;
  readonly count: number;
  readonly target: number;
  readonly item: NextItem | null;
};

/** `requested` is the `?market=` value (any text); it is used only when it names an enabled market. */
export async function loadLabelsPage(
  db: Pick<Client, "execute">,
  requested: string | null,
  homeMarket: string,
): Promise<LabelsPage> {
  const markets = await enabledMarkets(db as Client);
  const market =
    requested !== null && markets.includes(requested)
      ? requested
      : markets.includes(homeMarket)
        ? homeMarket
        : (markets[0] ?? null);
  if (market === null) {
    return { markets, market: null, count: 0, target: GOLDEN_TARGET, item: null };
  }
  const count = await goldenCount(db, market);
  const next = await nextUnlabelled(db, market);
  // a stored link is drawn only when it passes safeSourceUrl (https and a registered source host)
  const item = next === null ? null : { ...next, url: safeSourceUrl(next.url) };
  return { markets, market, count, target: GOLDEN_TARGET, item };
}
