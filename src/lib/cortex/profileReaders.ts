// Cortex readers of the market-profile fields that select a rule set (M19 B1; CXA-002 e, f, g, i; D-1003).
// AU has one reader per field (today's behaviour, unchanged); the IN and US values select readers that are
// built at M20, and each throws `not built (M20): ...` here, so a profile that names one can never run a
// night on the AU rules by accident (PRD-039: a stub is a tested stub). Pure: a MarketProfile in, a plain
// value out.
import type { MarketProfile } from "@/lib/market/profileCore.mjs";
import { homeProfile } from "@/lib/market/staticProfile.mjs";

/** Thrown by an M20 reader stub (the message starts `not built (M20)`). */
export class NotBuiltM20 extends Error {
  constructor(what: string, value: string | null) {
    super(`not built (M20): ${what} ${value ?? "null"}`);
    this.name = "NotBuiltM20";
  }
}

/**
 * (e) The `instrument_class` / industry-group source of the per-industry NAV cap and the sector angles: the one
 * classification scheme with a built reader is the home market's (AU: the ASX GICS industry group).
 */
export type ClassificationReader = string;
const BUILT_CLASSIFICATION: ClassificationReader = homeProfile().classificationScheme!;
/** (f) The halt and suspension rule set of `cortex/states/*` and `arena/corpActions.ts`. */
export type HaltReader = "cx16";

export function classificationReader(profile: MarketProfile): ClassificationReader {
  if (profile.classificationScheme === BUILT_CLASSIFICATION) return BUILT_CLASSIFICATION;
  throw new NotBuiltM20("classification scheme", profile.classificationScheme);
}

export function haltReader(profile: MarketProfile): HaltReader {
  if (profile.haltModel === "cx16") return "cx16";
  throw new NotBuiltM20("halt model", profile.haltModel);
}

/**
 * (g) The price-sensitive category map. `{ kind: "none" }` is the AU path (the ASX feed carries the flag, no
 * map); any other value is the M20 reader.
 */
export function categoryMapReader(profile: MarketProfile): null {
  const v = profile.fields.category_map?.value;
  if (typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "none") return null;
  throw new NotBuiltM20("category map", v === undefined || v === null ? null : JSON.stringify(v));
}

export type ProfileReaders = {
  readonly classification: ClassificationReader;
  readonly halt: HaltReader;
  readonly categoryMap: null;
};

/** The three rule-set readers of a profile, or the first M20 stub's error. */
export function profileReaders(profile: MarketProfile): ProfileReaders {
  return {
    classification: classificationReader(profile),
    halt: haltReader(profile),
    categoryMap: categoryMapReader(profile),
  };
}

/** The franking angle (A-D4-05): skipped for a market with no dividend imputation (CXA-002 i). */
export const FRANKING_ANGLE_ID = "A-D4-05";

/** The angle definitions a market runs: every angle, less the franking angle without imputation. */
export function anglesForProfile<T extends { readonly id: string }>(
  angles: readonly T[],
  profile: MarketProfile,
): readonly T[] {
  return profile.dividendImputation === true
    ? angles
    : angles.filter((a) => a.id !== FRANKING_ANGLE_ID);
}
