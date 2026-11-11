// The AU `market` row as migration 0034 seeds it (M19 C1, D-996): the Worker builds its slot table from this
// row, so the tests that used the removed `AU_SLOTS` constant build the same table from it. The values are the
// seed's (src/lib/market/seed/AU.mjs, db/migrations/main/0034_m19_market_profile.sql); worker/test/auRow.test.ts
// proves the migration row equals this one.
import { slotsFor } from "../src/schedule";
import { pinMarkets, type MarketRow } from "../src/markets";

export const AU_ROW: MarketRow = {
  code: "AU",
  tz: "Australia/Sydney",
  open_time: "10:00",
  close_time: "16:00",
  cutoff_time: "18:10",
  currency: "AUD",
  mode: "data_only",
  enabled: 1,
  slots_json: JSON.stringify({
    b1: "17:30",
    b2a: "17:50",
    b2b: "18:10",
    late_2a_after: "18:40",
    cutoff: "18:10",
    cutoff_poll: "18:10",
    preopen_recheck: ["09:54", "09:58"],
    quote_from: "10:00",
    quote_until: "16:00",
    intraday_scan_from: "10:32",
    intraday_scan_until: "15:32",
  }),
};

/** A built-off market row as migration 0034 seeds it: IN, enabled 0, mode off (tests plant `enabled = 1`). */
export const IN_ROW: MarketRow = {
  code: "IN",
  tz: "Asia/Kolkata",
  open_time: "09:15",
  close_time: "15:30",
  cutoff_time: "17:30",
  currency: "INR",
  mode: "off",
  enabled: 0,
  slots_json: JSON.stringify({
    b1: "16:30",
    b2a: "16:50",
    b2b: "17:10",
    late_2a_after: "17:40",
    cutoff: "17:30",
    cutoff_poll: "17:30",
    preopen_recheck: ["09:09", "09:13"],
    quote_from: "09:15",
    quote_until: "15:30",
    intraday_scan_from: "09:47",
    intraday_scan_until: "15:02",
  }),
};

/** The AU slot table (what the removed `AU_SLOTS` constant was), built from the AU row. */
export const AU_SLOTS = slotsFor(AU_ROW);

/** A warm isolate: the Worker already knows the enabled markets (AU), so a tick costs no extra market read. */
export const warmMarkets = (): void => pinMarkets([AU_ROW]);
