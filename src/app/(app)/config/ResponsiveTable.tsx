// Presentational table pieces (M7 T19c). A real <table> from 600 px up; below that every row
// becomes a card and each cell shows its column name (data-label). The markup keeps the table,
// row, rowheader and cell semantics, so labels, tests and screen readers see the same structure
// at every width, and nothing scrolls sideways at 360 px.
import type { ReactNode } from "react";

export function RTable({
  caption,
  headers,
  children,
}: {
  caption: string;
  headers: readonly string[];
  children: ReactNode;
}) {
  return (
    <table className="block w-full min-w-0 text-left text-sm sm:table sm:border-collapse">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only sm:not-sr-only sm:table-header-group">
        <tr>
          {headers.map((h) => (
            <th key={h} scope="col" className="border-b border-border px-2 py-2 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="block space-y-3 sm:table-row-group sm:space-y-0">{children}</tbody>
    </table>
  );
}

export function RRow({ children }: { children: ReactNode }) {
  return (
    <tr className="block min-w-0 rounded-lg border border-border bg-surface p-3 break-words sm:table-row sm:rounded-none sm:border-0 sm:border-b sm:bg-transparent sm:p-0">
      {children}
    </tr>
  );
}

/** First cell of a row: the row header (the card title on a phone). */
export function RHead({ children }: { children: ReactNode }) {
  return (
    <th
      scope="row"
      className="block min-w-0 pb-1 text-left font-semibold break-words sm:table-cell sm:px-2 sm:py-2 sm:align-top sm:font-medium"
    >
      {children}
    </th>
  );
}

export function RCell({
  label,
  children,
  className = "",
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <td
      data-label={label}
      className={`flex min-w-0 items-start justify-between gap-3 py-1 before:shrink-0 before:text-text-muted before:content-[attr(data-label)] sm:table-cell sm:px-2 sm:py-2 sm:align-top sm:before:hidden ${className}`}
    >
      <div className="min-w-0 text-right break-words sm:text-left">{children}</div>
    </td>
  );
}
