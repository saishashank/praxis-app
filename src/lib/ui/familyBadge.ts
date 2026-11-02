// The ONE family badge table (UXN-311, D-393): label, two-letter mark, colour token stem and the phrase-table
// word for F1-F7 and the intraday badge `ID`. Tiles, Strategies, the concentration line and the pick cards all
// import this module; `home/familyMap.ts` and `picks/text.ts` only re-export it (a test pins that no other
// module defines a family label table). Masking does not hide the badge; it never carries a stock code.
import type { FamilyCode } from "@/components/ui/Family";
import { FAMILY_WORD } from "@/lib/cortex/phrases";

export type FamilyBadgeInfo = {
  readonly code: FamilyCode;
  readonly label: string;
  /** Two-letter mark shown inside the badge so hue is never the only cue. */
  readonly mark: string;
  /** Plain words from the Cortex phrase table (the "i" sheet). */
  readonly phrase: string;
};

const row = (code: FamilyCode, label: string, phrase: string): FamilyBadgeInfo => ({
  code,
  label,
  mark: code.toUpperCase(),
  phrase,
});

export const FAMILY_BADGE: Readonly<Record<string, FamilyBadgeInfo>> = {
  F1: row("br", "Breakout", FAMILY_WORD.F1!),
  F2: row("vc", "Value + catalyst", FAMILY_WORD.F2!),
  F3: row("nd", "News drift", FAMILY_WORD.F3!),
  F4: row("bo", "Bounce", FAMILY_WORD.F4!),
  F5: row("sc", "Small-cap discovery", FAMILY_WORD.F5!),
  F6: row("co", "Consensus", FAMILY_WORD.F6!),
  F7: row("ex", "Expert consensus", FAMILY_WORD.F7!),
  ID: row("id", "Intraday", "same-day news move"),
};

const FALLBACK: FamilyBadgeInfo = row("co", "Pick", "");

export function familyBadge(family: string): FamilyBadgeInfo {
  return FAMILY_BADGE[family] ?? FALLBACK;
}
