// Shared inline-SVG illustrations (UXR-055, C12): two-tone (one hue + neutral), tokens only, decorative
// (aria-hidden), so they recolour with every theme. No raster, no stock imagery, no numbers (UX-091).
// `hue` is a section name ("picks", "reviews", ...) or a hue stem ("family-br", "tier-p1").
import { cn } from "./cn";

export type Motif =
  "picks" | "market" | "strategies" | "news" | "reviews" | "home" | "alerts" | "list" | "check";

const SECTIONS = new Set(["home", "picks", "market", "strategies", "news", "reviews"]);
const NEUTRAL = "var(--color-border)";

/** The CSS colour of a hue: a section colour, or the `-fill` of any other hue stem. */
export function hueColor(hue: string): string {
  return SECTIONS.has(hue) ? `var(--color-section-${hue})` : `var(--color-${hue}-fill)`;
}

export function Illustration({
  motif,
  hue,
  size = 96,
  className,
}: {
  motif: Motif;
  /** Section name or hue token stem. Defaults to the motif's own section when it is one. */
  hue?: string;
  size?: number;
  className?: string;
}) {
  const c = hueColor(hue ?? (SECTIONS.has(motif) ? motif : "home"));
  const soft = `color-mix(in srgb, ${c} 18%, transparent)`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 96 64"
      width={size}
      height={(size * 64) / 96}
      className={cn("shrink-0", className)}
      data-illustration={motif}
    >
      <rect x="10" y="8" width="76" height="48" rx="8" fill={soft} />
      <rect
        x="10"
        y="8"
        width="76"
        height="48"
        rx="8"
        fill="none"
        stroke={NEUTRAL}
        strokeWidth="2"
      />
      {motif === "picks" ? (
        <>
          <rect x="10" y="8" width="8" height="48" rx="4" fill={c} />
          <path
            d="M28 40l12-12 9 7 17-17"
            fill="none"
            stroke={c}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M28 48h40" stroke={NEUTRAL} strokeWidth="3" strokeLinecap="round" />
        </>
      ) : motif === "market" ? (
        <>
          <rect x="26" y="34" width="9" height="14" rx="2" fill={c} />
          <rect x="43" y="24" width="9" height="24" rx="2" fill={NEUTRAL} />
          <rect x="60" y="16" width="9" height="32" rx="2" fill={c} />
        </>
      ) : motif === "strategies" ? (
        <>
          <circle cx="32" cy="32" r="8" fill={c} />
          <circle cx="64" cy="22" r="6" fill={NEUTRAL} />
          <circle cx="64" cy="44" r="6" fill={NEUTRAL} />
          <path d="M40 30l18-8M40 34l18 8" stroke={c} strokeWidth="3" strokeLinecap="round" />
        </>
      ) : motif === "news" ? (
        <>
          <rect x="24" y="18" width="30" height="6" rx="3" fill={c} />
          <rect x="24" y="30" width="48" height="4" rx="2" fill={NEUTRAL} />
          <rect x="24" y="40" width="38" height="4" rx="2" fill={NEUTRAL} />
        </>
      ) : motif === "reviews" ? (
        <>
          <path
            d="M32 16h26l8 8v24H32z"
            fill="none"
            stroke={c}
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path d="M40 32h18M40 40h12" stroke={NEUTRAL} strokeWidth="3" strokeLinecap="round" />
        </>
      ) : motif === "alerts" ? (
        <>
          <path d="M48 16c-8 0-12 6-12 14v8l-4 6h32l-4-6v-8c0-8-4-14-12-14z" fill={c} />
          <path
            d="M44 48a4 4 0 008 0"
            fill="none"
            stroke={NEUTRAL}
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      ) : motif === "check" ? (
        <path
          d="M32 33l11 11 22-24"
          fill="none"
          stroke={c}
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : motif === "home" ? (
        <>
          <path
            d="M30 34l18-14 18 14"
            fill="none"
            stroke={c}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="36" y="34" width="24" height="14" rx="2" fill={NEUTRAL} />
        </>
      ) : (
        <>
          <rect x="26" y="18" width="10" height="6" rx="3" fill={c} />
          <rect x="42" y="19" width="28" height="4" rx="2" fill={NEUTRAL} />
          <rect x="26" y="32" width="10" height="6" rx="3" fill={c} />
          <rect x="42" y="33" width="22" height="4" rx="2" fill={NEUTRAL} />
          <rect x="26" y="46" width="10" height="4" rx="2" fill={c} />
        </>
      )}
    </svg>
  );
}
