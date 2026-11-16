// "Open in <name>" links (M21 B1, UXN-317, D-1218, D-1219). The ONLY place an Owner-tool surface writes an external
// address: each href is built by `brokerLinksFor` from a template the Owner typed, with only the encoded code and market
// filled in. It opens the Owner's own app or site in a new tab; nothing is ordered from here and no credential is sent.
import type { BrokerHref } from "@/lib/ownerTools/brokerLinks";

export function BrokerLinks({ links }: { links: readonly BrokerHref[] }) {
  if (links.length === 0) return null;
  return (
    <ul data-testid="broker-links" className="m-0 flex list-none flex-wrap gap-3 p-0 text-sm">
      {links.map((l) => (
        <li key={`${l.name}|${l.href}`}>
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            Open in {l.name}
          </a>
        </li>
      ))}
    </ul>
  );
}
