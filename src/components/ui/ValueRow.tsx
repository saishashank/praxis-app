// Value row (UXR-042, UXR-003): label on the left, the current value on the right in the text colour,
// a chevron; the whole row is the button or link. Without `href` it is a button (opens a sheet).
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "./cn";
import { ChevronRightIcon } from "./icons";

export function ValueRow({
  label,
  value,
  href,
  onClick,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  href?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  className?: string;
}) {
  const cls = cn(
    "ui-motion flex min-h-14 w-full items-center gap-3 border-b border-border bg-transparent px-1 py-2 text-left text-sm text-text hover:bg-bg",
    className,
  );
  const body = (
    <>
      <span className="min-w-0 flex-1 break-words">{label}</span>
      <span className="min-w-0 max-w-[55%] text-right font-medium break-words">{value}</span>
      <ChevronRightIcon aria-hidden="true" className="shrink-0 text-text-muted" />
    </>
  );
  return href !== undefined ? (
    <Link href={href} onClick={onClick} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}
