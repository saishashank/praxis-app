// The alert chip on a pick tile and the company header (UXN-302): Armed with its limit, Hit with the quote
// time, or Cleared with the reason in words. A masked user sees the words and times, never the limit.
import type { AlertChipView } from "@/lib/ui/loaders/pickAlerts";
import { Money } from "@/components/ui/Values";
import { CLEAR_WORDS } from "./text";

export function AlertChip({ chip }: { chip: AlertChipView }) {
  const base =
    "inline-flex max-w-full flex-wrap items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold";
  if (chip.state === "armed") {
    return (
      <span data-testid="alert-chip" data-state="armed" className={`${base} bg-surface-2`}>
        Alert armed
        {chip.limit ? (
          <>
            {" with limit "}
            <Money micro={chip.limit.micro} />
          </>
        ) : null}
      </span>
    );
  }
  if (chip.state === "hit") {
    return (
      <span data-testid="alert-chip" data-state="hit" className={`${base} bg-surface-2`}>
        Hit at {chip.hitTime ?? "n/a"} (delayed quote)
      </span>
    );
  }
  return (
    <span data-testid="alert-chip" data-state="cleared" className={`${base} bg-surface-2`}>
      Cleared: {chip.reason ? (CLEAR_WORDS[chip.reason] ?? chip.reason) : "closed"}
    </span>
  );
}
