// The small menu of the Owner tools (M21 B1). Rendered by each Owner-tool page AFTER its guard, never by a layout (a
// layout could render for someone the guard turns away). B2 adds Trades here.
import Link from "next/link";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/recommendations", label: "Recommendations" },
  { href: "/holdings", label: "Holdings" },
];

export function OwnerToolsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Owner tools" className="flex flex-wrap gap-3 text-sm">
      {LINKS.map((l) =>
        l.href === current ? (
          <span key={l.href} aria-current="page" className="font-semibold">
            {l.label}
          </span>
        ) : (
          <Link key={l.href} href={l.href} className="text-accent underline">
            {l.label}
          </Link>
        ),
      )}
      <Link href="/picks" className="text-accent underline">
        Picks
      </Link>
    </nav>
  );
}
