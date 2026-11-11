// The company list used by the Market tabs (UXN-270): one column definition, a table from 600 px up and
// stacked cards below it (DataTable). Every row has a star (Owner/Editor) and an "i" overview button, and
// the company name opens the company page. Masked rows show "Stock A" and no price or name (DAT-124).
import Link from "next/link";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/Pill";
import { hueStyle } from "@/components/ui/hue";
import { Masked } from "@/components/ui/Values";
import {
  currencyFormatFor,
  displayName,
  formatCount,
  formatDay,
  formatMicro,
} from "@/lib/view/format";
import type { MarketRow } from "@/lib/ui/loaders/market";
import { Change, FIG } from "./Figures";
import { RowActions, type WatchMode } from "./RowActions";
import { sectorHueOf, sectorKey } from "./sectorHue";
import type { WatchResult } from "./messages";
import { volumeVsUsual } from "./text";

// D-916: the delayed price when one is stored, else the last close (each cell says which)
const TABLE_PRICE_LABEL = "Price";

/** D-205: Large / Mid / Small as a small colour-coded letter; the word is there for screen readers. */
const SIZE_STYLE: Record<string, { letter: string; dot: string }> = {
  Large: { letter: "L", dot: "bg-chart-1" },
  Mid: { letter: "M", dot: "bg-chart-2" },
  Small: { letter: "S", dot: "bg-chart-3" },
};

export function SizeBadge({ size }: { size: string | null }) {
  const s = size === null ? undefined : SIZE_STYLE[size];
  if (!s) return null;
  return (
    <span
      title={`${size} company`}
      className="inline-flex items-center gap-1 rounded border border-border px-1 align-middle text-[11px] font-semibold text-text"
    >
      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${s.dot}`} />
      <span aria-hidden="true">{s.letter}</span>
      <span className="sr-only">{size} company</span>
    </span>
  );
}

export function MarketTable({
  caption,
  day = null,
  rows,
  masked,
  mode,
  starAction,
  showVolume = true,
  empty,
}: {
  caption: string;
  /** The last session (YYYY-MM-DD): names the day of the "Change" column. Null for a masked viewer. */
  day?: string | null;
  rows: MarketRow[];
  masked: boolean;
  mode: WatchMode;
  starAction: (fd: FormData) => Promise<WatchResult>;
  /** The All companies table adds sector and volume against usual. */
  showVolume?: boolean;
  empty: string;
}) {
  const columns: Column<MarketRow>[] = [
    {
      key: "company",
      header: "Company",
      cell: (r) => {
        const hue = sectorHueOf(r.sector);
        const key = sectorKey(r.sector);
        return (
          <div
            data-sector-rail={key ?? "none"}
            style={hueStyle(hue ?? "outcome-flat")}
            className="flex min-w-0 items-stretch gap-2"
          >
            <span aria-hidden="true" className="w-1 shrink-0 rounded-full bg-[var(--h-fill)]" />
            <span className="flex min-w-0 flex-col items-start gap-1">
              <Link
                href={`/market/${encodeURIComponent(r.slug)}`}
                className="inline-flex min-h-6 items-center underline"
              >
                {r.name ? (
                  <>
                    {displayName(r.name)} <span className="ml-1 text-text-muted">{r.stock}</span>
                  </>
                ) : (
                  r.stock
                )}
              </Link>
              {r.sector && key ? (
                <Pill kind="sector" value={key}>
                  {r.sector}
                </Pill>
              ) : r.sector ? (
                <span className="text-xs text-text-muted">{r.sector}</span>
              ) : null}
            </span>
          </div>
        );
      },
    },
    {
      key: "sizeBadge",
      header: "Size",
      cell: (r) => <SizeBadge size={r.sizeGroup} />,
    },
    {
      key: "price",
      header: TABLE_PRICE_LABEL,
      align: "right",
      cell: (r) =>
        r.close === null ? (
          <Masked />
        ) : r.live ? (
          <span className="block">
            <span className={FIG}>
              {formatMicro(r.live.price.micro, currencyFormatFor(r.live.price.currency))}
            </span>
            <span className="block text-xs text-text-muted">delayed {r.live.at}</span>
          </span>
        ) : (
          <span className="block">
            <span className={FIG}>
              {formatMicro(r.close.micro, currencyFormatFor(r.close.currency))}
            </span>
            <span className="block text-xs text-text-muted">close</span>
          </span>
        ),
    },
    {
      key: "change",
      // the list is ranked by this session's change, so the column always shows it (D-919)
      header: day && !masked ? `Change ${formatDay(day)}` : "Last session change",
      align: "right",
      cell: (r) => <Change ppm={r.changePpm} />,
    },
    ...(!masked && rows.some((r) => r.live)
      ? [
          {
            key: "today",
            header: "Today (delayed)",
            align: "right" as const,
            // only a row with a stored delayed quote shows a figure; the others show nothing
            cell: (r: MarketRow) => (r.live ? <Change ppm={r.live.changePpm} /> : null),
          },
        ]
      : []),
    {
      key: "volume",
      header: "Volume",
      align: "right",
      cell: (r) => (
        <span className={FIG}>
          {formatCount(r.volume)}
          {showVolume ? (
            <span className="block text-xs text-text-muted">
              {volumeVsUsual(r.volumeVsUsualPpm)}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  columns.push({
    key: "watch",
    header: "Watch and overview",
    align: "right",
    cell: (r) => (
      <RowActions
        slug={r.slug}
        stock={r.stock}
        starred={r.starred}
        mode={mode}
        starAction={starAction}
      />
    ),
  });
  const visible = masked
    ? columns.filter((c) => c.key !== "price" && c.key !== "sizeBadge")
    : columns;
  return (
    <DataTable
      caption={caption}
      columns={visible}
      rows={rows}
      rowKey={(r) => r.slug}
      empty={
        <EmptyState motif="market" hue="market" title="Nothing to show">
          {empty}
        </EmptyState>
      }
    />
  );
}
