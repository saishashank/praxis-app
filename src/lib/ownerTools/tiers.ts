// Risk tiers (M21 B1, UXN-314, D-1216): the three pick profiles shown to the Owner as Turbo, Balanced and Steady. A
// label only: no sort, stop, size or filter reads it (the profile names and caps stay `pick_profiles`, D-1216).
export const TIER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  aggressive: "Turbo",
  balanced: "Balanced",
  conservative: "Steady",
});

/** The Owner's word for a profile, or null for a profile that has none. */
export function tierLabel(profile: string): string | null {
  return Object.hasOwn(TIER_WORDS, profile) ? TIER_WORDS[profile]! : null;
}

/** The order the page lists the tiers in: boldest first. */
export const TIER_ORDER: readonly string[] = ["aggressive", "balanced", "conservative"];
