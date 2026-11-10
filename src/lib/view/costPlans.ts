// Brokerage cost profiles in plain words (D-919): a broker-style name and the exact fee as detail.
// Pages show these instead of the internal profile codes (P0 to P6, "stress"), which also collide with
// the alert severities P0/P1. The exact rules live in src/lib/arena/costs.ts; this is only wording.

export type CostPlan = { title: string; detail: string };

const PLANS: Record<string, CostPlan> = {
  P0: {
    title: "Zero-fee-list broker",
    detail: "No fee on the zero-fee list, else A$3.00 a trade",
  },
  P1: { title: "Flat-fee broker", detail: "A$3.00 a trade" },
  P2: {
    title: "Pay-as-you-go broker",
    detail: "First buy under A$1,000 free, else the greater of A$11.00 or 0.10%",
  },
  P3: { title: "High flat-fee broker", detail: "A$6.50 a trade" },
  P4: { title: "Percentage broker", detail: "0.03% a trade, at least A$3, at most A$9.99" },
  P5: {
    title: "Tiered broker",
    detail: "A$5 to A$29.95 by trade size, then 0.12% above A$25,000",
  },
  P5b: { title: "Budget tiered broker", detail: "A$2.00 up to A$1,000, then 0.20%" },
  P6: {
    title: "Low-cost online broker",
    detail: "The greater of A$1.00 or 0.03% a trade, GST included",
  },
  stress: { title: "Stress test", detail: "A$6.50 a trade and wider price gaps" },
};

/** The plain plan for a profile key; an unknown key reads as "Other costs". */
export function costPlan(key: string): CostPlan {
  return PLANS[key] ?? { title: "Other costs", detail: "" };
}
