// Small inline-SVG illustrations for empty states (UXR-055): two-tone (section hue + neutral), tokens only,
// decorative (aria-hidden), so they recolour with every theme. No raster, no numbers.
const NEUTRAL = "var(--color-border)";

export function EmptyArt({
  hue,
  shape,
}: {
  /** Token stem of the section colour, e.g. "brand-a", "tier-p1". */
  hue: string;
  shape: "picks" | "ideas" | "list" | "news" | "check";
}) {
  const fill = `var(--color-${hue}-fill)`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 64 40"
      width={64}
      height={40}
      className="shrink-0"
      data-art={shape}
    >
      <rect
        x="4"
        y="6"
        width="56"
        height="28"
        rx="6"
        fill="none"
        stroke={NEUTRAL}
        strokeWidth="2"
      />
      {shape === "picks" ? (
        <>
          <rect x="4" y="6" width="9" height="28" rx="4" fill={fill} />
          <path
            d="M20 26l8-8 6 5 10-11"
            fill="none"
            stroke={fill}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : shape === "ideas" ? (
        <>
          <circle cx="32" cy="18" r="7" fill={fill} />
          <path d="M28 28h8" stroke={NEUTRAL} strokeWidth="3" strokeLinecap="round" />
        </>
      ) : shape === "news" ? (
        <>
          <rect x="14" y="13" width="22" height="4" rx="2" fill={fill} />
          <rect x="14" y="21" width="36" height="3" rx="1.5" fill={NEUTRAL} />
          <rect x="14" y="27" width="28" height="3" rx="1.5" fill={NEUTRAL} />
        </>
      ) : shape === "check" ? (
        <path
          d="M22 21l7 7 13-14"
          fill="none"
          stroke={fill}
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle cx="16" cy="14" r="3" fill={fill} />
          <rect x="24" y="12" width="26" height="4" rx="2" fill={NEUTRAL} />
          <circle cx="16" cy="26" r="3" fill={fill} />
          <rect x="24" y="24" width="20" height="4" rx="2" fill={NEUTRAL} />
        </>
      )}
    </svg>
  );
}

/** Sparkline in the outcome colour (UXR-053/054): signed colour, never grey for a gain or loss. */
export function Sparkline({
  values,
  hue,
}: {
  values: number[];
  hue: "positive" | "negative" | "outcome-flat";
}) {
  if (values.length < 2) return null;
  const w = 96;
  const h = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      data-sparkline={hue}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={`var(--color-${hue}-fill)`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
