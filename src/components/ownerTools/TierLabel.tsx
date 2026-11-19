// The Owner's word for a pick profile (M21 B1, UXN-314, D-1216): Turbo, Balanced or Steady. A label only.
import { tierLabel } from "@/lib/ownerTools/tiers";

export function TierLabel({ profile }: { profile: string }) {
  const word = tierLabel(profile);
  if (word === null) return null;
  return (
    <span
      data-testid="tier-label"
      className="inline-flex rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold"
    >
      {word}
    </span>
  );
}
