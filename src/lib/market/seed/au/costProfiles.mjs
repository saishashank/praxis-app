// AU brokerage cost profiles P0 to P6, moved byte-for-byte from src/lib/arena/costs.ts (M19 A1, D-1003 d).
// The figures, names, spec references and flags are today's; a rate is kept as its decimal-percent text
// ("0.12%") because this module is plain ESM with no rational type: the engine in costs.ts (stream B2)
// parses it with parseRational exactly as it does today. Money is micro units of the market currency
// (AUD here: 1 A$ = 1_000_000 micro). The go-live attestation (src/lib/golive/moneyConstants.ts) hashes
// these figures, so any edit here is a new money constant and a new attestation (D-710, D-817).
const AUD = 1_000_000n;
const aud = (dollars, cents = 0n) => dollars * AUD + cents * 10_000n;
const flat = (feeMicro) => ({ kind: "flat", feeMicro });
const pct = (rate, minMicro = 0n, maxMicro = null, freeFirstBuyBelowMicro = null) => ({
  kind: "pct",
  rate,
  minMicro,
  maxMicro,
  freeFirstBuyBelowMicro,
});

const P1_RULE = flat(aud(3n));
const SPEC = "spec 05 ARN-031 l.64";

const profile = (code, name, rule) => ({
  code,
  version: 1,
  name,
  specRef: SPEC,
  verify: true,
  verified: false,
  rule,
});

/**
 * ARN-031 (l.64), each side, all [VERIFY]:
 *  P0 zero-fee list else P1 | P1 A$3.00 | P2 first buy < A$1,000 per security per day A$0, else
 *  greater of A$11.00 or 0.10% | P3 (stress) A$6.50 | P4 0.03% min A$3 max A$9.99 |
 *  P5 default: <= 1,000.00 A$5.00; <= 3,000.00 A$10.00; <= 10,000.00 A$19.95; <= 25,000.00 A$29.95;
 *  above 25,000.00 0.12% | P5b <= 1,000.00 A$2.00, above 0.20%.
 * P6 (D-895, O-79d; not in ARN-031): the greater of A$1.00 and 0.03% of the order value, GST included,
 * each side (Webull Australia, CHESS-sponsored; read 2026-11-08), verified.
 */
export const AU_COST_PROFILES = Object.freeze({
  P0: profile("P0", "Zero-fee list, else P1", { kind: "zeroFeeListElse", otherwise: P1_RULE }),
  P1: profile("P1", "A$3.00 flat", P1_RULE),
  P2: profile(
    "P2",
    "First buy under A$1,000 free, else greater of A$11.00 or 0.10%",
    pct("0.10%", aud(11n), null, aud(1_000n)),
  ),
  P3: profile("P3", "Stress: A$6.50 flat", flat(aud(6n, 50n))),
  P4: profile("P4", "0.03% min A$3 max A$9.99", pct("0.03%", aud(3n), aud(9n, 99n))),
  P5: profile("P5", "Default tiers (A$5 to A$29.95, then 0.12%)", {
    kind: "tiered",
    tiers: [
      { upToMicro: aud(1_000n), feeMicro: aud(5n) },
      { upToMicro: aud(3_000n), feeMicro: aud(10n) },
      { upToMicro: aud(10_000n), feeMicro: aud(19n, 95n) },
      { upToMicro: aud(25_000n), feeMicro: aud(29n, 95n) },
    ],
    above: pct("0.12%"),
  }),
  P5b: profile("P5b", "A$2.00 up to A$1,000, then 0.20%", {
    kind: "tiered",
    tiers: [{ upToMicro: aud(1_000n), feeMicro: aud(2n) }],
    above: pct("0.20%"),
  }),
  P6: {
    code: "P6",
    version: 1,
    name: "A$1.00 or 0.03%, whichever is greater (GST included)",
    specRef: "O-79d / D-895: webull.com.au/pricing, read 2026-11-08",
    verify: true,
    verified: true,
    rule: pct("0.03%", aud(1n)),
  },
});

/** The profile codes in the order costs.ts lists them (COST_PROFILE_CODES). */
export const AU_COST_PROFILE_CODES = Object.freeze([
  "P0",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P5b",
  "P6",
]);
