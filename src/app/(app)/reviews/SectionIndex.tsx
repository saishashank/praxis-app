// Section index of a review (UXR-026, UXR-052): the reading page lists its sections, each with a small
// two-tone icon in the colour of its section (the Reviews hue for the whole page, so every icon is
// tinted by `--color-section-*`). Linked items jump to the section; unlinked ones only name it.
import type { CSSProperties } from "react";

export type SectionTone = "home" | "picks" | "market" | "strategies" | "news" | "reviews";

export type SectionItem = {
  /** Anchor id on the page, when the section can be jumped to. */
  id?: string;
  label: string;
  tone: SectionTone;
  /** The section was not ready when this version was stored (partial review). */
  missing?: boolean;
};

/** The review's own ten headings (EML-012) in index order, each with the colour of its icon. */
export const REVIEW_TONES: readonly SectionTone[] = [
  "home", // 1 Headline scorecard
  "strategies", // 2 Investments made today
  "market", // 3 Profit / loss
  "reviews", // 4 What was learned today
  "picks", // 5 What worked better and why
  "news", // 6 What needs improving
  "home", // 7 Overall picture
  "strategies", // 8 Sentinel recap
  "market", // 9 System & quota health
];

export function SectionIcon({ tone }: { tone: SectionTone }) {
  const color = `var(--color-section-${tone})`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      data-section-icon={tone}
      style={{ color } as CSSProperties}
      className="shrink-0"
    >
      <rect x="4" y="3" width="16" height="18" rx="3" fill="currentColor" opacity="0.18" />
      <rect x="4" y="3" width="4" height="18" rx="2" fill="currentColor" />
      <path
        d="M11 9h6M11 13h6M11 17h4"
        stroke="var(--color-border)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function SectionIndex({ items }: { items: SectionItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Sections of this review" data-testid="review-index">
      <ol className="m-0 grid list-none gap-1 p-0 text-sm sm:grid-cols-2">
        {items.map((it) => (
          <li
            key={it.label}
            data-tone={it.tone}
            className="flex min-w-0 items-center gap-2 rounded-md bg-surface-2 px-2 py-1 break-words"
          >
            <SectionIcon tone={it.tone} />
            {it.id ? (
              <a href={`#${it.id}`} className="text-accent underline">
                {it.label}
              </a>
            ) : (
              <span>{it.label}</span>
            )}
            {it.missing ? <span className="text-text-muted">(not ready)</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
