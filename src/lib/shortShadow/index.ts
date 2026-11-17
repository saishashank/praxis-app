// The shadow short stream's one entry point, called once by batch 3 after the would-have outcomes (M21 R1; VAL-121, D-1228).
// Off unless the market's switch is on (`enabled.ts`). Selection, scoring and the one look write the two shadow tables and,
// once, one `holdout_look` row; no book, no order, no signal, no rule, no alert, no pick, no e-mail, and no log line on success.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { CalendarRow } from "@/lib/data/calendar";
import { shortShadowEnabled } from "./enabled";
import { evaluateShort, shortLookTaken, type ShortEvaluation } from "./evaluate";
import { scoreShort } from "./score";
import { SHORT_RULE_ID, selectShort } from "./select";
import { insertShortDecision } from "./store";

export type ShortShadowRun =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly selected: number;
      readonly scored: number;
      readonly open: number;
      readonly evaluation: ShortEvaluation;
    };

export async function runShortShadow(
  db: Client,
  o: {
    market: string;
    d: string;
    params: AgentParams;
    now: () => string;
    calendar?: readonly CalendarRow[];
  },
): Promise<ShortShadowRun> {
  if (!(await shortShadowEnabled(db, o.market))) return { ran: false };
  const setups = await selectShort(db, { market: o.market, d: o.d });
  const createdAt = o.now();
  for (const s of setups) {
    await insertShortDecision(db, {
      market: s.market,
      d: s.d,
      code: s.code,
      origin: s.origin,
      bookId: s.bookId,
      rankKey: s.rankKey,
      family: s.family,
      shortable: s.shortable,
      ruleId: SHORT_RULE_ID,
      createdAt,
    });
  }
  const sc = await scoreShort(db, {
    market: o.market,
    d: o.d,
    params: o.params,
    now: o.now,
    calendar: o.calendar,
  });
  // the night is not an attempt at a second look: once the look is on file the call is skipped (a direct second attempt is audited)
  const evaluation: ShortEvaluation = (await shortLookTaken(db, o.market))
    ? { status: "refused", reason: "already_looked" }
    : await evaluateShort(db, { market: o.market, now: o.now });
  return { ran: true, selected: setups.length, scored: sc.scored, open: sc.open, evaluation };
}

export { shortShadowEnabled } from "./enabled";
