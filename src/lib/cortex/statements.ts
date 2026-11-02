// CTX-053 / CTX-082 statements and the luck figure (M15 P6; D-277, D-358). The text comes from the
// templates in statusRules.mjs only (CTX-072: the Owner cannot edit a statement); this file adds the
// typed rows and the plain-words check. Generator only: a live-tested statement is built here but is
// not publishable until n_eff_live >= 150 and the four CTX-082 criteria hold.
import { CARD_BANNED } from "./phrases";
import type { CortexFamily, Exec, StatementRow } from "./store";
import {
  allowedWeakStatement,
  LIVE_PENDING_LABEL,
  LIVE_TESTED_MIN_NEFF,
  liveTestedStatement,
  luckChance,
  luckFigure,
  projectSessions,
  type LiveTestedDraft,
  type LiveTestedInput,
} from "./statusRules.mjs";

export {
  allowedWeakStatement,
  LIVE_PENDING_LABEL,
  LIVE_TESTED_MIN_NEFF,
  liveTestedStatement,
  luckChance,
  luckFigure,
  projectSessions,
};

/** CTX-002: words the Cortex never uses to the Owner. */
export const STATEMENT_BANNED: readonly RegExp[] = [
  /\bcertain\b/i,
  /\bguarantee[ds]?\b/i,
  /\bwill\b/i,
  /\b99\s?%/,
  /\bcertified\b/i,
];

/**
 * Plain-words problems of a statement text: the card ban list (CTX-070 vocabulary) applied to the text
 * with the one mandated label removed, plus the CTX-002 words. Empty = clean.
 */
export function statementProblems(text: string): string[] {
  const body = text.split(LIVE_PENDING_LABEL).join("");
  const out: string[] = [];
  for (const re of [...CARD_BANNED, ...STATEMENT_BANNED]) if (re.test(body)) out.push(re.source);
  return out;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

export type AllowedWeakInput = {
  market: string;
  family: CortexFamily;
  createdAt: string;
  /** Live n_eff gained per session at the pace so far (null = not measured). */
  nEffLivePerSession: number | null;
};

/** The CTX-053 statement row marked "live-tested pending (n_eff_live = 0)". */
export function allowedWeakRow(i: AllowedWeakInput): StatementRow {
  const d = allowedWeakStatement({ family: i.family, nEffLivePerSession: i.nEffLivePerSession });
  return {
    statementId: `stmt:${i.market}:${i.family}:allowed_weak:${dayOf(i.createdAt)}`,
    market: i.market,
    family: i.family,
    kind: "allowed_weak",
    text: d.text,
    numbers: d.numbers,
    nEffLive: 0,
    createdAt: i.createdAt,
  };
}

export type LiveTestedResult =
  | { publishable: false; draft: LiveTestedDraft }
  | { publishable: true; draft: LiveTestedDraft; row: StatementRow };

/** CTX-082: a row only when n_eff_live >= 150 and every criterion holds; otherwise the draft only. */
export function liveTestedRow(
  i: LiveTestedInput & { market: string; createdAt: string },
): LiveTestedResult {
  const draft = liveTestedStatement(i);
  if (!draft.publishable) return { publishable: false, draft };
  return {
    publishable: true,
    draft,
    row: {
      statementId: `stmt:${i.market}:${i.family}:live_tested:${dayOf(i.createdAt)}`,
      market: i.market,
      family: i.family as CortexFamily,
      kind: "live_tested",
      text: draft.text,
      numbers: draft.numbers,
      nEffLive: i.nEffLive,
      createdAt: i.createdAt,
    },
  };
}

/** D-358: (ledger cells + Owner key edits) x ledger_fdr_q, counted from the ledger. */
export async function luckFigureFromLedger(db: Exec, market: string, q: number) {
  const cnt = async (where: string): Promise<number> => {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM cortex_ledger_cell WHERE market = ? AND ${where}`,
      args: [market],
    });
    return Number(r.rows[0]?.n ?? 0);
  };
  return luckFigure(await cnt("kind <> 'key_edit'"), await cnt("kind = 'key_edit'"), q);
}
