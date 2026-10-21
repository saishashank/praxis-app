// DataTable (UXN-017): one column definition renders a real <table> from 600 px up and a stacked card
// list below it, so a phone at 360 px never scrolls sideways. Sorting is by links (state in the URL,
// D-128): the page builds `sortHref` and the active direction; nothing here keeps state. Long text wraps
// (`break-words`, `min-w-0`); a missing cell shows "n/a" through the cell renderer, not blank.
import type { ReactNode } from "react";
import { cn } from "./cn";
import { ArrowDownIcon, ArrowUpIcon } from "./icons";

export type SortDir = "asc" | "desc";

export type Column<Row> = {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: "left" | "right";
  /** Link that sorts by this column; its presence makes the header sortable. */
  sortHref?: string;
  /** Set on the column the data is currently sorted by. */
  sorted?: SortDir;
  /** Hide this column from the stacked card view (e.g. when it repeats the card title). */
  hideInCard?: boolean;
};

export type DataTableProps<Row> = {
  caption: string;
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  /** Shown instead of the table when there are no rows (an EmptyState element). */
  empty?: ReactNode;
  className?: string;
};

const AS_ARIA: Record<SortDir, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const first = columns[0];
  const cardCols = columns.filter((c) => !c.hideInCard);
  return (
    <div className={cn("min-w-0", className)}>
      <table className="hidden w-full table-fixed border-collapse text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={c.sorted ? AS_ARIA[c.sorted] : undefined}
                className={cn(
                  "border-b border-border px-2 py-2 font-semibold break-words",
                  c.align === "right" ? "text-right" : "text-left",
                )}
              >
                {c.sortHref ? (
                  <a
                    href={c.sortHref}
                    className="inline-flex min-h-6 items-center gap-1 underline-offset-2 hover:underline"
                  >
                    {c.header}
                    {c.sorted === "asc" ? <ArrowUpIcon width={12} height={12} /> : null}
                    {c.sorted === "desc" ? <ArrowDownIcon width={12} height={12} /> : null}
                  </a>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border">
              {columns.map((c, i) => {
                const Cell = i === 0 ? "th" : "td";
                return (
                  <Cell
                    key={c.key}
                    scope={i === 0 ? "row" : undefined}
                    className={cn(
                      "min-w-0 px-2 py-2 break-words align-top",
                      i === 0 && "text-left font-medium",
                      c.align === "right" && "text-right",
                    )}
                  >
                    {c.cell(row)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <ul aria-label={caption} className="m-0 list-none space-y-3 p-0 sm:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="min-w-0 break-words rounded-lg border border-border bg-surface p-3"
          >
            {first ? <div className="font-semibold">{first.cell(row)}</div> : null}
            <dl className="mt-2 space-y-1">
              {cardCols.slice(first && !first.hideInCard ? 1 : 0).map((c) => (
                <div key={c.key} className="flex min-w-0 justify-between gap-3">
                  <dt className="shrink-0 text-text-muted">{c.header}</dt>
                  <dd className="m-0 min-w-0 break-words text-right">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
