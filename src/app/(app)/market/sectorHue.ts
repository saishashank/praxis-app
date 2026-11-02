// Sector name -> sector hue key (UXR-051). The company list carries ASX industry-group names; the V2
// palette has eleven sector hues (`--color-sector-<key>-fill/-text/-on-fill`). A name that matches none
// returns null and the row uses a neutral look. The hue is a second cue: the sector name is always shown
// as text too.

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/real estate|reit|property/i, "realestate"],
  [/utilit/i, "utilities"],
  [/energy|oil|gas|coal|uranium/i, "energy"],
  [/health|pharma|biotech|medical|life science/i, "healthcare"],
  [/bank|financ|insur|diversified fin/i, "financials"],
  [/software|technolog|semiconductor|hardware|information|\bit\b/i, "tech"],
  [/telecom|communicat|media|entertainment/i, "comms"],
  [/food|beverage|tobacco|staple|household|personal product/i, "staples"],
  [/auto|apparel|durable|consumer serv|retail|discretionary|leisure/i, "discretionary"],
  [/capital goods|industrial|transport|commercial|professional serv/i, "industrials"],
  [/material|mining|metal|chemical|gold|steel/i, "materials"],
];

/** The sector hue key for a sector name, or null when the name is unknown or missing. */
export function sectorKey(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const [re, key] of RULES) if (re.test(name)) return key;
  return null;
}

/** Token stem for `hueStyle`, e.g. "sector-tech". */
export function sectorHueOf(name: string | null | undefined): string | null {
  const k = sectorKey(name);
  return k === null ? null : `sector-${k}`;
}
