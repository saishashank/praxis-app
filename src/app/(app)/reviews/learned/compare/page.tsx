// Compare 2 to 5 items side by side (UXN-201, UXN-208): the live version (champion) and challengers at
// any KB-040 stage. Only metrics the system really stores are shown: the Critic result, the VAL-110
// test results (estimate with its interval) and the holdout confirmation. A holdout that is not
// confirmed reads "not yet significant"; no p-value claim is made. Everyone may view; only the Owner
// can pick the items (the form on the main page). Phones get one block per item.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { envFor } from "@/lib/ui/loaders/shell";
import { loadCompare, parseCompareIds, type CompareItem } from "@/lib/ui/loaders/knowledgeViews";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState, ShowDetails } from "@/components/ui/States";
import { NotMeasured } from "@/components/ui/Values";
import { challengerHref, LEARNED, PageHead, Shell, StageText } from "../parts";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function Item({ item }: { item: CompareItem }) {
  return (
    <article
      data-testid="compare-item"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-sm break-words"
    >
      <h2 className="m-0 text-base font-semibold">
        {item.kind === "champion" ? (
          <span className="font-mono">{item.id}</span>
        ) : (
          <Link href={challengerHref(item.id)} className="font-mono text-accent underline">
            {item.id}
          </Link>
        )}
      </h2>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="text-text-muted">Kind</dt>
        <dd className="m-0">
          {item.kind === "champion" ? "Current version (champion)" : "Challenger"}
        </dd>
        <dt className="text-text-muted">Family</dt>
        <dd className="m-0">{item.family}</dd>
        <dt className="text-text-muted">Version</dt>
        <dd className="m-0 font-mono">{item.version}</dd>
        {item.stage !== null ? (
          <>
            <dt className="text-text-muted">Stage</dt>
            <dd className="m-0">
              <StageText stage={item.stage} />
            </dd>
          </>
        ) : (
          <>
            <dt className="text-text-muted">Status</dt>
            <dd className="m-0">{item.status ?? "n/a"}</dd>
          </>
        )}
        {item.ready !== null ? (
          <>
            <dt className="text-text-muted">Critic checks</dt>
            <dd className="m-0">
              {item.criticPassed === null || item.criticTotal === null ? (
                <NotMeasured />
              ) : (
                `${item.criticPassed} of ${item.criticTotal} passed`
              )}
            </dd>
          </>
        ) : null}
        <dt className="text-text-muted">Holdout confirmation</dt>
        <dd className="m-0 font-medium">
          {item.holdout === "confirmed" ? "Confirmed" : "Not yet significant"}
        </dd>
        <dt className="text-text-muted">Chance of reaching target, bust or stalling</dt>
        <dd className="m-0">
          <NotMeasured />
        </dd>
      </dl>
      {item.changes.length > 0 ? (
        <div>
          <h3 className="m-0 mb-1 text-sm font-semibold">Changes from the live version</h3>
          <ul className="m-0 list-disc pl-5">
            {item.changes.map((c) => (
              <li key={c.key}>
                {c.key.replace(/_/g, " ")}: <span className="font-mono">{c.from}</span> to{" "}
                <span className="font-mono">{c.to}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ShowDetails summary="Show test results">
        {item.tests.length === 0 ? (
          <p className="m-0 text-text-muted">No test results stored yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {item.tests.map((t) => (
              <li key={t.test}>
                <span className="font-mono">{t.test}</span>: {t.outcome}, {t.n} cases
                {t.estimate !== null ? `, estimate ${t.estimate}` : ""}
                {t.interval !== null ? ` (interval ${t.interval})` : ""}
              </li>
            ))}
          </ul>
        )}
      </ShowDetails>
    </article>
  );
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", `${LEARNED}/compare`);
  const env = await envFor(user);
  const raw = asList(sp.ids);
  const ids = parseCompareIds(raw);
  const model = ids === null ? null : await loadCompare(env, ids);

  return (
    <Shell>
      <PageHead title="Compare versions">
        The live version next to challengers, using only results the system has stored.
      </PageHead>
      {env.mask.masked ? (
        <Banner tone="info">
          Your access shows the rules only: no stock names or codes, and dates are shown as weeks.
        </Banner>
      ) : null}
      {model === null ? (
        <EmptyState
          title={raw.length === 0 ? "Nothing selected" : "Pick 2 to 5 items"}
          action={
            <Link href={LEARNED} className="text-accent underline">
              Back to what the system learned
            </Link>
          }
        >
          {user.role === "owner"
            ? "Tick two to five challengers on the main page, then choose Compare selected."
            : "The Owner picks which items to compare. Ask the Owner for a link."}
        </EmptyState>
      ) : (
        <>
          {model.missing > 0 ? (
            <Banner tone="warning">
              {model.missing} of the items you asked for could not be found.
            </Banner>
          ) : null}
          {model.items.length === 0 ? (
            <EmptyState motif="reviews" hue="reviews" title="Nothing to show">
              None of the items exist.
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {model.items.map((i) => (
                  <Item key={i.id} item={i} />
                ))}
              </div>
              <Card title="How to read this">
                <p className="m-0 text-sm">
                  A holdout is a last stretch of history that is only looked at once. Until it is
                  confirmed, a difference is shown as not yet significant, however good it looks.
                </p>
              </Card>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
