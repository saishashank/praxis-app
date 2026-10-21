// Badges. Text colours come from the label / regime / breaker token families (never the gain/loss
// pair, UXN-001) on `surface-2` with NO border (D-130). The exact official text is always visible
// beside the friendly text (D-128 decision 4); the hover text is in `title` as an extra only.
import type { ReactNode } from "react";
import { alertTierLabel, breakerLabel, regimeLabel, validationLabel } from "@/lib/view/terms";
import { cn } from "./cn";

function Pill({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full min-w-0 flex-col rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold leading-tight break-words",
        tone,
      )}
    >
      {children}
    </span>
  );
}

const LABEL_TONE: Readonly<Record<string, string>> = {
  UNVALIDATED: "text-label-unvalidated",
  "PASSED-BACKTEST": "text-label-passed",
  "CONSISTENT-FORWARD": "text-label-consistent",
  FAILED: "text-label-failed",
  "NOT-DEMONSTRATED": "text-label-notdemo",
  UNVALIDATABLE: "text-label-unvalidatable",
};

/** Validation label: friendly text first, the exact ARN-086 label as a second visible line. */
export function ValidationBadge({
  label,
  possibleLuck = false,
}: {
  label: string;
  /** "possible luck" is a separate flag, not a replacement for the label. */
  possibleLuck?: boolean;
}) {
  const f = validationLabel(label);
  const luck = validationLabel("possible luck");
  return (
    <span className="inline-flex flex-wrap items-start gap-1">
      <Pill tone={LABEL_TONE[label] ?? "text-label-unvalidated"} title={f.hover}>
        <span>{f.shown}</span>
        <span className="font-mono text-[0.7rem] font-normal">{label}</span>
      </Pill>
      {possibleLuck ? (
        <Pill tone="text-label-notdemo" title={luck.hover}>
          <span>{luck.shown}</span>
        </Pill>
      ) : null}
    </span>
  );
}

const REGIME_TONE: Readonly<Record<string, string>> = {
  SHOCK: "text-regime-shock",
  "RISK-OFF": "text-regime-riskoff",
  "RISK-ON": "text-regime-riskon",
  NEUTRAL: "text-regime-neutral",
};

/** Market mood: friendly text, the official regime name visible, and the "Market mood" caption. */
export function RegimeBadge({ regime }: { regime: string | null | undefined }) {
  const key = regime ?? "unknown";
  const f = regimeLabel(key);
  return (
    <Pill tone={REGIME_TONE[key] ?? "text-regime-neutral"} title={f.hover}>
      <span className="font-normal">Market mood</span>
      <span>{f.shown}</span>
      {key !== "unknown" ? (
        <span className="font-mono text-[0.7rem] font-normal">{key}</span>
      ) : null}
    </Pill>
  );
}

const BREAKER_TONE: Readonly<Record<string, string>> = {
  green: "text-breaker-green",
  amber: "text-breaker-amber",
  red: "text-breaker-red",
};
const BREAKER_MARK: Readonly<Record<string, string>> = { green: "●", amber: "▲", red: "■" };

/** Warning-signs status: colour AND a distinct shape AND words. */
export function BreakerStatus({ status }: { status: string | null | undefined }) {
  const key = status ?? "unknown";
  const f = breakerLabel(key);
  return (
    <Pill tone={BREAKER_TONE[key] ?? "text-label-unvalidated"} title={f.hover}>
      <span>
        <span aria-hidden="true">{BREAKER_MARK[key] ?? "○"} </span>
        {f.shown}
      </span>
    </Pill>
  );
}

const GRADES = ["L0", "L1", "L2", "L3"] as const;

/** Evidence grade L0 to L3; anything else is shown as "Grade n/a" rather than guessed. */
export function GradeBadge({ grade }: { grade: string | null | undefined }) {
  const ok = (GRADES as readonly string[]).includes(grade ?? "");
  return (
    <Pill tone="text-text">
      <span className="font-mono">{ok ? grade : "Grade n/a"}</span>
    </Pill>
  );
}

export function AlertTierBadge({ tier }: { tier: string }) {
  const f = alertTierLabel(tier);
  const tone = tier === "P0" ? "text-danger" : tier === "P1" ? "text-warning" : "text-text-muted";
  return (
    <Pill tone={tone} title={f.hover}>
      <span>{f.shown}</span>
    </Pill>
  );
}
