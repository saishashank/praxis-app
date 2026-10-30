// TST-109 as-of truncation helper (CTX-010; docs/M15_design.md 3a "Fixed rules", 7 "Look-ahead").
// For a feature f(view, code, t) and a world, recompute f on a view built from the world physically
// cut at t (`cutWorld`) and compare with f on the full view at the same t. Any difference means the
// feature read something the cut-off of sessions[t] had not made known. The same helper runs in CI
// on ZZ worlds (AT-50) and offline over the extract (WP1), so one definition of "truncated" exists.
import { buildAsOfView, cutWorld } from "./asOfView";
import type { AsOfView, AsOfWorld } from "./types";

export type Feature<V = unknown> = (view: AsOfView, code: string, t: number) => V;

export type TruncationMismatch = {
  readonly code: string;
  readonly t: number;
  readonly full: string;
  readonly cut: string;
};

export type TruncationOptions = {
  /** Codes to check; default = the full view's `codes(t)` at each t. */
  readonly codes?: readonly string[];
  /** Session indices to check; default = every session. */
  readonly ts?: readonly number[];
};

/** A stable text key of a feature value: JSON with sorted keys, bigint as `<digits>n`, undefined as "undefined". */
export function valueKey(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(valueKey).join(",")}]`;
  if (value instanceof Map) return valueKey([...value.entries()].sort());
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${valueKey(v)}`).join(",")}}`;
}

/**
 * Every (code, t) at which the feature on the cut world differs from the feature on the full view.
 * Empty = the feature passes TST-109 on this world. The feature is called as a pure function; a
 * throw at either side counts as a mismatch with the error name as the value.
 */
export function truncationMismatches(
  world: AsOfWorld,
  feature: Feature,
  opts: TruncationOptions = {},
): TruncationMismatch[] {
  const full = buildAsOfView(world);
  const ts = opts.ts ?? world.sessions.map((_, i) => i);
  const out: TruncationMismatch[] = [];
  const safe = (view: AsOfView, code: string, t: number): string => {
    try {
      return valueKey(feature(view, code, t));
    } catch (e) {
      return `throw:${e instanceof Error ? e.name : String(e)}`;
    }
  };
  for (const t of ts) {
    const cutView = buildAsOfView(cutWorld(world, t));
    const codes = opts.codes ?? full.codes(t);
    for (const code of codes) {
      const a = safe(full, code, t);
      const b = safe(cutView, code, t);
      if (a !== b) out.push({ code, t, full: a, cut: b });
    }
  }
  return out;
}

/** Throws with the first mismatches listed when the feature fails TST-109 on the world. */
export function assertTruncationInvariant(
  world: AsOfWorld,
  feature: Feature,
  opts: TruncationOptions = {},
): void {
  const m = truncationMismatches(world, feature, opts);
  if (m.length === 0) return;
  const head = m
    .slice(0, 5)
    .map((x) => `${x.code}@${x.t}: full=${x.full} cut=${x.cut}`)
    .join("; ");
  throw new Error(`TST-109 truncation mismatch (${m.length}): ${head}`);
}
