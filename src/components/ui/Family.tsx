// Family badge (UXN-311 tokens, UXR-052) and the Rail helper: a coloured left rail with a tinted header
// band. Colour comes from the --color-<hue>-fill tokens (D-208): fills for the rail, band and badge,
// -on-fill for text on a fill, -text for coloured text.
import type { ReactNode } from "react";
import { cn } from "./cn";
import { BAND_BG, hueStyle } from "./hue";

export const FAMILY_CODES = ["br", "vc", "nd", "bo", "sc", "co", "ex", "id"] as const;
export type FamilyCode = (typeof FAMILY_CODES)[number];

/**
 * Badge: filled chip with the two-letter mark, the family name, and an optional slot for the "i"
 * button (an InfoButton). The mark is part of the visible text so the badge never relies on hue alone.
 */
export function FamilyBadge({
  code,
  label,
  info,
  className,
}: {
  code: FamilyCode;
  label: string;
  /** Optional "i" button, e.g. <InfoButton label="About breakouts">...</InfoButton>. */
  info?: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-family={code}
      style={hueStyle(`family-${code}`)}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1", className)}
    >
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-[var(--h-fill)] px-2 py-1 text-xs font-semibold text-[var(--h-on)]">
        <span className="font-mono" aria-hidden="true">
          {code.toUpperCase()}
        </span>
        <span className="min-w-0 break-words">{label}</span>
      </span>
      {info}
    </span>
  );
}

/**
 * Card shell with a coloured left rail and a tinted header band. `hue` is a token stem such as
 * "family-br" or "tier-p0"; `header` goes in the band, `children` below it.
 */
export function Rail({
  hue,
  header,
  children,
  className,
}: {
  hue: string;
  header?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-hue={hue}
      style={hueStyle(hue)}
      className={cn(
        "overflow-hidden rounded-lg border border-l-4 border-border border-l-[var(--h-fill)] bg-surface text-text",
        className,
      )}
    >
      {header ? (
        <div style={{ background: BAND_BG }} className="px-3 py-2">
          {header}
        </div>
      ) : null}
      {children ? <div className="px-3 py-2">{children}</div> : null}
    </div>
  );
}
