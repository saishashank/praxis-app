// Calendar view of the Evening Reviews (UXN-206): one cell per day, a link to that day's review, with
// the stored per-currency day profit/loss as a glyph (sign + arrow, never colour alone, UXN-001) and,
// below the grid, the same figures as text. No FX blending (O-34): a currency gets its own glyph and
// line. A masked user sees one row per ISO week instead of days (UX-009). Server component.
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { GainLoss } from "@/components/ui/Values";
import { cn } from "@/components/ui/cn";
import { gainLossGlyph } from "@/lib/view/format";
import type { DayPl, ReviewCalendarModel } from "@/lib/ui/loaders/reviews";

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;

const tone = (v: number): string =>
  v > 0 ? "text-positive" : v < 0 ? "text-negative" : "text-text-muted";

function Glyphs({ pl }: { pl: DayPl[] }) {
  if (pl.length === 0) return <span className="text-text-muted">–</span>;
  return (
    <span className="inline-flex flex-wrap justify-center gap-x-1" aria-hidden="true">
      {pl.map((p) => (
        <span key={p.currency} className={cn("font-mono", tone(p.cents))}>
          {gainLossGlyph(p.cents)}
        </span>
      ))}
    </span>
  );
}

function PlText({ pl }: { pl: DayPl[] }) {
  if (pl.length === 0) return <span className="text-text-muted">No profit or loss recorded</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-3">
      {pl.map((p) => (
        <span key={p.currency}>
          <GainLoss value={p.cents}>{p.text}</GainLoss>{" "}
          <span className="text-xs">{p.currency}</span>
        </span>
      ))}
    </span>
  );
}

export function ReviewCalendar({ model }: { model: ReviewCalendarModel }) {
  const nav = (
    <nav aria-label="Month" className="flex flex-wrap items-center gap-3 text-sm">
      <Link
        href={`/reviews?view=calendar&month=${model.prev}`}
        className="text-accent underline"
        rel="prev"
      >
        Earlier month
      </Link>
      <span className="font-semibold">{model.monthLabel}</span>
      {model.next ? (
        <Link
          href={`/reviews?view=calendar&month=${model.next}`}
          className="text-accent underline"
          rel="next"
        >
          Later month
        </Link>
      ) : null}
    </nav>
  );

  if (model.masked) {
    return (
      <section aria-label="Calendar" className="flex min-w-0 flex-col gap-3">
        {nav}
        {model.maskedWeeks.length === 0 ? (
          <EmptyState compact motif="reviews" hue="reviews" title="No reviews in this month." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {model.maskedWeeks.map((w) => (
              <li
                key={w.week}
                className="min-w-0 rounded-lg border border-border bg-surface p-3 text-sm break-words"
              >
                <Link href={w.href} className="font-semibold text-accent underline">
                  Week {w.week}
                </Link>{" "}
                · {w.count} {w.count === 1 ? "review" : "reviews"}
                <div className="mt-1">
                  <PlText pl={w.pl} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const withReview = model.weeks.flat().filter((c) => c !== null && c.href !== "");
  return (
    <section aria-label="Calendar" className="flex min-w-0 flex-col gap-3">
      {nav}
      <table className="w-full table-fixed border-collapse text-center text-sm">
        <caption className="sr-only">Evening reviews in {model.monthLabel}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={short} scope="col" className="p-1 text-xs font-semibold text-text-muted">
                <abbr title={long} className="no-underline">
                  {short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.weeks.map((week, i) => (
            <tr key={i}>
              {week.map((c, j) => (
                <td key={j} className="border border-border p-0 align-top">
                  {c === null ? null : c.href === "" ? (
                    <span className="flex min-h-12 flex-col items-center justify-start p-1 text-text-muted">
                      <span>{c.day}</span>
                    </span>
                  ) : (
                    <Link
                      href={c.href}
                      aria-label={c.summary}
                      title={c.summary}
                      className="flex min-h-12 flex-col items-center justify-start gap-0.5 p-1 hover:bg-surface"
                    >
                      <span aria-hidden="true" className="font-semibold">
                        {c.day}
                        {c.partial ? "*" : ""}
                      </span>
                      <Glyphs pl={c.pl} />
                    </Link>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-xs text-text-muted">
        ▲ profit, ▼ loss, – none recorded, one mark per currency. * Partial review.
      </p>
      {withReview.length === 0 ? (
        <EmptyState compact motif="reviews" hue="reviews" title="No reviews in this month." />
      ) : (
        <ul aria-label="Day by day" className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {withReview.map((c) =>
            c === null ? null : (
              <li key={c.d} className="min-w-0 break-words">
                <Link href={c.href} className="text-accent underline">
                  {c.d}
                </Link>{" "}
                · {c.kindText} · <PlText pl={c.pl} />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
