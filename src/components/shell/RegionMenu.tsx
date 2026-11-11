// The region/mode chip (UXR-005; UXN-282, UX-003, UX-016): "AU · ASX" with a dot (grey in data-only
// mode, "AU" on phones); its menu lists every market and its status. The accessible name keeps the
// mode in words, so the dot is never the only signal.
// Only an active market can be selected; the others are shown disabled with the reason (MKT-106).
// Totals are never converted between currencies (O-34), so the menu shows no money.
import Link from "next/link";
import {
  REGION_SETTINGS_HREF,
  regionChip,
  regionDot,
  regionLabel,
  regionStatus,
} from "@/lib/ui/nav";
import { MenuButton } from "./MenuButton";

export type RegionMarket = {
  code: string;
  mode: string;
  currency: string;
  exchange?: string | null;
};

export function RegionMenu({
  market,
  markets = [],
}: {
  market: RegionMarket | null;
  /** The enabled markets (D-997). With several, each is a link that switches the page to it. */
  markets?: RegionMarket[];
}) {
  const label = regionLabel(market);
  const listed = markets.length > 0 ? markets : market ? [market] : [];
  return (
    <MenuButton
      label={market ? `Region: ${label}` : "Region menu"}
      icon={
        <span
          aria-hidden="true"
          data-region-dot={market ? regionDot(market.mode) : "grey"}
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            background:
              market && regionDot(market.mode) === "active"
                ? "var(--color-positive-fill)"
                : "var(--color-outcome-flat-fill)",
          }}
        />
      }
      text={regionChip(market)}
      shortText={market ? market.code : "Region"}
    >
      <p className="m-0 px-2 py-1 text-xs text-text-muted">Markets</p>
      {listed.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {listed.map((m) => {
            const status = regionStatus(m);
            const selected = market !== null && m.code === market.code;
            const body = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {m.code} · {m.currency}
                  </span>
                  <span className="text-xs text-text-muted">{status.text}</span>
                </div>
                <p className="m-0 mt-0.5 text-xs text-text-muted">
                  {status.selectable
                    ? selected
                      ? "Selected"
                      : "Switch to this market"
                    : (status.reason ?? "")}
                </p>
              </>
            );
            return (
              <li key={m.code} data-market={m.code} className="rounded-md px-2 py-1.5">
                {listed.length > 1 && !selected && status.selectable ? (
                  <Link href={`?market=${m.code}`} className="block hover:bg-surface-2">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 px-2 py-1.5 text-text-muted">Market information is not available.</p>
      )}
      <Link
        href={REGION_SETTINGS_HREF}
        className="mt-1 flex min-h-10 items-center rounded-md px-2 text-accent underline hover:bg-surface-2"
      >
        Region &amp; markets settings
      </Link>
    </MenuButton>
  );
}
