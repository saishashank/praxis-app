// The US filing category map (M20 A5; DAT-246, D-1108, AGT-011a). Plain data: the 8-K item number (`item`, matched
// against every item a filing lists), the form type (`form`, case-insensitive exact), a headline pattern
// (`title_re`, case-insensitive) or the source's own type (`type`, a case-insensitive substring; the halt rows) to one
// of the 11 AGT-020 categories, with the AGT-011 materiality (0..3) and whether the category can be verified
// (CTX-043: results and guidance only with parsed statements, i.e. `fundamental_fact` rows; a contract only with a
// disclosed value and counterparty). First match wins, so the order is the priority; the last row is `other`.
const row = (match, category, materiality, verifiable = false, extra = {}) =>
  Object.freeze({
    match: Object.freeze(match),
    category,
    materiality,
    verifiable,
    ...extra,
  });
const contract = (item) => row({ item }, "contract", 2, true, { materiality_disclosed: 3 });
const GUIDANCE = String.raw`\b(guidance|outlook)\b`;

/** The `category_map` field kind of the profile that selects this map. */
export const CATEGORY_KIND = "edgar_8k_items";

export const CATEGORY_MAP = Object.freeze({
  version: "us-categories-v1",
  rows: Object.freeze([
    row({ type: "trading_halt" }, "halt", 3),
    row({ item: "3.01" }, "exchange_query", 2),
    row({ item: "4.02" }, "results", 3, true),
    row({ item: "2.02", title_re: GUIDANCE }, "guidance", 3, true),
    row({ item: "7.01", title_re: GUIDANCE }, "guidance", 3, true),
    row({ item: "2.02" }, "results", 3, true),
    contract("1.01"),
    contract("1.02"),
    row({ item: "2.01" }, "takeover", 3),
    row({ item: "2.03" }, "capital_raising", 2),
    row({ item: "3.02" }, "capital_raising", 2),
    row({ item: "8.01", title_re: String.raw`\bdividend` }, "dividend", 1),
    row({ form: "10-Q" }, "results", 3, true),
    row({ form: "10-Q/A" }, "results", 3, true),
    row({ form: "10-K" }, "results", 3, true),
    row({ form: "10-K/A" }, "results", 3, true),
    row({ form: "4" }, "director_trade", 1),
    row({ form: "4/A" }, "director_trade", 1),
    row({ form: "SC 13D" }, "substantial_holder", 1),
    row({ form: "SC 13D/A" }, "substantial_holder", 1),
    row({ form: "SC 13G" }, "substantial_holder", 1),
    row({ form: "SC 13G/A" }, "substantial_holder", 1),
    row({ form: "SCHEDULE 13D" }, "substantial_holder", 1),
    row({ form: "SCHEDULE 13D/A" }, "substantial_holder", 1),
    row({ form: "SCHEDULE 13G" }, "substantial_holder", 1),
    row({ form: "SCHEDULE 13G/A" }, "substantial_holder", 1),
    row({}, "other", 0),
  ]),
});
