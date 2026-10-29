// Pick family -> badge (UXN-311): fixed code, plain-words label and the colour token stem. Masking does not
// hide the family badge for any role (UXN-311); the badge never carries a stock code.
import type { FamilyCode } from "@/components/ui/Family";

export const FAMILY_BADGE: Record<string, { code: FamilyCode; label: string }> = {
  F1: { code: "br", label: "Breakout" },
  F2: { code: "vc", label: "Value + catalyst" },
  F3: { code: "nd", label: "News drift" },
  F4: { code: "bo", label: "Bounce" },
  F5: { code: "sc", label: "Small-cap discovery" },
  F6: { code: "co", label: "Consensus" },
  F7: { code: "ex", label: "Expert consensus" },
};

export function familyBadge(family: string): { code: FamilyCode; label: string } {
  return FAMILY_BADGE[family] ?? { code: "co", label: "Pick" };
}
