// Data review queue (UX-114, DAT-221). Owner only (ROL-102a). Unresolved corporate action
// conflicts on held or candidate codes, with the evidence, and Confirm / Reject. An item left
// alone is applied on the best evidence after the configured number of sessions and flagged.
import Link from "next/link";
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
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Data review queue</h1>
      <p className="mt-2 text-sm text-text-muted">
        Corporate actions where the sources disagree. New entries on these codes stay blocked until
        you decide. If you do nothing, the best-supported reading is applied automatically after the
        date shown, and flagged.
      </p>
      {cards.length === 0 ? (
        <p className="mt-6">Nothing is waiting for review.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {cards.map((c) => (
            <li key={c.id} className="rounded border border-border p-4">
              <h2 className="font-medium">
                {c.code}: {c.typeLabel}, ex-date {c.exDate}
              </h2>
              <p className="mt-1 text-sm">Reported terms: {c.terms}.</p>
              <p className="text-sm">
                Seen in: {c.sources.map((s) => SOURCE_TEXT[s] ?? s).join(", ") || "unknown"}.
              </p>
              {c.reasons.length > 0 && (
                <p className="text-sm">Why it is here: {c.reasons.join("; ")}.</p>
              )}
              {c.observed !== null && (
                <p className="text-sm">
                  The price on the ex-date was {(c.observed * 100).toFixed(1)}% of the day before.
                </p>
              )}
              {c.alternatives.length > 0 && (
                <p className="text-sm">Another reading: {c.alternatives.join("; ")}.</p>
              )}
              <p className="text-sm text-text-muted">
                {c.applyOn
                  ? `Applied automatically on ${c.applyOn} if left alone.`
                  : "Applied automatically after the configured number of sessions if left alone."}
              </p>
              <div className="mt-3">
                <ReviewForm
                  id={c.id}
                  confirm={confirmCorporateActionAction}
                  reject={rejectCorporateActionAction}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {blockedOnly > 0 && (
        <p className="mt-6 text-sm text-text-muted">
          {blockedOnly} more conflict(s) on codes that are neither held nor candidates are blocked
          for entry and will appear here if the code becomes one.
        </p>
      )}
      <p className="mt-8 text-sm">
        <Link href="/" className="text-accent underline">
          Home
        </Link>
      </p>
    </main>
  );
}
