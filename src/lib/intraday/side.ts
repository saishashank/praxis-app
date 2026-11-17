// D-1040..D-1045 (Owner O-83, 2026-11-11: "Buy ideas only"): which side of the intraday watch a stored
// row belongs to. Pure; the one definition the scan, the pages, the e-mails, the Top-5 credit and the
// stream evaluation all read, so they cannot drift apart.
//
//   buy    good news AND the price is up: an intraday candidate (a buy idea).
//   avoid  bad news AND the price is down: shown only as "Avoid / watch", never a candidate, never
//          counted as a candidate result.
//   null   anything else (mixed news, or news and price pointing opposite ways): not shown.
//
// The side is derived from the stored `polarity` and `move_ppm`, so rows written before this rule
// (some were bad-news fallers) sort themselves out without a data migration.
export type IdeaSide = "buy" | "avoid";

export function ideaSide(polarity: string | null, movePpm: number): IdeaSide | null {
  if (polarity === "positive" && movePpm > 0) return "buy";
  if (polarity === "negative" && movePpm < 0) return "avoid";
  return null;
}

/** SQL predicate for the buy ideas of `intraday_candidate`; `alias` is the table alias, if any. */
export function buyIdeaSql(alias = ""): string {
  const p = alias === "" ? "" : `${alias}.`;
  return `${p}polarity = 'positive' AND ${p}move_ppm > 0`;
}

/** SQL predicate for the "Avoid / watch" rows of `intraday_candidate`. */
export function avoidSql(alias = ""): string {
  const p = alias === "" ? "" : `${alias}.`;
  return `${p}polarity = 'negative' AND ${p}move_ppm < 0`;
}
