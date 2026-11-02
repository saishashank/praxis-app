// Data review queue (UX-114, DAT-221). Owner only (ROL-102a). Unresolved corporate action
// conflicts on held or candidate codes, with the evidence, and Confirm / Reject. An item left
// alone is applied on the best evidence after the configured number of sessions and flagged.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { loadReviewQueue } from "@/lib/data/corporateActions/queue";
import { mainDb } from "@/lib/db/client";
import { readSuggestionViews } from "@/lib/steelman/read";
import { DEFAULT_MARKET, soft } from "@/lib/ui/loaders/common";
import { ReviewForm } from "./ReviewForm";
import { Suggestions } from "./Suggestions";
import { confirmCorporateActionAction, rejectCorporateActionAction } from "./actions";

export const dynamic = "force-dynamic";

const SOURCE_TEXT: Record<string, string> = {
  announcement: "company announcement",
  vendor: "price vendor",
  price: "price move only",
};

export default async function ReviewPage() {
  await requireUser("admin", "/review");
  const { cards, blockedOnly } = await loadReviewQueue(mainDb());
  // Steelman rule suggestions (M11-lite D-492): Owner only; a failed read draws no group.
  const suggestions = await soft(() => readSuggestionViews(mainDb(), DEFAULT_MARKET), []);
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data review queue</h1>
        <p className="m-0 text-sm text-text-muted">
          Corporate actions where the sources disagree: pick the reading to trust. New entries on
          these codes stay blocked until you decide. If you do nothing, the best-supported reading
          is applied automatically after the date shown (never for a price-only jump), and flagged.
        </p>
      </header>
      {cards.length === 0 ? (
        <EmptyState motif="check" hue="home" title="Nothing is waiting for review.">
          Splits and dividends where the sources disagree will appear here.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {cards.map((c) => (
            <li key={c.id} className="min-w-0">
              <Card title={`${c.code}: ${c.typeLabel}, ex-date ${c.exDate}`}>
                <div className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <section
                    aria-label={`Reported reading for ${c.code}`}
                    className="min-w-0 rounded-md bg-surface-2 p-3"
                  >
                    <h3 className="m-0 text-xs font-semibold text-text-muted">Reported reading</h3>
                    <p className="m-0 mt-1 font-medium">Reported terms: {c.terms}.</p>
                    <p className="m-0 mt-1 text-text-muted">
                      Seen in: {c.sources.map((s) => SOURCE_TEXT[s] ?? s).join(", ") || "unknown"}.
                    </p>
                  </section>
                  <section
                    aria-label={`Other reading for ${c.code}`}
                    className="min-w-0 rounded-md bg-surface-2 p-3"
                  >
                    <h3 className="m-0 text-xs font-semibold text-text-muted">Other reading</h3>
                    {c.alternatives.length > 0 ? (
                      <p className="m-0 mt-1 font-medium">
                        Another reading: {c.alternatives.join("; ")}.
                      </p>
                    ) : (
                      <p className="m-0 mt-1 font-medium">No other reading was reported.</p>
                    )}
                    {c.observed !== null && (
                      <p className="m-0 mt-1 text-text-muted">
                        The price on the ex-date was {(c.observed * 100).toFixed(1)}% of the day
                        before.
                      </p>
                    )}
                  </section>
                </div>
                {c.reasons.length > 0 && (
                  <p className="m-0 mt-3 text-sm">Why it is here: {c.reasons.join("; ")}.</p>
                )}
                <p className="m-0 mt-1 text-sm text-text-muted">
                  {c.neverAuto
                    ? "Never applied automatically: only a price move backs it. Applying it is your call."
                    : c.applyOn
                      ? `Applied automatically on ${c.applyOn} if left alone.`
                      : "Applied automatically after the configured number of sessions if left alone."}
                </p>
                <div className="mt-3">
                  <ReviewForm
                    id={c.id}
                    code={c.code}
                    confirm={confirmCorporateActionAction}
                    reject={rejectCorporateActionAction}
                  />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {blockedOnly > 0 && (
        <Banner>
          {blockedOnly} more conflict(s) on codes that are neither held nor candidates are blocked
          for entry and will appear here if the code becomes one.
        </Banner>
      )}
      <Suggestions items={suggestions} />
      <p className="m-0 text-sm">
        <Link href="/" className="text-accent underline">
          Home
        </Link>
      </p>
    </main>
  );
}
