// The India announcement category map (M20 A5; DAT-245, D-1108, AGT-011a). Plain data: the NSE/BSE announcement
// subject (`type`, a case-insensitive substring) or a headline pattern (`title_re`, case-insensitive) to one of the 11
// AGT-020 categories, with the AGT-011 materiality (0..3) and whether the category can be verified (CTX-043).
// First match wins, so the order is the priority; the last row matches everything (`other`). Never an LLM output.
//
// `verifiable` here says the category is eligible; the evidence is the item's own facts (`classify` applies it):
// results and guidance only when their statements were parsed (XBRL, when its terms pass), a contract only when a
// value and a counterparty are disclosed. `materiality_disclosed` raises a contract from 2 to 3 on that disclosure.
const row = (match, category, materiality, verifiable = false, extra = {}) =>
  Object.freeze({
    match: Object.freeze(match),
    category,
    materiality,
    verifiable,
    ...extra,
  });
const contract = (type) => row({ type }, "contract", 2, true, { materiality_disclosed: 3 });

/** The `category_map` field kind of the profile that selects this map. */
export const CATEGORY_KIND = "headline_categories";

export const CATEGORY_MAP = Object.freeze({
  version: "in-categories-v1",
  rows: Object.freeze([
    row({ type: "Trading Suspension" }, "halt", 3),
    row({ type: "Band change" }, "halt", 3),
    row({ type: "Clarification" }, "exchange_query", 2),
    row({ type: "Guidance" }, "guidance", 3, true),
    row({ type: "Financial Results" }, "results", 3, true),
    row({ type: "Outcome of Board Meeting" }, "results", 3, true),
    contract("Bagging"),
    contract("Receipt of orders"),
    contract("Receiving of orders"),
    contract("Contract"),
    row({ type: "Preferential Issue" }, "capital_raising", 2),
    row({ type: "Rights Issue" }, "capital_raising", 2),
    row({ type: "QIP" }, "capital_raising", 2),
    row({ type: "Fund raising" }, "capital_raising", 2),
    row({ type: "Insider Trading" }, "director_trade", 1),
    row({ type: "SEBI (PIT)" }, "director_trade", 1),
    row({ type: "SAST" }, "substantial_holder", 1),
    row({ type: "Acquisition" }, "takeover", 3),
    row({ type: "Scheme of Arrangement" }, "takeover", 3),
    row({ type: "Open Offer" }, "takeover", 3),
    row({ type: "Dividend" }, "dividend", 1),
    row({}, "other", 0),
  ]),
});
