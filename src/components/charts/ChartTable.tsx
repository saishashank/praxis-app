import type { ReactNode } from "react";

/**
 * Text alternative for a chart (WCAG 1.1.1): a real table. `visible` false = visually hidden but
 * still read by screen readers; true = shown (the "Show as table" state of the interactive chart).
 */
export function ChartTable({
  caption,
  headers,
  rows,
  visible = false,
}: {
  caption: string;
  headers: string[];
  rows: ReactNode[][];
  visible?: boolean;
}) {
  return (
    <table className={visible ? "w-full text-sm font-mono" : "sr-only"}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) =>
              j === 0 ? (
                <th key={j} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={j}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
