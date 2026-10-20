// Evening Review in the app (EML-010/015/036, design 4.6 step 5; decision 29 minimal read-only page).
// All signed-in roles read the stored review; only the Owner gets "Mark as read" (ROL-102a). The
// page shows the stored HTML (rendered once by the T4 template and frozen in `evening_review`) in a
// sandboxed frame, so what is read is exactly what was sent. Opening it never writes: an email-link
// arrival marks read through the POST action after load (decision 34).
// Masking (DAT-124, ROL-107, UX-009; D-128): the stored HTML holds stock codes, prices and links, so
// only the Owner and users with a live unmask grant get it. Everyone else gets the masked view model
// built from the stored facts (@/lib/view/reviews): "Stock A", no prices, no links, no raw HTML.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { authDb, mainDb } from "@/lib/db/client";
import { listVersions, loadReview, readState } from "@/lib/review/assemble";
import { activeCodesForDate } from "@/lib/view/active";
import { loadMaskLookup, maskContextFor, StockAliases } from "@/lib/view/mask";
import {
  factCodes,
  maskedReview,
  parseFacts,
  reviewLeaks,
  type MaskedReview,
} from "@/lib/view/reviews";
import { MarkRead } from "./MarkRead";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKET = "AU"; // the only market until a second one activates (ROL-107)
const KIND_TEXT: Record<string, string> = {
  full: "complete",
  partial: "partial",
  minimal: "minimal",
  non_trading: "non-trading day",
};

export default async function ReviewDatePage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ v?: string; src?: string }>;
}) {
  const { date } = await params;
  if (!DATE_RE.test(date)) notFound();
  const user = await requireUser("read", `/reviews/${date}`);
  const sp = await searchParams;
  const db = mainDb();
  const versions = await listVersions(db, date);
  const wanted = sp.v !== undefined && /^\d{1,4}$/.test(sp.v) ? Number(sp.v) : undefined;
  const review = versions.length ? await loadReview(db, date, wanted) : null;
  const read = await readState(db, date);
  const owner = can(user.role, "admin");
  const ctx = await maskContextFor(user, authDb());
  // Masked users: build the view model on the server; null means "unavailable" (fail closed).
  let masked: MaskedReview | null = null;
  if (ctx.masked && review !== null) {
    const row = await db.execute({
      sql: "SELECT facts_json FROM evening_review WHERE d = ? AND version = ?",
      args: [date, review.version],
    });
    const facts = row.rows.length ? parseFacts(String(row.rows[0]!.facts_json)) : null;
    if (facts !== null) {
      const active = await activeCodesForDate(db, MARKET, date);
      const aliases = new StockAliases([...active, ...factCodes(facts)]);
      const lookup = await loadMaskLookup(db, MARKET);
      const view = maskedReview(facts, aliases, lookup);
      const names = aliases.codes().map((c) => lookup.names.get(c) ?? "");
      masked = reviewLeaks(view, aliases.codes(), names) ? null : view;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Evening Review {date}</h1>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>
      {review === null ? (
        <p role="status">No review is stored for {date}.</p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Version {review.version} ({KIND_TEXT[review.kind] ?? review.kind}), stored{" "}
            {review.createdAt}. {read ? `Read ${read.readAt}.` : "Not marked as read yet."}
          </p>
          {versions.length > 1 && (
            <nav aria-label="Versions" className="flex gap-3 text-sm">
              {versions.map((v) => (
                <Link
                  key={v.version}
                  href={`/reviews/${date}?v=${v.version}`}
                  className="text-accent underline"
                >
                  v{v.version} ({KIND_TEXT[v.kind] ?? v.kind})
                </Link>
              ))}
            </nav>
          )}
          {owner && <MarkRead date={date} auto={sp.src === "email"} alreadyRead={read !== null} />}
          {!ctx.masked ? (
            <iframe
              title={`Evening Review ${date}`}
              sandbox=""
              srcDoc={review.html}
              className="h-[80vh] w-full rounded border border-border bg-white"
            />
          ) : masked === null ? (
            <p role="status">This review cannot be shown at your access level.</p>
          ) : (
            <MaskedBody view={masked} />
          )}
        </>
      )}
    </main>
  );
}

function MaskedBody({ view }: { view: MaskedReview }) {
  const list = (items: string[]) =>
    items.length === 0 ? (
      <p className="text-sm text-text-muted">Nothing to show.</p>
    ) : (
      <ul className="list-disc pl-5 text-sm">
        {items.map((x, i) => (
          <li key={`${i}:${x}`}>{x}</li>
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="text-sm">
        {view.notice}
      </p>
      <section aria-labelledby="mr-summary" className="flex flex-col gap-2">
        <h2 id="mr-summary" className="text-xl font-semibold">
          Summary
        </h2>
        {list(view.summary)}
      </section>
      <section aria-labelledby="mr-orders" className="flex flex-col gap-2">
        <h2 id="mr-orders" className="text-xl font-semibold">
          Investments made today
        </h2>
        {list(view.orders)}
      </section>
      {view.narrative.map((n) => (
        <section key={n.heading} className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold">{n.heading}</h2>
          {list(n.items)}
        </section>
      ))}
      <section aria-labelledby="mr-alerts" className="flex flex-col gap-2">
        <h2 id="mr-alerts" className="text-xl font-semibold">
          Alerts
        </h2>
        {list(view.alerts)}
      </section>
      <section aria-labelledby="mr-health" className="flex flex-col gap-2">
        <h2 id="mr-health" className="text-xl font-semibold">
          System health
        </h2>
        {list(view.health)}
      </section>
    </div>
  );
}
