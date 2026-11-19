// Recommendations (M21 B1, UXN-314, UXN-315, UXN-317; D-1216 to D-1219; F). The Owner's page: tonight's ideas of each tier
// (Turbo, Balanced, Steady) sized for the Owner's own amount, with links to the Owner's own broker. Visible only to the
// pinned Owner while the Owner tools are on; everyone else gets what a missing route gets. Decision support only: nothing
// here places an order and no language model writes any of it. requireOwnerTools is the FIRST await (pageGuard test).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import { authDb, mainDb } from "@/lib/db/client";
import { ownerTools } from "@/lib/preferences/ownerTools";
import { currencyFormatFor } from "@/lib/view/format";
import {
  ENTER_AMOUNT_TEXT,
  loadRecommendations,
  RECOMMENDATIONS_NOTICE,
  TOO_SMALL_TEXT,
  type RecPick,
  type RecommendationsModel,
} from "@/lib/ownerTools/recommendations";
import { formatBp } from "@/lib/ownerTools/sizing";
import { envFor } from "@/lib/ui/loaders/shell";
import { Banner } from "@/components/ui/States";
import { Money } from "@/components/ui/Values";
import { BrokerLinks } from "@/components/ownerTools/BrokerLinks";
import { BrokerLinksForm } from "@/components/ownerTools/BrokerLinksForm";
import { CapitalForm } from "@/components/ownerTools/CapitalForm";
import { OwnerToolsNav } from "@/components/ownerTools/OwnerToolsNav";
import { TierLabel } from "@/components/ownerTools/TierLabel";
import { saveBrokerLinksAction, saveCapitalAction } from "./actions";

export const dynamic = "force-dynamic";

function ParcelLine({ pick, currency }: { pick: RecPick; currency: string }) {
  const p = pick.parcel;
  if (p.kind === "no_amount") {
    return <span className="italic text-text-muted">{ENTER_AMOUNT_TEXT}</span>;
  }
  if (p.kind === "withdrawn") {
    return <span className="italic text-text-muted">No longer valid: not sized</span>;
  }
  if (p.kind === "too_small") {
    return <span data-testid="too-small">{TOO_SMALL_TEXT}</span>;
  }
  return (
    <span data-testid="parcel">
      {p.shares.toString()} shares, about <Money micro={p.valueMicro} currency={currency} />; if the
      stop-loss is hit you would lose about <Money micro={p.riskMicro} currency={currency} />{" "}
      including fees ({formatBp(p.riskBp)} of your amount)
    </span>
  );
}

export default async function RecommendationsPage() {
  const user = await requireOwnerTools("/recommendations");
  const env = await envFor(user);
  const owner = await ownerTools({ auth: authDb(), main: mainDb() }, user, process.env);
  if (owner === null) notFound(); // the guard passed a moment ago; a failed read looks like a missing route
  let model: RecommendationsModel | null = null;
  try {
    model = await loadRecommendations(env, {
      capitalWhole: owner.real_capital,
      links: owner.broker_links,
    });
  } catch {
    model = null;
  }
  const symbol = currencyFormatFor(env.currency).symbol;

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Recommendations</h1>
        <p data-testid="notice" className="m-0 text-sm font-medium">
          {RECOMMENDATIONS_NOTICE}
        </p>
        <OwnerToolsNav current="/recommendations" />
      </header>

      <section aria-labelledby="amount-h" className="flex flex-col gap-2">
        <h2 id="amount-h" className="m-0 text-lg font-semibold">
          Your amount
        </h2>
        <CapitalForm action={saveCapitalAction} current={owner.real_capital} symbol={symbol} />
        {owner.real_capital === 0 ? (
          <p data-testid="enter-amount" className="m-0 text-sm text-text-muted">
            {ENTER_AMOUNT_TEXT}
          </p>
        ) : null}
      </section>

      {model === null ? (
        <Banner tone="warning" title="Not available">
          Tonight&apos;s ideas could not be read. Try again later.
        </Banner>
      ) : model.groups.length === 0 ? (
        <p className="m-0 rounded-md border border-border p-3 text-sm">
          No ideas have been published yet.
        </p>
      ) : (
        model.groups.map((g) => (
          <section key={g.profile} aria-labelledby={`tier-${g.profile}`} data-tier={g.tier}>
            <h2
              id={`tier-${g.profile}`}
              className="m-0 mb-2 flex items-center gap-2 text-lg font-semibold"
            >
              <TierLabel profile={g.profile} />
              <span className="text-sm font-normal text-text-muted">
                {g.picks.length} {g.picks.length === 1 ? "idea" : "ideas"}
              </span>
            </h2>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {g.picks.map((p) => (
                <li
                  key={`${g.profile}-${p.rank}`}
                  data-testid="rec-row"
                  className="min-w-0 break-words rounded-md border border-border p-3 text-sm"
                >
                  <p className="m-0 font-semibold">
                    {p.code}
                    {p.company ? (
                      <span className="font-normal text-text-muted"> · {p.company}</span>
                    ) : null}
                    <span className="font-normal text-text-muted"> · {p.strategy}</span>
                  </p>
                  <p className="m-0 mt-1">
                    Buy up to <Money micro={p.limitMicro} currency={model.currency} />, stop-loss{" "}
                    <Money micro={p.stopMicro} currency={model.currency} />
                  </p>
                  <p className="m-0 mt-1">
                    <ParcelLine pick={p} currency={model.currency} />
                  </p>
                  <p data-testid="chance" className="m-0 mt-1 text-text-muted">
                    {p.chance}
                  </p>
                  <div className="mt-2">
                    <BrokerLinks links={p.links} />
                  </div>
                </li>
              ))}
            </ul>
            {g.concentration ? (
              <p data-testid="concentration" className="m-0 mt-2 text-sm">
                {g.concentration}
              </p>
            ) : null}
          </section>
        ))
      )}

      <section aria-labelledby="links-h" className="flex flex-col gap-2">
        <h2 id="links-h" className="m-0 text-lg font-semibold">
          Your broker links
        </h2>
        <BrokerLinksForm action={saveBrokerLinksAction} current={owner.broker_links} />
      </section>

      <p className="m-0 text-sm">
        <Link href="/picks" className="text-accent underline">
          Back to Picks
        </Link>
      </p>
    </main>
  );
}
