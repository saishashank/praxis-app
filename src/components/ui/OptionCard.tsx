// Option card (UXR-041, UXR-002): a choice with a name and a short line. At least 56 px high; the
// selected card is filled, shows a check and the word "Current". Use inside OptionGrid (2 columns from
// 600 px). Button mode (`onSelect`) or link mode (`href`).
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon } from "./icons";

export function OptionGrid({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid grid-cols-1 gap-2 min-[600px]:grid-cols-2", className)}
    >
      {children}
    </div>
  );
}

export function OptionCard({
  title,
  description,
  selected,
  onSelect,
  href,
  preview,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  selected: boolean;
  onSelect?: () => void;
  href?: string;
  /** Optional swatch or preview shown on the left. */
  preview?: ReactNode;
  className?: string;
}) {
  const cls = cn(
    "ui-motion flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm break-words",
    selected
      ? "border-accent bg-accent text-accent-contrast"
      : "border-border bg-surface text-text hover:bg-bg",
    className,
  );
  const body = (
    <>
      {preview ? <span className="shrink-0">{preview}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {description ? (
          <span className={cn("block text-xs", selected ? "" : "text-text-muted")}>
            {description}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
          <CheckIcon aria-hidden="true" />
          Current
        </span>
      ) : null}
    </>
  );
  if (href !== undefined) {
    return (
      <Link href={href} aria-current={selected ? "true" : undefined} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className={cls}>
      {body}
    </button>
  );
}
