"use client";
// Watchlist star (UXN-047). A form button that calls the `watchlist` server action; the server
// refuses anyone the role matrix does not allow, whatever this component renders (UX-004). Owners
// star into the Sentinel watch-list, Editors into a personal list. Viewers get no star at all.
import { useActionState } from "react";
import { watchErrorText, type WatchResult } from "./messages";

function StarShape({ filled }: { filled: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

const BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface p-0 text-text hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60";

export function StarButton({
  code,
  starred,
  action,
}: {
  /** The real code (only unmasked users ever get a star). */
  code: string;
  starred: boolean;
  action: (fd: FormData) => Promise<WatchResult>;
}) {
  const [result, run, pending] = useActionState<WatchResult | null, FormData>(
    async (_prev, fd) => action(fd),
    null,
  );
  const on = result !== null && "ok" in result ? result.starred : starred;
  return (
    <form action={run} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="state" value={on ? "off" : "on"} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={on}
        aria-label={on ? `Remove ${code} from watchlist` : `Add ${code} to watchlist`}
        className={BUTTON}
      >
        <StarShape filled={on} />
      </button>
      {result !== null && "error" in result ? (
        <span role="alert" className="max-w-48 text-xs text-danger">
          {watchErrorText(result.error)}
        </span>
      ) : null}
    </form>
  );
}

/** A star the person cannot use (UX-004: Editors see the control disabled, with the reason in words). */
export function StarDisabled({ label, reason }: { label: string; reason: string }) {
  return (
    <button type="button" disabled aria-label={`${label}: ${reason}`} className={BUTTON}>
      <StarShape filled={false} />
    </button>
  );
}
