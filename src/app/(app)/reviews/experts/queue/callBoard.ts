// What the claims queue shows for each call claim (M22 E3; KB-084, D-1435): the call already followed, the stored
// proposal, or (when none was stored yet) the rules answer worked out now from the claim's own summary. A reader: it
// writes nothing; the proposal is stored and the call written only when the person confirms (review.ts).
import type { Client } from "@libsql/client";
import {
  callStatements,
  confirmedCalls,
  latestProposals,
  loadHolidays,
  proposeForClaim,
  resolveUniverse,
  type CallProposal,
  type ConfirmedCall,
} from "@/lib/experts/callProposals";

export type CallEntry =
  | { kind: "followed"; call: ConfirmedCall }
  | { kind: "proposal"; proposal: CallProposal; stored: boolean };

const DAY_CHARS = 10; // threshold-ok: length of YYYY-MM-DD

/** One entry per call claim id in `claimIds` (claims with no text are absent). */
export async function loadCallBoard(
  db: Client,
  market: string,
  claimIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, CallEntry>> {
  const out = new Map<string, CallEntry>();
  if (claimIds.length === 0) return out;
  const [statements, stored, followed] = await Promise.all([
    callStatements(db),
    latestProposals(db),
    confirmedCalls(db),
  ]);
  const todo = claimIds.filter((id) => !followed.has(id) && !stored.has(id) && statements.has(id));
  const texts = todo.map((id) => statements.get(id) as string);
  const day = now.toISOString().slice(0, DAY_CHARS);
  const universe =
    todo.length > 0 ? await resolveUniverse(db, market, day, texts) : { market, codes: [] };
  const calendar = todo.length > 0 ? await loadHolidays(db, market) : [];
  for (const id of claimIds) {
    const f = followed.get(id);
    if (f !== undefined) {
      out.set(id, { kind: "followed", call: f });
      continue;
    }
    const sp = stored.get(id);
    if (sp !== undefined) {
      out.set(id, { kind: "proposal", proposal: sp, stored: true });
      continue;
    }
    const text = statements.get(id);
    if (text === undefined) continue;
    out.set(id, {
      kind: "proposal",
      proposal: await proposeForClaim(id, text, universe, calendar),
      stored: false,
    });
  }
  return out;
}
