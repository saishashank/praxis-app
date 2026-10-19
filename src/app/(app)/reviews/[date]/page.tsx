// Evening Review in the app (EML-010/015/036, design 4.6 step 5; decision 29 minimal read-only page).
// All signed-in roles read the stored review; only the Owner gets "Mark as read" (ROL-102a). The
// page shows the stored HTML (rendered once by the T4 template and frozen in `evening_review`) in a
// sandboxed frame, so what is read is exactly what was sent. Opening it never writes: an email-link
// arrival marks read through the POST action after load (decision 34).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { mainDb } from "@/lib/db/client";
import { listVersions, loadReview, readState } from "@/lib/review/assemble";
import { MarkRead } from "./MarkRead";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
          <iframe
            title={`Evening Review ${date}`}
            sandbox=""
            srcDoc={review.html}
            className="h-[80vh] w-full rounded border border-border bg-white"
          />
        </>
      )}
    </main>
  );
}
