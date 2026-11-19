// Holding period (ARN-122, D-1222). "Over 12 months" only when the sale date is AFTER the 12-month anniversary of
// the buy date; a sale on the anniversary itself is "12 months or less". A 29 February buy has its anniversary on
// 28 February. Pure date text, no clock, no time zone.
export function anniversary12(buyD: string): string {
  const year = parseInt(buyD.slice(0, 4), 10) + 1;
  const md = buyD.slice(5);
  return `${String(year).padStart(4, "0")}-${md === "02-29" ? "02-28" : md}`;
}

export function isOver12Months(buyD: string, sellD: string): boolean {
  return anniversary12(buyD) < sellD;
}
