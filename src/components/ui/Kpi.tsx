// KPI row (O-34: per currency, never an FX-converted total). A tile with a missing value says
// "Not measured yet"; a masked tile shows the lock mark.
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Masked, NotMeasured } from "./Values";

export function KpiTile({
  label,
  value,
  currency,
  note,
  masked,
}: {
  label: string;
  value?: ReactNode;
  /** Currency code shown beside the label ("AUD"); tiles of different currencies are never summed. */
  currency?: string;
  note?: ReactNode;
  masked?: boolean;
}) {
  const missing = value === null || value === undefined || value === "";
  return (
    <div className="ui-card min-w-0 rounded-lg border border-border bg-surface p-3">
      <dt className="break-words text-xs text-text-muted">
        {label}
        {currency ? <span className="ml-1">({currency})</span> : null}
      </dt>
      <dd className="mt-1 break-words text-xl font-semibold">
        {masked ? (
          <Masked />
        ) : missing ? (
          <NotMeasured />
        ) : (
          <span className="ui-kpi-value font-mono">{value}</span>
        )}
      </dd>
      {note ? <dd className="mt-1 break-words text-xs text-text-muted">{note}</dd> : null}
    </div>
  );
}

export function KpiRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      aria-label={label}
      className={cn("grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4", className)}
    >
      {children}
    </dl>
  );
}
