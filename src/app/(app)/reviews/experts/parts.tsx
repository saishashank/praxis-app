// Small shared pieces of the expert and technique pages (M13-lite WP6). Server components, no state.
import Link from "next/link";

export const EXPERTS = "/reviews/experts";
export const TECHNIQUES = "/reviews/techniques";
export const QUEUE = "/reviews/experts/queue";
export const detailHref = (id: string): string => `${EXPERTS}/${encodeURIComponent(id)}`;
export const challengerLink = (id: string): string =>
  `/reviews/learned/challengers/${encodeURIComponent(id)}`;

/** A link out to a page that is not ours: no referrer, no ranking hint (UXN-293). */
export function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener nofollow noreferrer"
      className="min-w-0 break-all text-accent underline"
    >
      {children}
    </a>
  );
}

export function PageLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-accent underline">
      {children}
    </Link>
  );
}

export const pct = (v: number | null, digits = 2): string =>
  v === null ? "not measured" : `${v.toFixed(digits)}%`;
