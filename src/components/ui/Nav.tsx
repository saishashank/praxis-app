// Link-based navigation primitives: Tabs, Chips, Breadcrumb + back link. State lives in the URL
// (D-128), so these are plain links with `aria-current` on the active one; no client code.
// UXR-002: the current item has three cues: a filled surface, a check, and a text cue (visually hidden
// "Selected"), never colour alone.
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";

export type NavItem = {
  href: string;
  label: ReactNode;
  current?: boolean;
  badge?: string | number;
};

function badgeText(b: string | number | undefined): string | null {
  return b === undefined || b === "" || b === 0 ? null : String(b);
}

export function Tabs({
  label,
  items,
  className,
}: {
  label: string;
  items: NavItem[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="m-0 flex list-none flex-wrap gap-1 border-b border-border p-0">
        {items.map((it) => (
          <li key={it.href} className="min-w-0">
            <Link
              href={it.href}
              aria-current={it.current ? "page" : undefined}
              className={cn(
                "ui-motion inline-flex min-h-6 items-center gap-1 px-3 py-2 text-sm break-words",
                it.current
                  ? "bg-surface-2 font-semibold text-text shadow-[inset_0_-2px_0_var(--color-accent)]"
                  : "text-text-muted hover:text-text",
              )}
            >
              {it.current ? <CheckIcon aria-hidden="true" /> : null}
              {it.label}
              {it.current ? <span className="sr-only"> (Selected)</span> : null}
              {badgeText(it.badge) ? (
                <span className="rounded-md bg-surface-2 px-1 text-xs text-text">
                  {badgeText(it.badge)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Filter / sort chips as links (state in the URL). */
export function Chips({
  label,
  items,
  className,
}: {
  label: string;
  items: NavItem[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {items.map((it) => (
          <li key={it.href} className="min-w-0">
            <Link
              href={it.href}
              aria-current={it.current ? "page" : undefined}
              className={cn(
                "ui-motion inline-flex min-h-6 items-center gap-1 rounded-full px-3 py-1 text-sm break-words",
                it.current
                  ? "bg-accent text-accent-contrast font-semibold"
                  : "bg-surface text-text border border-border hover:bg-bg",
              )}
            >
              {it.current ? <CheckIcon aria-hidden="true" /> : null}
              {it.label}
              {it.current ? <span className="sr-only"> (Selected)</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type Crumb = { href?: string; label: string };

/** Breadcrumb (UXN-033). The last crumb is the current page; `backHref` adds a visible back link. */
export function Breadcrumb({ items, backHref }: { items: Crumb[]; backHref?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
      {backHref ? (
        <Link
          href={backHref}
          className="inline-flex min-h-6 items-center gap-1 text-accent underline"
        >
          <ChevronLeftIcon width={14} height={14} />
          Back
        </Link>
      ) : null}
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
          {items.map((c, i) => {
            const last = i === items.length - 1;
            return (
              <li
                key={`${i}-${c.label}`}
                className="inline-flex min-w-0 items-center gap-1 break-words"
              >
                {c.href && !last ? (
                  <Link href={c.href} className="text-accent underline">
                    {c.label}
                  </Link>
                ) : (
                  <span
                    aria-current={last ? "page" : undefined}
                    className={last ? "font-semibold" : ""}
                  >
                    {c.label}
                  </span>
                )}
                {last ? null : (
                  <ChevronRightIcon width={12} height={12} className="text-text-muted" />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
