// The company list used by the Market tabs (UXN-270): one column definition, a table from 600 px up and
// stacked cards below it (DataTable). Every row has a star (Owner/Editor) and an "i" overview button, and
// the company name opens the company page. Masked rows show "Stock A" and no price or name (DAT-124).
import Link from "next/link";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { GainLoss, Masked } from "@/components/ui/Values";
import { formatCount, formatMicro } from "@/lib/view/format";
import type { MarketRow } from "@/lib/ui/loaders/market";
import { RowActions, type WatchMode } from "./RowActions";
import type { WatchResult } from "./messages";
import { PRICE_LABEL, volumeVsUsual } from "./text";

export function MarketTable({
  caption,
  rows,
  masked,
  mode,
  starAction,
  showVolume = true,
  empty,
}: {
  caption: string;
  rows: MarketRow[];
  masked: boolean;
  mode: WatchMode;
  starAction: (fd: FormData) => Promise<WatchResult>;
  /** The All companies table adds size group, sector and volume against usual. */
  showVolume?: boolean;
  empty: string;
}) {
  const columns: Column<MarketRow>[] = [
    {
      key: "company",
      header: "Company",
      cell: (r) => (
        <Link href={`/market/${encodeURIComponent(r.slug)}`} className="underline">
          {r.name ? (
            <>
              {r.name} <span className="font-mono text-text-muted">{r.stock}</span>
            </>
          ) : (
            r.stock
          )}
        </Link>
      ),
    },
    {
      key: "price",
      header: PRICE_LABEL,
      align: "right",
      cell: (r) =>
        r.close === null ? (
          <Masked />
        ) : (
          <span className="font-mono">{formatMicro(r.close.micro)}</span>
        ),
    },
    {
      key: "change",
      header: "Day change",
      align: "right",
      cell: (r) => <GainLoss value={r.changePpm} kind="ppm" />,
    },
    {
      key: "volume",
      header: "Volume",
      align: "right",
      cell: (r) => (
        <span className="font-mono">
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
  if (showVolume && !masked) {
    columns.push(
      { key: "size", header: "Size", cell: (r) => r.sizeGroup ?? "n/a" },
      { key: "sector", header: "Sector", cell: (r) => r.sector ?? "n/a" },
    );
  }
  columns.push({
    key: "watch",
    header: "Watch and overview",
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
  const visible = masked ? columns.filter((c) => c.key !== "price") : columns;
  return (
    <DataTable
      caption={caption}
      columns={visible}
      rows={rows}
      rowKey={(r) => r.slug}
      empty={<EmptyState title="Nothing to show">{empty}</EmptyState>}
    />
  );
}
