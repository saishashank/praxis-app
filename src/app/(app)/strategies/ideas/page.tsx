// Tonight's trade ideas (UX-040, UXN-126, UXN-037; docs/M7_design.md 3 row 15; D-128, D-129, D-135
// draft): the signals of one session grouped by strategy, taken (became a practice order) or not taken
// with the reason, and the running tally of how often closed trades landed inside the range their card
// gave. Every signed-in role reads it; a masked viewer sees "Stock A" and card links that carry an
// opaque `ck:` reference, never a code or a stored id (DAT-124). No button places an order (UX-042).
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { authDb, mainDb } from "@/lib/db/client";
import { loadIdeas } from "@/lib/ui/loaders/ideas";
import { NOT_ADVICE_FOOTER } from "@/lib/view/honesty";
import { StrategyTabs } from "../StrategyTabs";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKET_RE = /^[A-Z]{2,4}$/;
const EXPECTED_INSIDE = "about 80% expected if the ranges are honest"; // 10th to 90th range holds 80%

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function IdeasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser("read", "/strategies/ideas");
  const d = one(sp.d);
  const market = one(sp.market);
  const page = await loadIdeas(
    {
      mainDb: mainDb(),
      authDb: authDb(),
      user,
      market: market !== undefined && MARKET_RE.test(market) ? market : undefined,
    },
    { d: d !== undefined && DATE_RE.test(d) ? d : null },
  );
  const v = page.data;

  return (
    <main className="mx-auto flex max-w-4xl min-w-0 flex-col gap-6 px-4 py-6">
      <StrategyTabs current="ideas" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Tonight&apos;s trade ideas</h1>
        <p className="m-0 text-sm text-text-muted">
          What each strategy found in the latest session, and whether it placed a practice order.
          {v.d !== null ? ` Session: ${page.masked ? "latest" : v.d}.` : ""}
        </p>
        <p className="m-0 text-xs text-text-muted">{NOT_ADVICE_FOOTER}</p>
      </header>

      {page.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {page.text}
        </Banner>
      ) : null}

      {page.state === "empty" ? (
        <EmptyState motif="strategies" hue="strategies" title="No trade ideas yet">
          {page.text}
        </EmptyState>
      ) : (
        <>
          <p className="m-0 text-sm" data-testid="ideas-tally">
            {v.tally.signals} {v.tally.signals === 1 ? "idea" : "ideas"} found: {v.tally.taken}{" "}
            taken, {v.tally.notTaken} not taken.
          </p>
          {v.groups.map((g) => (
            <section
              key={g.family}
              aria-labelledby={`g-${g.family}`}
              className="flex flex-col gap-3"
            >
              <h2 id={`g-${g.family}`} className="m-0 text-xl font-semibold">
                {g.strategy}
              </h2>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {g.ideas.map((idea, i) => (
                  <li key={`${i}:${idea.stock}:${idea.variant}`}>
                    <Card title={idea.stock} headingLevel={3}>
                      <p className="m-0 mb-2 text-sm text-text-muted">
                        {idea.taken} taken, {idea.notTaken} not taken
                      </p>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                        {idea.cards.map((c) => (
                          <li key={c.href} className="min-w-0 break-words">
                            <Link href={c.href} className="text-accent underline">
                              {c.execution}: why this trade
                            </Link>
                            {" — "}
                            {c.taken ? "taken" : `not taken: ${c.reason}`}
                          </li>
                        ))}
                        {idea.cards.length === 0 ? (
                          <li className="text-text-muted">No strategy has looked at this yet.</li>
                        ) : null}
                      </ul>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <section aria-labelledby="tally-h" className="flex flex-col gap-3">
        <h2 id="tally-h" className="m-0 text-xl font-semibold">
          How did past ideas turn out?
        </h2>
        {v.familyTally.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">
            No idea has closed yet, so there is nothing to check the ranges against.
          </p>
        ) : (
          <Card>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {v.familyTally.map((f) => (
                <li key={f.family} className="min-w-0 break-words">
                  <strong>{f.strategy}:</strong> {f.insidePct}% of {f.closed} closed trades landed
                  inside the 10th to 90th range ({EXPECTED_INSIDE}).
                  {f.early ? " Early figure: fewer than 30 closed trades." : ""}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </main>
  );
}
