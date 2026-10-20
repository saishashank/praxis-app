// Strategies list (UX-011, UXN-039, UXN-046, UXN-046a, UXN-052; docs/M7_design.md 3 row 11). Every role
// may read it (ROL-102a); tiles carry no stock code at all, so nothing here depends on masking. The
// attention group comes first (its count is the badge on the tab), then every strategy in the chosen
// order. The four sort chips are a form with a server action, so they work without JavaScript and the
// choice is remembered per user (UXN-046a); `?sort=` in a link wins for that visit.
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { readStrategySort } from "@/lib/preferences/strategySort";
import { strategyNames } from "@/lib/ui/loaders/common";
import {
  loadStrategies,
  parseSort,
  STRATEGY_SORTS,
  type StrategySort,
} from "@/lib/ui/loaders/strategies";
import {
  attentionOrder,
  attentionReasons,
  loadTileExtras,
  sortTiles,
} from "@/lib/ui/loaders/strategyViews";
import { Banner, EmptyState } from "@/components/ui/States";
import { SimulatedLabel } from "@/components/ui/Values";
import { buttonClass } from "@/components/ui/Button";
import { setSortPreferenceAction } from "./actions";
import { StrategyTile } from "./StrategyTile";

export const dynamic = "force-dynamic";

const SORT_LABEL: Record<StrategySort, string> = {
  best: "Best so far",
  closest: "Closest to goal",
  risk: "Most at risk",
  az: "A to Z",
};

async function chooseSort(fd: FormData): Promise<void> {
  "use server";
  await setSortPreferenceAction(String(fd.get("sort") ?? ""));
  redirect("/strategies");
}

export default async function StrategiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser("read", "/strategies");
  const asked = typeof sp.sort === "string" ? sp.sort : null;
  const stored = await readStrategySort(authDb(), user.id);
  const sort: StrategySort = asked !== null ? parseSort(asked) : (stored ?? "best");

  const deps = { mainDb: mainDb(), authDb: authDb(), user: { id: user.id, role: user.role } };
  const list = await loadStrategies(deps, { sort });
  const tiles = sortTiles(list.data.tiles, sort);
  const attention = attentionOrder(list.data.tiles);
  const [extras, names] = await Promise.all([
    loadTileExtras(
      deps,
      tiles.map((t) => t.execution),
    ),
    strategyNames(deps.mainDb),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex min-w-0 flex-col gap-2">
        <h1 className="m-0 text-2xl font-semibold">Strategies</h1>
        <p className="m-0 text-sm text-text-muted">
          Practice strategies that trade with simulated money. Nothing here is a real trade.
        </p>
        <SimulatedLabel />
        <nav aria-label="Strategy pages" className="flex flex-wrap gap-3 text-sm">
          <Link href="/strategies/leaderboard" className="text-accent underline">
            Leaderboard
          </Link>
          <Link href="/strategies/risk" className="text-accent underline">
            Risk overview
          </Link>
          <Link href="/strategies/ideas" className="text-accent underline">
            {"Tonight’s trade ideas"}
          </Link>
        </nav>
      </header>

      {list.data.market.control !== "enabled" ? (
        <Banner tone="warning" title="Trading is not running">
          {list.data.market.control === "killed"
            ? "The Owner has switched all strategies off."
            : "The Owner has paused all strategies."}
        </Banner>
      ) : null}
      {list.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {list.text}
        </Banner>
      ) : null}

      {tiles.length === 0 ? (
        <EmptyState title="No strategies yet">{list.text}</EmptyState>
      ) : (
        <>
          {list.state === "empty" ? <Banner>{list.text}</Banner> : null}

          <section aria-labelledby="attention-h" className="flex min-w-0 flex-col gap-3">
            <h2 id="attention-h" className="m-0 text-xl font-semibold">
              Needs attention{attention.length > 0 ? ` (${attention.length})` : ""}
            </h2>
            {attention.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">Nothing needs a look right now.</p>
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                {attention.map((t) => (
                  <StrategyTile
                    key={t.execution}
                    tile={t}
                    name={names[t.family]}
                    extra={extras[t.execution]}
                    reasons={attentionReasons(t.attention).map((r) => r.text)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="all-h" className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <h2 id="all-h" className="m-0 text-xl font-semibold">
                All strategies
              </h2>
              <form action={chooseSort}>
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
                  <legend className="sr-only">Sort the strategies</legend>
                  {STRATEGY_SORTS.map((s) => (
                    <button
                      key={s}
                      type="submit"
                      name="sort"
                      value={s}
                      aria-pressed={s === sort}
                      className={buttonClass(s === sort ? "default" : "secondary", "rounded-full")}
                    >
                      {SORT_LABEL[s]}
                    </button>
                  ))}
                </fieldset>
              </form>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              {tiles.map((t) => (
                <StrategyTile
                  key={t.execution}
                  tile={t}
                  name={names[t.family]}
                  extra={extras[t.execution]}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
