// Reviews tab: the Evening Review history (UX-080, UXN-113, UXN-206; M7 T17). A list (newest first,
// searchable by date and text, with the "pending" state during the 19:30-20:45 window, partial markers,
// the AI / no-AI badge and the email delivery status) and a calendar of the stored day profit/loss.
// Read-only for every role. A masked user (UX-009) sees ISO weeks and links by an opaque reference;
// the search never reaches review text for them (loader). "Mark as read" lives on the review page.
import Link from "next/link";
import { notFound } from "next/navigation";
import { Chips } from "@/components/ui/Nav";
import { Banner, EmptyState } from "@/components/ui/States";
import { SimulatedLabel } from "@/components/ui/Values";
import { requireUser } from "@/lib/auth/guard";
import {
  loadPendingState,
  loadReviewCalendar,
  loadReviewList,
  parseReviewsQuery,
  type ReviewListModel,
} from "@/lib/ui/loaders/reviews";
import { envFor } from "@/lib/ui/loaders/shell";
import { ReviewCalendar } from "./ReviewCalendar";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const PENDING_TEXT = {
  window:
    "Tonight's review is being prepared. It is usually ready about 20:00 and is sent by 20:45. It appears here as soon as it is stored.",
  late: "Tonight's review is late. It appears here as soon as it is stored.",
} as const;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/reviews");
  const env = await envFor(user);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const query = parseReviewsQuery(params);
  if (query === null) notFound();
  const calendar = query.view === "calendar";
  const model = calendar ? null : await loadReviewList(env, query);
  const cal = calendar ? await loadReviewCalendar(env, { month: query.month }) : null;
  const pendingState = model ? model.pendingState : await loadPendingState(env);

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="m-0 text-sm text-text-muted">
          The evening review of each day, as it was emailed.{" "}
          <Link href="/reviews/learned" className="text-accent underline">
            What the system learned
          </Link>{" "}
          ·{" "}
          <Link href="/reviews/glossary" className="text-accent underline">
            Glossary
          </Link>
        </p>
      </header>

      <Chips
        label="Review view"
        items={[
          { label: "List", href: "/reviews", current: !calendar },
          { label: "Calendar", href: "/reviews?view=calendar", current: calendar },
        ]}
      />

      {pendingState ? (
        <div data-pending={pendingState}>
          <Banner tone="info" title="Pending">
            {PENDING_TEXT[pendingState]}
          </Banner>
        </div>
      ) : null}

      {cal ? (
        <>
          <ReviewCalendar model={cal} />
          <SimulatedLabel />
        </>
      ) : model ? (
        <ListView model={model} q={query.q} />
      ) : null}
    </main>
  );
}

function ListView({ model, q }: { model: ReviewListModel; q: string | undefined }) {
  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return s ? `/reviews?${s}` : "/reviews";
  };
  return (
    <>
      <form action="/reviews" method="get" role="search" className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="rv-q" className="text-sm font-semibold">
            {model.masked ? "Search by week or kind" : "Search by date or text"}
          </label>
          <input
            id="rv-q"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            maxLength={20}
            placeholder={model.masked ? "2026-W43" : "2026-10 or a word"}
            className="min-h-10 w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-text"
          />
        </div>
        <button
          type="submit"
          className="min-h-10 rounded border border-border bg-surface px-4 py-2 text-sm font-semibold"
        >
          Search
        </button>
      </form>

      {model.state === "stale" && model.staleText ? (
        <Banner tone="warning" title="Out of date">
          {model.staleText}
        </Banner>
      ) : null}

      {model.rows.length === 0 ? (
        <EmptyState title={q ? "No reviews match" : "No reviews yet"}>
          {q
            ? "Try a different date, week or word."
            : "The first review appears after the evening run has stored one."}
        </EmptyState>
      ) : (
        <>
          {model.rows.some((r) => r.delivery.status === "suppressed_off") ? (
            <p className="m-0 text-sm text-text-muted">
              Email is switched off, so these reviews were not emailed. They are all here.
            </p>
          ) : null}
          <ul aria-label="Evening reviews" className="m-0 flex list-none flex-col gap-2 p-0">
            {model.rows.map((r) => (
              <li
                key={r.href}
                className="min-w-0 rounded-lg border border-border bg-surface p-3 text-sm break-words"
              >
                <Link href={r.href} className="text-base font-semibold text-accent underline">
                  {r.label}
                </Link>
                <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
                  <li className="rounded-md bg-surface-2 px-2 py-1 font-semibold">
                    {r.kindText}
                    {r.partial && !/partial/i.test(r.kindText) ? " (partial)" : ""}
                  </li>
                  <li
                    className="rounded-md bg-surface-2 px-2 py-1"
                    data-provenance={r.ai ? "ai" : "no-ai"}
                  >
                    {r.aiText}
                  </li>
                  {/* D-200: "email is switched off" is said once above the list, not on every row */}
                  {r.delivery.status === "suppressed_off" ? null : (
                    <li
                      className="rounded-md bg-surface-2 px-2 py-1"
                      data-delivery={r.delivery.status}
                    >
                      {r.delivery.text}
                    </li>
                  )}
                  <li className="rounded-md bg-surface-2 px-2 py-1">
                    {r.read ? "Read" : "Not read yet"}
                  </li>
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      {model.page > 1 || model.hasMore ? (
        <nav aria-label="Pages" className="flex gap-4 text-sm">
          {model.page > 1 ? (
            <Link href={qs(model.page - 1)} rel="prev" className="text-accent underline">
              Newer reviews
            </Link>
          ) : null}
          {model.hasMore ? (
            <Link href={qs(model.page + 1)} rel="next" className="text-accent underline">
              Older reviews
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
