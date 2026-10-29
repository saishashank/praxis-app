// The Owner review queue read model (UX-114): unresolved corporate action conflicts on held or
// candidate codes, as plain-language cards. Read-only.
import type { Client } from "@libsql/client";
import {
  DEFAULT_AUTO_APPLY_SESSIONS,
  autoApplyDate,
  classOf,
  describeTerms,
  isPriceOnly,
  reasonText,
  typeLabel,
} from "./rules.mjs";
import { loadActions, readCaConfig } from "./engine.mjs";

export type ReviewCard = {
  id: number;
  code: string;
  typeLabel: string;
  exDate: string;
  terms: string;
  sources: string[];
  reasons: string[];
  /** Other interpretations of the same event, so the Owner sees the conflict. */
  alternatives: string[];
  /** Observed ex-date close-to-close ratio, when a price comparison was possible. */
  observed: number | null;
  queuedOn: string | null;
  /** The session on which the item is applied on best evidence (DAT-221), when known. */
  applyOn: string | null;
  /** GL-01: a price-only reading that the vendor evidence vetoes is never applied automatically. */
  neverAuto: boolean;
};

export type ReviewQueue = { cards: ReviewCard[]; blockedOnly: number };

export async function loadReviewQueue(db: Client, market = "AU"): Promise<ReviewQueue> {
  const io = { read: 0, written: 0 };
  const actions = await loadActions(db, io, market);
  const sessions = (await readCaConfig(db, io)).autoApplySessions ?? DEFAULT_AUTO_APPLY_SESSIONS;
  const owner = actions.filter((a) => a.state === "owner");
  const from = owner.reduce<string | null>(
    (m, a) => (a.stateSince && (m === null || a.stateSince < m) ? a.stateSince : m),
    null,
  );
  let cal: { d: string; kind: string }[] = [];
  if (from) {
    const r = await db.execute({
      sql: "SELECT d, kind FROM trading_calendar WHERE market = ? AND d >= ?",
      args: [market, from],
    });
    cal = r.rows.map((x) => ({ d: String(x.d), kind: String(x.kind) }));
  }
  const cards = owner.map((a): ReviewCard => {
    const siblings = actions.filter(
      (x) =>
        x.id !== a.id &&
        x.code === a.code &&
        x.ex_date === a.ex_date &&
        classOf(x.type) === classOf(a.type) &&
        ["pending", "owner", "blocked", "confirmed"].includes(x.state),
    );
    return {
      id: a.id,
      code: a.code,
      typeLabel: typeLabel(a.type),
      exDate: a.ex_date,
      terms: describeTerms(a.type, a.payload),
      sources: a.sources,
      reasons: (Array.isArray(a.note.reasons) ? a.note.reasons : []).map((r: unknown) =>
        reasonText(String(r)),
      ),
      alternatives: siblings.map(
        (x) => `${typeLabel(x.type)}: ${describeTerms(x.type, x.payload)}`,
      ),
      observed: typeof a.note.observed === "number" ? a.note.observed : null,
      queuedOn: a.stateSince,
      // GL-01: the same rule applyDue uses, so the card and the engine never disagree.
      neverAuto: isPriceOnly(a.sources),
      applyOn: a.stateSince ? autoApplyDate(a.stateSince, cal, sessions) : null,
    };
  });
  return { cards, blockedOnly: actions.filter((a) => a.state === "blocked").length };
}
