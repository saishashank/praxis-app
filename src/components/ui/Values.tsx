// Number and value primitives (UXN-001, UXN-002, UX-002, UX-041). Money and gain/loss never rely on
// colour alone: sign + arrow + words in the accessible name. Missing values show "Not measured yet"
// (never 0 or blank); masked values show a lock mark, never a partial value (DAT-124).
import type { ReactNode } from "react";
import {
  formatCents,
  formatMicro,
  formatPercent,
  formatPpm,
  gainLossGlyph,
  gainLossWord,
  MISSING,
  type SignStyle,
} from "@/lib/view/format";
import { NOTHING_YET } from "@/lib/view/honesty";
import { cn } from "./cn";
import { LockIcon } from "./icons";

export const MASKED_TEXT = "Hidden for your role";

export function NotMeasured({ children = NOTHING_YET }: { children?: ReactNode }) {
  return <span className="text-text-muted italic">{children}</span>;
}

export function Masked({ label = MASKED_TEXT, className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-text-muted", className)}>
      <LockIcon width={12} height={12} />
      <span>{label}</span>
    </span>
  );
}

type MoneyProps = {
  cents?: number | null;
  micro?: string | bigint | number | null;
  sign?: SignStyle;
  masked?: boolean;
  className?: string;
};

/** Simulated money (`data-money`; always read together with a Simulated label on the page, UX-002). */
export function Money({ cents, micro, sign, masked, className }: MoneyProps) {
  if (masked) return <Masked className={className} />;
  const text = micro !== undefined ? formatMicro(micro, { sign }) : formatCents(cents, { sign });
  if (text === MISSING) return <NotMeasured />;
  return (
    <span data-money="" className={cn("font-mono break-words", className)}>
      {text}
    </span>
  );
}

type GainLossProps = {
  /** The signed amount that decides colour, arrow and words. */
  value: number | null | undefined;
  /** Display text; defaults to the value formatted per `kind`. */
  children?: string;
  kind?: "cents" | "percent" | "ppm";
  masked?: boolean;
};

export function GainLoss({ value, children, kind = "cents", masked }: GainLossProps) {
  if (masked) return <Masked />;
  if (value === null || value === undefined || !Number.isFinite(value)) return <NotMeasured />;
  const text =
    children ??
    (kind === "percent"
      ? formatPercent(value, { sign: "always" })
      : kind === "ppm"
        ? formatPpm(value, { sign: "always" })
        : formatCents(value, { sign: "always" }));
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-text-muted";
  return (
    <span
      role="img"
      aria-label={`${gainLossWord(value)}: ${text}`}
      className={cn("font-mono inline-flex items-baseline gap-1 break-words", tone)}
    >
      <span aria-hidden="true">{gainLossGlyph(value)}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

export function Percent({
  value,
  digits,
  sign,
  masked,
}: {
  value: number | null | undefined;
  digits?: number;
  sign?: SignStyle;
  masked?: boolean;
}) {
  if (masked) return <Masked />;
  const text = formatPercent(value, { digits, sign });
  return text === MISSING ? <NotMeasured /> : <span className="font-mono">{text}</span>;
}

/** The always-visible "Simulated" label plus the explainer link (UX-002). */
export function SimulatedLabel({ href = "/reviews/glossary#simulated" }: { href?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-text-muted">
      <span className="font-semibold uppercase tracking-wide">Simulated</span>
      <a href={href} className="underline">
        What does simulated mean?
      </a>
    </span>
  );
}
