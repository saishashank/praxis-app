// State `steelman-cards` (TST-135 (a), M11-lite WP6, OPS-111 (8)): one stored Decision Card with a steelman pack
// and two points a side, so the card section renders from rows. It brings its own card (the `rich` seed in
// e2e/seed/steelman.ts reuses one from the rich scenario) and deliberately NO open suggestion: the rich lane's
// /review walk dismisses the one suggestion that seed makes and expects none left. Synthetic ZZ code, fixed ids,
// idempotent (INSERT OR IGNORE on every keyed row).
export const CARD_ID = "e2e-steelman-card";
export const CODE = "ZZSM";
export const PACK = "e".repeat(64);
export const BEAR_TEXT = "The result may not repeat next quarter.";
const SHA = "b".repeat(64);
const D = "2026-10-16";
const AT = "2026-10-16T09:00:00.000Z";

const CARD = {
  family: "F3",
  rule_version: "v1",
  thesis: "drift",
  regime: "NEUTRAL",
  rules_fired: [{ rule: "volume_surge", value: "2.4", threshold: "2.0", pass: true }],
  evidence: {
    events: [{ category: "contract_win", polarity: "positive", day0: D }],
    insider_flow: "unknown",
    data_quality_flags: ["thin"],
    other_flags: [],
  },
  scenario: {
    insufficient_history: false,
    n: 37,
    p10_ppm: -3,
    p50_ppm: 5,
    p90_ppm: 9,
    split_version: 2,
  },
  sizing: { accepted: true, half_size: false, reasons: [] },
  cost: { available: true, break_even_ppm: 4200 },
};

/** @param {import("@libsql/client").Client} client */
export async function apply(client) {
  const items = [
    {
      id: "E01",
      kind: "event",
      text: "A results announcement was published on the evening before.",
    },
    { id: "E02", kind: "regime", text: "The market state is neutral." },
  ];
  /** @param {string} side @param {number} n @param {string} text @param {string[]} cites @param {number} mon */
  const pt = (side, n, text, cites, mon) => ({
    sql: `INSERT OR IGNORE INTO steelman_point (point_id, pack_id, side, n, text, citations_json, monitorable, state,
            author_provider, author_model, created_at) VALUES (?,?,?,?,?,?,?,'shown','alpha','alpha-model',?)`,
    args: [`${PACK}:${side}:${n}`, PACK, side, n, text, JSON.stringify(cites), mon, AT],
  });
  await client.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score,
                rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
              VALUES ('e2e-steelman-sig', 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', '1.5', '[]', '{}', 1, 'a', 'r', ?)`,
        args: [D, CODE, AT],
      },
      {
        sql: `INSERT OR IGNORE INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, order_id,
                card_json, card_sha, schema_version, decided_at)
              VALUES (?, 'e2e-steelman-sig', 'x', 1, NULL, 'o-e2e-steelman', ?, ?, 1, ?)`,
        args: [CARD_ID, JSON.stringify(CARD), SHA, AT],
      },
      {
        sql: `INSERT OR IGNORE INTO steelman_pack (pack_id, market, d, subject_kind, subject_id, code, card_id, cutoff_at,
                items_json, item_count, created_at) VALUES (?,?,?,'order',?,?,?,?,?,?,?)`,
        args: [PACK, "AU", D, CARD_ID, CODE, CARD_ID, AT, JSON.stringify(items), 2, AT],
      },
      pt("bull", 1, "The announcement was well received.", ["E01"], 0),
      pt("bull", 2, "The market state is neutral.", ["E02"], 0),
      pt("bear", 1, BEAR_TEXT, ["E01"], 1),
      pt("bear", 2, "A neutral market gives little lift.", ["E02"], 0),
    ],
    "write",
  );
}
