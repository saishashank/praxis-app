// Label announcements (M21 L1; UXN-318, D-1227; CTX-040, DAT-247). The Owner reads one headline at a time and answers three
// questions (guidance, event, tone), or skips it, or flags it as unclear. The answers are the golden set the text labels are
// checked against, so the page never reads or shows the model's own label, before or after an answer. Owner only: any other
// role gets the 403 page. Append-only: a later answer is a new row, nothing is edited or removed.
import Link from "next/link";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import { loadLabelsPage } from "@/lib/ui/loaders/labels";
import { formatCount, formatInstant } from "@/lib/view/format";
import { LabelForm } from "./LabelForm";
import { saveGoldenAction } from "./actions";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function LabelsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireUser("admin", "/cortex/labels");
  const sp = await searchParams;
  const asked = typeof sp.market === "string" ? sp.market : null;
  let page = null;
  try {
    page = await loadLabelsPage(mainDb(), asked, homeProfile().code);
  } catch {
    page = null;
  }
  const item = page?.item ?? null;

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Label announcements</h1>
        <p className="m-0 text-sm text-text-muted">
          Read each headline and give your own judgement. These answers are the yardstick the
          automatic labels are checked against, so none of the automatic labels is shown here. An
          answer is added to the record; nothing is edited or removed.
        </p>
        <p className="m-0 text-sm">
          <Link href="/cortex" className="text-accent underline">
            Back to Cortex
          </Link>
        </p>
      </header>

      {page === null ? (
        <Banner tone="warning" title="Not available">
          The headlines could not be read. Try again later.
        </Banner>
      ) : page.market === null ? (
        <EmptyState title="No market is switched on">There is nothing to label yet.</EmptyState>
      ) : (
        <>
          {page.markets.length > 1 ? (
            <nav aria-label="Market" className="flex flex-wrap gap-2 text-sm">
              {page.markets.map((m) => (
                <Link
                  key={m}
                  href={`/cortex/labels?market=${encodeURIComponent(m)}`}
                  aria-current={m === page.market ? "page" : undefined}
                  className={`rounded border px-3 py-1 ${m === page.market ? "font-semibold" : "text-accent underline"}`}
                >
                  {m}
                </Link>
              ))}
            </nav>
          ) : null}

          <p className="m-0 text-sm font-semibold" role="status" data-testid="label-progress">
            {formatCount(page.count)} of {formatCount(page.target)} labelled ({page.market})
          </p>

          {item === null ? (
            <EmptyState title="Nothing left to label">
              Every announcement stored for {page.market} has an answer. New ones appear here as
              they arrive.
            </EmptyState>
          ) : (
            <section
              aria-label="Announcement to label"
              className="flex flex-col gap-3 rounded border p-4"
              data-testid="label-item"
            >
              <p className="m-0 text-xs text-text-muted">
                {page.market} · {formatInstant(item.publishedAt)}
                {item.url ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline"
                    >
                      Open the source
                    </a>
                  </>
                ) : null}
              </p>
              <LabelForm
                key={`${item.source}:${item.annId}`}
                action={saveGoldenAction}
                market={page.market}
                source={item.source}
                annId={item.annId}
                title={item.title}
              />
            </section>
          )}
          <p className="m-0 text-xs text-text-muted">
            Keys: 1 to 4 choose within a group, Tab or the arrow keys move around, S skips, U flags
            the headline as unclear, Enter saves.
          </p>
        </>
      )}
    </main>
  );
}
