/** Deterministic number helpers shared by the SVG charts (stable output for snapshot tests). */

/** Round to 2 decimals and strip trailing zeros, so SVG attributes are identical on every platform. */
export function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const r = Math.round(value * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Signed value with an arrow, e.g. "▲ +1.2%" — never colour alone (UXN-001). */
export function signed(value: number, digits = 1, suffix = "%"): string {
  const abs = Math.abs(value).toFixed(digits);
  if (value > 0) return `▲ +${abs}${suffix}`;
  if (value < 0) return `▼ −${abs}${suffix}`;
  return `● ${abs}${suffix}`;
}

/** Fixed locale so output does not depend on the machine running the test. */
export function money(value: number, currency = "A$"): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}${currency}${Math.round(Math.abs(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Theme-token colour references (D-130). Charts never contain a colour literal. */
export const tone = {
  c1: "var(--color-chart-1)",
  c2: "var(--color-chart-2)",
  c3: "var(--color-chart-3)",
  c4: "var(--color-chart-4)",
  grid: "var(--color-grid)",
  text: "var(--color-text)",
  muted: "var(--color-text-muted)",
  surface: "var(--color-surface)",
} as const;

export const TOKEN_NAMES = [
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-grid",
  "--color-text",
  "--color-text-muted",
  "--color-surface",
] as const;
