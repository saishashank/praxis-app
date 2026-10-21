// Empty, stale and notice states (docs/M7_design.md 2.10) plus ShowDetails. Fixed texts come from the
// caller or src/lib/view; "SAMPLE DATA" never appears here (UX-102).
import type { ReactNode } from "react";
import type { Staleness } from "@/lib/view/staleness";
import { cn } from "./cn";
import { AlertIcon, InfoIcon } from "./icons";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-6 text-center break-words">
      <p className="m-0 font-semibold">{title}</p>
      {children ? (
        <p className="mx-auto mt-2 max-w-prose text-sm text-text-muted">{children}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export type BannerTone = "info" | "warning" | "danger";

const BANNER_TONE: Record<BannerTone, string> = {
  info: "text-text",
  warning: "text-warning",
  danger: "text-danger",
};

/** A notice under the header or above a section. `danger` and `warning` announce themselves. */
export function Banner({
  tone = "info",
  title,
  children,
}: {
  tone?: BannerTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border border-border bg-surface p-3 text-sm break-words",
        BANNER_TONE[tone],
      )}
    >
      {tone === "info" ? (
        <InfoIcon className="mt-0.5 shrink-0" />
      ) : (
        <AlertIcon className="mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        {title ? <p className="m-0 font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** Banner for old data, from `staleness()`; renders nothing while the data is fresh. */
export function StaleBanner({ status }: { status: Staleness }) {
  if (status.state === "fresh") return null;
  return (
    <Banner tone="warning" title={status.state === "missing" ? "No data yet" : "Out of date"}>
      {status.text}
    </Banner>
  );
}

/** Progressive disclosure with the native element: keyboard and screen-reader support for free. */
export function ShowDetails({
  summary = "Show details",
  children,
  open,
}: {
  summary?: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="min-w-0 break-words">
      <summary className="inline-flex min-h-6 cursor-pointer items-center py-1 text-accent underline">
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
