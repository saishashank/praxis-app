// The region menu (UXN-282, UX-003, UX-016): "AU · ASX · Data only" with every market and its status.
// Only an active market can be selected; the others are shown disabled with the reason (MKT-106).
// Totals are never converted between currencies (O-34), so the menu shows no money.
import Link from "next/link";
import { REGION_SETTINGS_HREF, regionLabel, regionStatus } from "@/lib/ui/nav";
import { GlobeIcon } from "./icons";
import { MenuButton } from "./MenuButton";

export type RegionMarket = { code: string; mode: string; currency: string };

export function RegionMenu({ market }: { market: RegionMarket | null }) {
  const label = regionLabel(market);
  const status = market ? regionStatus(market) : null;
  return (
    <MenuButton
      label={market ? `Region: ${label}` : "Region menu"}
      icon={<GlobeIcon />}
      text={label}
    >
      <p className="m-0 px-2 py-1 text-xs text-text-muted">Markets</p>
      {market && status ? (
        <ul className="m-0 list-none p-0">
          <li className="rounded-md px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">
                {market.code} · {market.currency}
              </span>
              <span className="text-xs text-text-muted">{status.text}</span>
            </div>
            <p className="m-0 mt-0.5 text-xs text-text-muted">
              {status.selectable ? "Selected" : status.reason}
            </p>
          </li>
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
