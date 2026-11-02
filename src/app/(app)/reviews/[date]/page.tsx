// Evening Review in the app (UX-080, UXN-113, EML-010/015/036, design 4.6 step 5; M7 T17).
// All signed-in roles read the stored review; only the Owner gets "Mark as read" (ROL-102a). The
// page shows the stored HTML (rendered once by the T4 template and frozen in `evening_review`) in a
// sandboxed frame, so what is read is exactly what was sent. Opening it never writes: an email-link
// arrival marks read through the POST action after load (decision 34). Beside it: the AI / no-AI
// badge (UXN-113), the partial marker, the delivery status and section 7a "New picks".
// Masking (DAT-124, ROL-107, UX-009; D-128): the stored HTML holds stock codes, prices and links, so
// only the Owner and users with a live unmask grant get it. Everyone else gets the masked view model
// built from the stored facts (@/lib/view/reviews): "Stock A", no prices, no links, no raw HTML, and
// ISO weeks in place of timestamps. The list and the calendar link a masked user by the opaque
// `rv-` reference (D-144); a typed date still opens, as before.
import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner, EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { envFor, isDateParam } from "@/lib/ui/loaders/shell";
import { isReviewRef, loadReviewPage } from "@/lib/ui/loaders/reviews";
import type { MaskedReview } from "@/lib/view/reviews";
import { REVIEW_SECTION_NAMES } from "@/lib/review/facts";
import {
  REVIEW_TONES,
  SectionIcon,
  SectionIndex,
  type SectionItem,
  type SectionTone,
} from "../SectionIndex";
import { MarkRead } from "./MarkRead";
import { NewPicks } from "./NewPicks";

/** D-200: a stored UTC timestamp reads as Melbourne time; an ISO week (masked) stays as it is. */
const STAMP_RE = /^d{4}-d{2}-d{2}T/;
const localTime = (v: string): string =>
  STAMP_RE.test(v) && !Number.isNaN(Date.parse(v))
    ? new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Melbourne",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(v))
    : v;

export const dynamic = "force-dynamic";

export default async function ReviewDatePage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ v?: string; src?: string }>;
}) {
  const { date: raw } = await params;
  const date = safeDecode(raw);
  if (!isDateParam(date) && !isReviewRef(date)) notFound();
  const user = await requireUser("read", `/reviews/${date}`);
  const sp = await searchParams;
  const wanted = sp.v !== undefined && /^\d{1,4}$/.test(sp.v) ? Number(sp.v) : undefined;
  const env = await envFor(user);
  const model = await loadReviewPage(env, date, wanted);
  if (model === null && isReviewRef(date)) notFound();
  const base = `/reviews/${encodeURIComponent(date)}`;

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {model === null ? `Evening Review ${date}` : model.title}
        </h1>
        <Link href="/reviews" className="text-sm text-accent underline">
          All reviews
        </Link>
      </header>
      {model === null ? (
        <div role="status">
          <EmptyState
            compact
            motif="reviews"
            hue="reviews"
            title={`No review is stored for ${date}.`}
          />
        </div>
      ) : (
        <>
          <ul
            aria-label="About this review"
            className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm"
          >
            <li className="rounded-md bg-surface-2 px-2 py-1 font-semibold">{model.kindText}</li>
            <li
              className="rounded-md bg-surface-2 px-2 py-1 font-semibold"
              data-provenance={model.ai ? "ai" : "no-ai"}
            >
              {model.aiText}
            </li>
            <li className="rounded-md bg-surface-2 px-2 py-1" data-delivery={model.delivery.status}>
              {model.delivery.text}
            </li>
          </ul>
          <p className="m-0 text-sm text-text-muted">
            Version {model.version} ({model.kindText.toLowerCase()}), stored{" "}
            {localTime(model.createdAt)}.{" "}
            {model.read ? `Read ${localTime(model.read.readAt)}.` : "Not marked as read yet."}
          </p>
          {model.kind === "partial" ? (
            <Banner tone="warning" title="Partial review">
              {model.missing.length > 0
                ? `This review was sent before everything was ready. Missing sections: ${model.missing
                    .map((m) => `${m.n}. ${m.name}`)
                    .join("; ")}. A complete version is stored later when the data arrives.`
                : "This review was sent before everything was ready. A complete version is stored later when the data arrives."}
            </Banner>
          ) : null}
          {model.versions.length > 1 && (
            <nav aria-label="Versions" className="flex flex-wrap gap-3 text-sm">
              {model.versions.map((v) => (
                <Link
                  key={v.version}
                  href={`${base}?v=${v.version}`}
                  className="text-accent underline"
                >
                  v{v.version} ({v.kindText.toLowerCase()})
                </Link>
              ))}
            </nav>
          )}
          <SectionIndex items={indexOf(model)} />
          {model.canMarkRead && (
            <MarkRead date={model.d} auto={sp.src === "email"} alreadyRead={model.read !== null} />
          )}
          {model.html !== null ? (
            <iframe
              title={`Evening Review ${model.d}`}
              sandbox=""
              srcDoc={model.html}
              className="h-[80vh] w-full rounded border border-border bg-white"
            />
          ) : model.maskedView === null ? (
            <p role="status">This review cannot be shown at your access level.</p>
          ) : (
            <MaskedBody view={model.maskedView} />
          )}
          {model.newPicks ? <NewPicks picks={model.newPicks} masked={model.masked} /> : null}
          {model.newPicksHidden ? (
            <p role="note" className="m-0 text-sm text-text-muted">
              New picks are not shown at your access level.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

/** Index of the reading page: the masked view's own sections (linked), or the review's headings. */
function indexOf(model: NonNullable<Awaited<ReturnType<typeof loadReviewPage>>>): SectionItem[] {
  if (model.maskedView !== null) {
    const v = model.maskedView;
    return [
      { id: "mr-summary", label: "Summary", tone: "home" },
      { id: "mr-orders", label: "Investments made today", tone: "strategies" },
      ...v.narrative.map((n, i) => ({
        id: `mr-n${i}`,
        label: n.heading,
        tone: NARRATIVE_TONES[i % NARRATIVE_TONES.length]!,
      })),
      { id: "mr-alerts", label: "Alerts", tone: "news" as SectionTone },
      { id: "mr-health", label: "System health", tone: "market" as SectionTone },
    ];
  }
  if (model.html === null) return [];
  const missing = new Set(model.missing.map((m) => m.n));
  return REVIEW_SECTION_NAMES.slice(0, REVIEW_TONES.length).map((label, i) => ({
    label,
    tone: REVIEW_TONES[i]!,
    missing: missing.has(i + 1),
  }));
}

const NARRATIVE_TONES: readonly SectionTone[] = ["reviews", "picks", "news"];

function H2({ id, tone, children }: { id?: string; tone: SectionTone; children: string }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-xl font-semibold">
      <SectionIcon tone={tone} />
      {children}
    </h2>
  );
}

function MaskedBody({ view }: { view: MaskedReview }) {
  const list = (items: string[]) =>
    items.length === 0 ? (
      <p className="text-sm text-text-muted">Nothing to show.</p>
    ) : (
      <ul className="list-disc pl-5 text-sm">
        {items.map((x, i) => (
          <li key={`${i}:${x}`} className="break-words">
            {x}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="text-sm">
        {view.notice}
      </p>
      <section aria-labelledby="mr-summary" className="flex flex-col gap-2">
        <H2 id="mr-summary" tone="home">
          Summary
        </H2>
        {list(view.summary)}
      </section>
      <section aria-labelledby="mr-orders" className="flex flex-col gap-2">
        <H2 id="mr-orders" tone="strategies">
          Investments made today
        </H2>
        {list(view.orders)}
      </section>
      {view.narrative.map((n, i) => (
        <section key={n.heading} className="flex flex-col gap-2">
          <H2 id={`mr-n${i}`} tone={NARRATIVE_TONES[i % NARRATIVE_TONES.length]!}>
            {n.heading}
          </H2>
          {list(n.items)}
        </section>
      ))}
      <section aria-labelledby="mr-alerts" className="flex flex-col gap-2">
        <H2 id="mr-alerts" tone="news">
          Alerts
        </H2>
        {list(view.alerts)}
      </section>
      <section aria-labelledby="mr-health" className="flex flex-col gap-2">
        <H2 id="mr-health" tone="market">
          System health
        </H2>
        {list(view.health)}
      </section>
    </div>
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}
