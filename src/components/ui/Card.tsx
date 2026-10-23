// Card and Skeleton. Cards sit on `surface` with a `border`; nothing here draws a border on
// `surface-2` (D-130 known limit: that pair fails 3:1 in dark, midnight and dim).
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({
  title,
  headingLevel = 2,
  actions,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  actions?: ReactNode;
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section
      {...rest}
      className={cn(
        "ui-card min-w-0 break-words rounded-lg border border-border bg-surface p-4",
        className,
      )}
    >
      {title || actions ? (
        <div className="mb-3 flex items-start justify-between gap-2">
          {title ? (
            <Heading className="min-w-0 text-base font-semibold">{title}</Heading>
          ) : (
            <span />
          )}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const MAX_SKELETON_LINES = 12; // threshold-ok: placeholder line cap

/** Loading placeholder. One status region with a text label; the bars are decorative. */
export function Skeleton({
  lines = 3,
  label = "Loading",
  className,
}: {
  lines?: number;
  label?: string;
  className?: string;
}) {
  const n = Math.max(1, Math.min(MAX_SKELETON_LINES, Math.floor(lines)));
  return (
    <div role="status" aria-busy="true" className={cn("space-y-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          data-skeleton-line=""
          className={cn("h-4 animate-pulse rounded bg-surface-2", i === n - 1 && n > 1 && "w-2/3")}
        />
      ))}
    </div>
  );
}
