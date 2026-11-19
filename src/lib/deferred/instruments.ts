// ARN-124 a-c (M21 R1; D-1229): the instrument classes that stay deferred, as records with reasons and one refusal. The
// pattern of `BlockedData` and `PRE_REGISTERED_BLOCKED`: nothing here trades, fetches or stores. Sources are judged offline,
// from the register statuses already known; each is [VERIFY] at the next DAT-101 pass.

export type DeferredStatus = "BLOCKED-DATA" | "OUTSIDE-EQUITY-CORTEX";

export type DeferredClass = {
  readonly kind: "options_futures" | "crypto" | "fx";
  readonly arn: string;
  readonly label: string;
  readonly status: DeferredStatus;
  readonly reason: string;
  readonly sourcesChecked: readonly string[];
};

export const DEFERRED_CLASSES: readonly DeferredClass[] = [
  {
    kind: "options_futures",
    arn: "ARN-124a",
    label: "Options and futures",
    status: "BLOCKED-DATA",
    reason:
      "no free, licence-clean history exists: ASX derivatives data is licensed with no free history; the NSE F&O archive's terms are pending and have not passed the source check (DAT-101, D-1143); US option data (OPRA) is licensed. [VERIFY] at the next source check",
    sourcesChecked: ["ASX derivatives data", "NSE F&O archive", "OPRA"],
  },
  {
    kind: "crypto",
    arn: "ARN-124b",
    label: "Crypto assets",
    status: "OUTSIDE-EQUITY-CORTEX",
    reason:
      "the Cortex ranks listed equities with exchange sessions, announcements and a tier; a crypto asset has none of them, and the app never holds or moves crypto",
    sourcesChecked: [],
  },
  {
    kind: "fx",
    arn: "ARN-124c",
    label: "Foreign exchange",
    status: "OUTSIDE-EQUITY-CORTEX",
    reason:
      "foreign exchange is only the seed conversion rate and the reporting rate of a market; it is never an instrument the Cortex ranks or trades",
    sourcesChecked: [],
  },
];

export type DeferredKind = DeferredClass["kind"];

/** Thrown when a deferred class is asked for; the message carries the reason. */
export class DeferredInstrument extends Error {
  readonly kind: DeferredKind;
  readonly status: DeferredStatus;
  constructor(c: DeferredClass) {
    super(`deferred: ${c.label} (${c.status}): ${c.reason}`);
    this.name = "DeferredInstrument";
    this.kind = c.kind;
    this.status = c.status;
  }
}

/** Refuses a deferred class with its reason. Never returns. An unknown kind is a programming error. */
export function refuseDeferred(kind: string): never {
  const c = DEFERRED_CLASSES.find((x) => x.kind === kind);
  if (c === undefined) throw new RangeError(`not a deferred instrument class: ${kind}`);
  throw new DeferredInstrument(c);
}
