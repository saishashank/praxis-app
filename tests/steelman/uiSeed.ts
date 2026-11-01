// Test-only seed for the steelman UI tests (M11-lite WP6): a pack, points and a suggestion on the card
// of the synthetic loader seed (CARD_UP, ZZUP, family F1). Not a test file.
import type { Client } from "@libsql/client";
import { insertPack, insertPoint, insertSuggestion, pointIdOf } from "@/lib/steelman/store";
import { CARD_UP, D } from "../loaders/seed";

export const PACK_ID = "c".repeat(64);
const AT = "2026-10-19T08:00:00.000Z";

export const ITEMS = [
  { id: "E01", kind: "card", text: "Subject order ZZUP, Zed Upward Holdings" },
  { id: "E02", kind: "event", text: "Zed Upward Holdings reported results on 2026-10-19." },
  { id: "E03", kind: "regime", text: "The market state is neutral." },
];

const P = (side: "bull" | "bear", n: number, text: string, citations: string[], mon = false) => ({
  pointId: pointIdOf(PACK_ID, side, n),
  packId: PACK_ID,
  side,
  n,
  text,
  citations,
  monitorable: mon,
  state: "shown" as const,
  authorProvider: "alpha",
  authorModel: "alpha-model",
  criticProvider: "beta",
  criticModel: "beta-model",
  criticNote: null,
  createdAt: AT,
});

export const BEAR_MON = P(
  "bear",
  1,
  "ZZUP depends on one result that may not repeat.",
  ["E02"],
  true,
);

export async function seedSteelman(main: Client, o: { suggestion?: boolean } = {}): Promise<void> {
  await insertPack(main, {
    packId: PACK_ID,
    market: "AU",
    d: D,
    subjectKind: "order",
    subjectId: CARD_UP,
    code: "ZZUP",
    cardId: CARD_UP,
    cutoffAt: AT,
    items: ITEMS,
    itemCount: ITEMS.length,
    createdAt: AT,
  });
  for (const p of [
    P("bull", 1, "Zed Upward Holdings reported results.", ["E02"]),
    P("bull", 2, "The market state is neutral.", ["E03"]),
    BEAR_MON,
    P("bear", 2, "A neutral market gives little lift.", ["E03"]),
    { ...P("bear", 3, "Hidden by the checker.", ["E01"]), state: "hidden_critic" as const },
  ]) {
    await insertPoint(main, p);
  }
  if (o.suggestion !== false) {
    await insertSuggestion(main, {
      market: "AU",
      d: D,
      pointId: BEAR_MON.pointId,
      cardId: CARD_UP,
      code: "ZZUP",
      family: "F1",
      createdAt: AT,
    });
  }
}
