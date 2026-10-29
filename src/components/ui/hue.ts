// Hue helper for the V2 palette (D-208): a hue is the token stem, e.g. "family-br", "tier-p0",
// "status-running", "sector-tech", "positive". Fills (rails, bands, badges, icons), `-text` (coloured
// text) and `-on-fill` (text on a fill) are exposed as local custom properties so components can use
// one class set for every hue. No colour values live here, only token names.
import type { CSSProperties } from "react";

export function hueStyle(hue: string): CSSProperties {
  return {
    "--h-fill": `var(--color-${hue}-fill)`,
    "--h-text": `var(--color-${hue}-text)`,
    "--h-on": `var(--color-${hue}-on-fill)`,
  } as CSSProperties;
}

/** Tinted band over the surface (UXR-052): `--tint-band` is per theme (8-12 %). */
export const BAND_BG = "color-mix(in srgb, var(--h-fill) var(--tint-band), var(--color-surface))";
/** Lighter tint for tiles and pills (`--tint-tile`). */
export const TILE_BG = "color-mix(in srgb, var(--h-fill) var(--tint-tile), var(--color-surface-2))";
