// Data review queue (UX-114, DAT-221). Owner only (ROL-102a). Unresolved corporate action
// conflicts on held or candidate codes, with the evidence, and Confirm / Reject. An item left
// alone is applied on the best evidence after the configured number of sessions and flagged.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { loadReviewQueue } from "@/lib/data/corporateActions/queue";
import { mainDb } from "@/lib/db/client";
import { ReviewForm } from "./ReviewForm";
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
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data review queue</h1>
        <p className="m-0 text-sm text-text-muted">
          Corporate actions where the sources disagree. New entries on these codes stay blocked
          until you decide. If you do nothing, the best-supported reading is applied automatically
          after the date shown, and flagged.
        </p>
      </header>
      {cards.length === 0 ? (
        <EmptyState title="Nothing is waiting for review." />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {cards.map((c) => (
            <li key={c.id} className="min-w-0">
              <Card title={`${c.code}: ${c.typeLabel}, ex-date ${c.exDate}`}>
                <div className="flex flex-col gap-1 text-sm">
                  <p className="m-0">Reported terms: {c.terms}.</p>
                  <p className="m-0">
                    Seen in: {c.sources.map((s) => SOURCE_TEXT[s] ?? s).join(", ") || "unknown"}.
                  </p>
                  {c.reasons.length > 0 && (
                    <p className="m-0">Why it is here: {c.reasons.join("; ")}.</p>
                  )}
                  {c.observed !== null && (
                    <p className="m-0">
                      The price on the ex-date was {(c.observed * 100).toFixed(1)}% of the day
                      before.
                    </p>
                  )}
                  {c.alternatives.length > 0 && (
                    <p className="m-0">Another reading: {c.alternatives.join("; ")}.</p>
                  )}
                  <p className="m-0 text-text-muted">
                    {c.applyOn
                      ? `Applied automatically on ${c.applyOn} if left alone.`
                      : "Applied automatically after the configured number of sessions if left alone."}
                  </p>
                </div>
                <div className="mt-3">
                  <ReviewForm
                    id={c.id}
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
      <p className="m-0 text-sm">
        <Link href="/" className="text-accent underline">
          Home
        </Link>
      </p>
    </main>
  );
}
