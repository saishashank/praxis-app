// M11-lite WP6 e2e seed: one steelman pack with points on the first stored Decision Card and one open
// suggestion for the Owner's /review ("rich" scenario). Synthetic text only. Idempotent: it checks for
// its own pack row.
import { createClient } from "@libsql/client";
import { ensureRich } from "./rich";

const PACK = "d".repeat(64);
const AT = "2026-10-16T09:00:00.000Z";
export const BEAR_TEXT = "The result may not repeat next quarter.";

/** Seeds once and returns the id of the card the steelman is on. */
export async function ensureSteelman(): Promise<string> {
  if (process.env.E2E_SCENARIO !== "rich") return "";
  await ensureRich();
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    const have = await m.execute({
      sql: "SELECT card_id FROM steelman_pack WHERE pack_id = ?",
      args: [PACK],
    });
    if (have.rows.length > 0) return String(have.rows[0].card_id);
    const c = (await m.execute("SELECT id, card_json FROM decision_card ORDER BY id LIMIT 1"))
      .rows[0];
    const cardId = String(c.id);
    const card = JSON.parse(String(c.card_json)) as {
      market: string;
      d: string;
      code: string;
      family: string;
    };
    const items = [
      {
        id: "E01",
        kind: "event",
        text: "A results announcement was published on the evening before.",
      },
      { id: "E02", kind: "regime", text: "The market state is neutral." },
    ];
    const pt = (side: string, n: number, text: string, cites: string[], mon: number) => ({
      sql: `INSERT INTO steelman_point (point_id, pack_id, side, n, text, citations_json, monitorable, state,
              author_provider, author_model, created_at) VALUES (?,?,?,?,?,?,?,'shown','alpha','alpha-model',?)`,
      args: [`${PACK}:${side}:${n}`, PACK, side, n, text, JSON.stringify(cites), mon, AT],
    });
    await m.batch(
      [
        {
          sql: `INSERT INTO steelman_pack (pack_id, market, d, subject_kind, subject_id, code, card_id, cutoff_at,
                  items_json, item_count, created_at) VALUES (?,?,?,'order',?,?,?,?,?,?,?)`,
          args: [
            PACK,
            card.market,
            card.d,
            cardId,
            card.code,
            cardId,
            AT,
            JSON.stringify(items),
            2,
            AT,
          ],
        },
        pt("bull", 1, "The announcement was well received.", ["E01"], 0),
        pt("bull", 2, "The market state is neutral.", ["E02"], 0),
        pt("bear", 1, BEAR_TEXT, ["E01"], 1),
        pt("bear", 2, "A neutral market gives little lift.", ["E02"], 0),
        {
          sql: `INSERT INTO steelman_suggestion (suggestion_id, market, d, point_id, card_id, code, family, status,
                  created_at) VALUES (?,?,?,?,?,?,?,'open',?)`,
          args: [
            `${PACK}:bear:1`,
            card.market,
            card.d,
            `${PACK}:bear:1`,
            cardId,
            card.code,
            card.family,
            AT,
          ],
        },
      ],
      "write",
    );
    return cardId;
  } finally {
    m.close();
  }
}
