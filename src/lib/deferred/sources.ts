// DAT-249 (social sentiment) and DAT-250 (live and Level-2 data): two data sources that stay out, recorded as rejected with
// their reason and the date checked (M22 E5, D-1442). The pattern of `instruments.ts`: nothing here fetches, stores or trades;
// no fetcher, host or key exists for either (tests/deferred/sources.test.ts proves it). Each is [VERIFY] at the next DAT-101 pass.

export type RejectedSource = {
  readonly id: "DAT-249" | "DAT-250";
  readonly label: string;
  readonly status: "REJECTED";
  readonly reason: string;
  /** The day the reason was last checked (YYYY-MM-DD). */
  readonly checkedOn: string;
};

export const REJECTED_SOURCES: readonly RejectedSource[] = [
  {
    id: "DAT-249",
    label: "Social sentiment",
    status: "REJECTED",
    reason:
      "the terms of the large social sites do not allow storing or reusing their posts, and sentiment from public posts is easy to manipulate and pays nothing the price and announcement rules do not already see",
    checkedOn: "2026-11-17",
  },
  {
    id: "DAT-250",
    label: "Live and Level-2 market data",
    status: "REJECTED",
    reason:
      "no free feed is licensed for live tick or order-book data; the exchange's own feeds are paid and the app uses end-of-day data and a delayed public quote only",
    checkedOn: "2026-11-17",
  },
];

/** Thrown when a rejected source is asked for; the message carries the reason. */
export class RejectedSourceError extends Error {
  readonly id: RejectedSource["id"];
  constructor(s: RejectedSource) {
    super(`rejected: ${s.label} (${s.id}), checked ${s.checkedOn}: ${s.reason}`);
    this.name = "RejectedSourceError";
    this.id = s.id;
  }
}

/** Refuses a rejected source with its reason. Never returns. An unknown id is a programming error. */
export function refuseRejectedSource(id: string): never {
  const s = REJECTED_SOURCES.find((x) => x.id === id);
  if (s === undefined) throw new RangeError(`not a rejected source: ${id}`);
  throw new RejectedSourceError(s);
}
