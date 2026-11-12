// India (NSE) cost profile IN-P1: delivery equity, both sides (M20 A4; ARN-116, D-1102, spec ch. 20 §20.1).
// Every rate is the spec ARN-116 [VERIFY] figure, kept as decimal text (parseRational in src/lib/arena/costs.ts;
// no floats). Money amounts (`min`, `max`, per-order `rate`) are rupees as decimal text. Each item names its
// public reference; none was read against the primary page in this build, so the profile stays `verified: false`
// (every item [VERIFY]) until task A3 / the Owner records evidence (D-1102: a changed constant re-derives the
// fixture tests/markets/in/costs.test.ts in the same commit). The rule kind `components` and its rounding are
// defined in src/lib/arena/costs.ts: every item an exact rational, the TOTAL rounded once, half-up, to the rupee
// cent (paise).
const SPEC = "spec 20 ARN-116 / D-1102";

/** Items in evaluation order; `pct_of` reads items listed before it. */
const ITEMS = Object.freeze([
  Object.freeze({
    name: "brokerage",
    side: "both",
    basis: "value",
    rate: "0.03%",
    max: "20",
    effective_from: null,
    source_ref: `${SPEC}: min(Rs 20, 0.03 %) per order, the discount-broker schedule (e.g. zerodha.com/charges) [VERIFY]`,
  }),
  Object.freeze({
    name: "stt",
    side: "both",
    basis: "value",
    rate: "0.1%",
    effective_from: null,
    source_ref: `${SPEC}: Securities Transaction Tax, equity delivery 0.1 % on buy and on sell (Finance (No. 2) Act 2004 as amended; incometax.gov.in STT table) [VERIFY]`,
  }),
  Object.freeze({
    name: "exchange",
    side: "both",
    basis: "value",
    rate: "0.00297%",
    effective_from: null,
    source_ref: `${SPEC}: NSE equity transaction charge 0.00297 % of turnover (NSE circular on transaction charges, nseindia.com) [VERIFY]`,
  }),
  Object.freeze({
    name: "sebi",
    side: "both",
    basis: "value",
    rate: "0.0001%",
    effective_from: null,
    source_ref: `${SPEC}: SEBI turnover fee Rs 10 per crore = 10 / 10,000,000 = 0.0001 % (SEBI circular on turnover fees, sebi.gov.in) [VERIFY]`,
  }),
  Object.freeze({
    name: "stamp",
    side: "buy",
    basis: "value",
    rate: "0.015%",
    effective_from: null,
    source_ref: `${SPEC}: stamp duty 0.015 % on the buy side of delivery trades (Indian Stamp Act as amended by Finance Act 2019, in force 2020-07-01) [VERIFY]`,
  }),
  Object.freeze({
    name: "gst",
    side: "both",
    basis: "pct_of",
    of: Object.freeze(["brokerage", "exchange", "sebi"]),
    rate: "18%",
    effective_from: null,
    source_ref: `${SPEC}: GST 18 % on brokerage + exchange transaction charge + SEBI fee (CGST Act, SAC 997152; not on STT or stamp duty) [VERIFY]`,
  }),
  Object.freeze({
    name: "dp",
    side: "sell",
    basis: "per_order",
    rate: "17.70",
    effective_from: null,
    source_ref: `${SPEC}: depository (DP) charge Rs 15 + 18 % GST = Rs 17.70 per sell order (CDSL/NSDL transaction charge plus broker margin) [VERIFY]`,
  }),
]);

export const IN_COST_PROFILES = Object.freeze({
  "IN-P1": Object.freeze({
    code: "IN-P1",
    version: 1,
    name: "India delivery: brokerage, STT, exchange, SEBI, stamp, GST, DP",
    specRef: `${SPEC} [VERIFY]`,
    verify: true,
    verified: false,
    rule: Object.freeze({
      kind: "components",
      round: "total_half_up_cent",
      items: ITEMS,
    }),
  }),
});

export const IN_COST_PROFILE_CODES = Object.freeze(["IN-P1"]);
