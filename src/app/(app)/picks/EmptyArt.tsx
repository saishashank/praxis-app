// Empty state of the Picks area (UXR-007, UXR-055): a small inline-SVG illustration in the section
// colour (currentColor = the accent), then the standard empty state with one sentence. Decorative only.
import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/States";

export function PicksEmptyArt({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div data-testid="picks-empty" className="flex min-w-0 flex-col items-center gap-3">
      <svg
        viewBox="0 0 96 64"
        width="96"
        height="64"
        aria-hidden="true"
        focusable="false"
        className="text-accent"
      >
        <rect x="14" y="10" width="68" height="44" rx="6" fill="currentColor" opacity="0.12" />
        <rect x="14" y="10" width="6" height="44" rx="3" fill="currentColor" />
        <path
          d="M30 24h40M30 33h28M30 42h18"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.55"
        />
        <circle cx="74" cy="44" r="9" fill="currentColor" opacity="0.2" />
        <path
          d="M74 39v5l3 2"
          stroke="currentColor"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <div className="w-full">
        <EmptyState title={title} action={action}>
          {children}
        </EmptyState>
      </div>
    </div>
  );
}
