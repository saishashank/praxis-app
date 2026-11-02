// Steelman rule-review suggestions on /review (M11-lite WP6; AGT-133a, UXN-287; D-492). Owner only: the
// page is behind requireUser("admin") and the group is never drawn for anyone else. Nothing here changes a
// rule or a breaker: "Open rule editor" is a link to the family page, "Dismiss" is an audited action.
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { SuggestionView } from "@/lib/steelman/read";
import { DismissForm } from "./DismissForm";
import { dismissSuggestionAction } from "./actions";

export function Suggestions({ items }: { items: SuggestionView[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Rule suggestions" className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="m-0 text-lg font-semibold">Rule suggestions</h2>
        <p className="m-0 text-sm text-text-muted">
          AI-written points against a card that a rule could watch. They are ideas to look at, not
          advice or a forecast, and nothing changes unless you edit a rule yourself. They expire on
          their own.
        </p>
      </header>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {items.map((s) => (
          <li key={s.suggestionId} className="min-w-0">
            <Card title={`${s.code}, ${s.d}`} headingLevel={3} data-testid="steelman-suggestion">
              <p className="m-0 text-sm">{s.text}</p>
              {s.cited.length > 0 && (
                <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm text-text-muted">
                  {s.cited.map((e) => (
                    <li key={e.id} className="min-w-0">
                      <span className="font-medium text-text">{e.id}</span> {e.text}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                {s.cardId !== null && (
                  <Link
                    href={`/cards/${encodeURIComponent(s.cardId)}`}
                    className="text-accent underline"
                  >
                    Open the card
                  </Link>
                )}
                <Link
                  href={`/reviews/learned/families/${encodeURIComponent(s.family)}`}
                  className="text-accent underline"
                >
                  Open rule editor
                </Link>
                <DismissForm id={s.suggestionId} code={s.code} dismiss={dismissSuggestionAction} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
