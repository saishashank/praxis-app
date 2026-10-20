// The header bell (UXN-161): a link to the alert inbox with the unread count, coloured by the highest
// unacknowledged tier. The tier is also written (P0/P1/P2) so colour is never the only signal.
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { BELL_HREF } from "@/lib/ui/nav";
import { BellIcon } from "./icons";

export type BellView = { count: number; topTier: "P0" | "P1" | "P2" | null };

const TIER_DOT = { P0: "bg-danger", P1: "bg-warning", P2: "bg-text-muted" } as const;

export function bellLabel(bell: BellView): string {
  if (bell.count <= 0) return "Alerts, none waiting";
  const tier = bell.topTier ? `, highest ${bell.topTier}` : "";
  return `Alerts, ${bell.count} not yet acknowledged${tier}`;
}

export function AlertBell({ bell }: { bell: BellView }) {
  return (
    <Link
      href={BELL_HREF}
      aria-label={bellLabel(bell)}
      className="relative inline-flex min-h-10 min-w-10 items-center justify-center gap-1 rounded-md px-2 text-text hover:bg-surface-2"
    >
      <BellIcon />
      {bell.count > 0 ? (
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1 font-mono text-[11px] leading-4 text-text"
        >
          <span
            className={cn("inline-block h-2 w-2 rounded-full", TIER_DOT[bell.topTier ?? "P2"])}
          />
          {bell.count > 99 ? "99+" : bell.count}
          {bell.topTier ? <span className="font-sans">{bell.topTier}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}
