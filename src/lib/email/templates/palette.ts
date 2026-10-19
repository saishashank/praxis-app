// Email palette (M5 T4, D-049, D-098 draft). Colours are the app's light and dark theme tokens
// (src/styles); every text/background pair is checked against WCAG AA 4.5:1 in tests/email and
// every border against 3:1 (UI component contrast). Email clients that ignore prefers-color-scheme
// get the light palette inline; clients that honour it get the dark palette from the style block.

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  positive: string;
  negative: string;
  warning: string;
}

export const LIGHT: Palette = {
  bg: "#ffffff",
  surface: "#f3f5f8",
  text: "#131821",
  muted: "#525c6d",
  border: "#7a8496",
  accent: "#1b6aa5",
  positive: "#0b7a6c",
  negative: "#b0440c",
  warning: "#85560a",
};

export const DARK: Palette = {
  bg: "#0b0f15",
  surface: "#131a24",
  text: "#e7ebf1",
  muted: "#9aa4b5",
  border: "#5a677c",
  accent: "#8fd3ff",
  positive: "#2db5a3",
  negative: "#f08a4b",
  warning: "#e8b339",
};

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text colour roles, each drawn on both the page background and the surface. */
export const TEXT_ROLES = ["text", "muted", "accent", "positive", "negative", "warning"] as const;
export const SURFACES = ["bg", "surface"] as const;

export type Role = (typeof TEXT_ROLES)[number];
