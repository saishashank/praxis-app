// Small shared pieces of the expert and technique pages (M13-lite WP6). Server components, no state.
import Link from "next/link";

export const EXPERTS = "/reviews/experts";
export const TECHNIQUES = "/reviews/techniques";
export const QUEUE = "/reviews/experts/queue";
export const detailHref = (id: string): string => `${EXPERTS}/${encodeURIComponent(id)}`;
export const challengerLink = (id: string): string =>
  `/reviews/learned/challengers/${encodeURIComponent(id)}`;

/** A link out to a page that is not ours: new tab, no opener, no referrer (UXN-293, SEC-016). */
export function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 break-all text-accent underline"
    >
      {children}
    </a>
  );
}

/**
 * A stored third-party URL (SEC-016, D-631): a link when the loader passed it (`url`), its text when the host
 * is not registered (`urlText`), and "link hidden" for a masked viewer (neither). `label` is the link text
 * when there is one (an item title); the URL itself otherwise.
 */
export function Out({
  link,
  label,
}: {
  link: { url: string | null; urlText: string | null };
  label?: string | null;
}) {
  const words = label ?? link.urlText;
  if (link.url !== null) return <OutLink href={link.url}>{words}</OutLink>;
  if (link.urlText !== null)
    return (
      <span className="min-w-0 break-all" data-unlinked="">
        {words}
        {label ? ` (${link.urlText})` : ""}
      </span>
    );
  return (
    <span className="text-text-muted" data-link-hidden="">
      {label ?? "link hidden"}
    </span>
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
