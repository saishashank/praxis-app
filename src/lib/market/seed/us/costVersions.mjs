// The dated schedule of US-P1 (M20 US1; D-1150, D-1181). The profile engine carries ONE schedule per profile version
// (`componentFromSeed` drops `effective_from`), and the SEC Section 31 rate and the FINRA TAF change over time, so a
// replay or a calibration (CXA-002 j) that covers more than one regime must pick the version by date, through
// `cost_profile.effective_from`, or over-charge the older sessions. Version 1 is the current schedule exactly as A4
// seeded it (`./costProfiles.mjs`, effective 2026-04-04, the later of the two item dates); the older regimes follow,
// numbered 2, 3, 4 going back in time (a version number identifies a row; the SELECTOR is `effective_from`, the
// greatest one at or before the session date). Every figure here older than A4's is the design's D-1103 schedule or
// the SEC advisories as recalled on 2026-11-13 and stays [VERIFY] (`verified: false`), like the profile itself.
//
//   2026-04-04 -> : SEC 20.60 per million; TAF 0.000195, min 0.01, max 9.79          (version 1, A4)
//   2026-01-01 -> 2026-04-03 : SEC 0.00 (no covered-sales fee); TAF 0.000195 / 0.01 / 9.79   (version 2)
//   2025-05-14 -> 2025-12-31 : SEC 0.00; TAF 0.000166, max 8.30                       (version 3)
//   2024-05-22 -> 2025-05-13 : SEC 27.80 per million; TAF 0.000166, max 8.30          (version 4)
// A session before 2024-05-22 has no version: the lookup throws, never the nearest one.
import { US_COST_PROFILES } from "./costProfiles.mjs";

const SPEC = "spec 20 ARN-117 / D-1103 / D-1150 / D-1181";
const BASE = US_COST_PROFILES["US-P1"];

const sec = (ratePct, from) =>
  Object.freeze({
    name: "sec31",
    side: "sell",
    basis: "value",
    rate: ratePct,
    effective_from: from,
    source_ref: `${SPEC}: SEC Section 31 fee, ${ratePct} of the sale value from ${from} (fee rate advisories) [VERIFY]`,
  });
const taf = (rate, max, from, min) =>
  Object.freeze({
    name: "finra_taf",
    side: "sell",
    basis: "per_share",
    rate,
    ...(min === undefined ? {} : { min }),
    max,
    effective_from: from,
    source_ref: `${SPEC}: FINRA Trading Activity Fee ${rate} per share sold, max ${max} per trade, from ${from} [VERIFY]`,
  });

const version = (v, from, items) =>
  Object.freeze({
    code: "US-P1",
    version: v,
    effective_from: from,
    profile: Object.freeze({
      ...BASE,
      version: v,
      verified: false,
      specRef: `${SPEC} [VERIFY]`,
      rule: Object.freeze({
        kind: "components",
        round: "per_item_half_up_cent",
        items: Object.freeze(items),
      }),
    }),
  });

/** Ascending by `effective_from`. Version 1 is A4's profile object itself, unchanged. */
export const US_COST_VERSIONS = Object.freeze([
  version(4, "2024-05-22", [
    sec("0.00278%", "2024-05-22"),
    taf("0.000166", "8.30", "2024-05-22", "0.01"),
  ]),
  version(3, "2025-05-14", [taf("0.000166", "8.30", "2025-05-14", "0.01")]),
  version(2, "2026-01-01", [taf("0.000195", "9.79", "2026-01-01", "0.01")]),
  Object.freeze({
    code: "US-P1",
    version: 1,
    effective_from: "2026-04-04",
    profile: BASE,
  }),
]);
