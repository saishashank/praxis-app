// Intraday thesis-breakers from Sentinel assessments (M5 T7; AGT-111, AGT-012; docs/M5_design.md 2.5,
// 4.4 step 2, D-096 #39; D-102 draft). A newly assessed announcement on a code with an open E
// position or a pending E entry runs ONLY the event breakers of that position's card (TB-NEG,
// TB-HALT, TB-RAISE, TB-KW) through the same pure evaluator as the nightly batch and the replay.
// Effects: one `thesis_breaker_eval` row per breaker (phase intraday) and, for a red status, a call
// to the `BreakerAlertSink`. Never an order: the Sentinel does not change orders (AGT-012); a held
// position exits through the nightly cycle (batch 2b), a pending buy is cancelled by the pre-open
// re-check. Announcements published before the card's decision were known to it and are skipped.
//
// `seq` (D-097): the key is (subject, breaker, d, phase, seq); every new announcement of the day is a
// new row. An announcement already evaluated for a subject is recognised by its reference at the start
// of `value_text`, so a repeated call writes nothing new and raises no second alert.
import type { Client } from "@libsql/client";
import {
  BREAKER_EVAL_RULE_VERSION,
  createAlertRowSink,
  evaluateBreakers,
  itemFromAnnouncement,
  type BreakerAlertSink,
  type BreakerObservation,
} from "@/lib/agents/breakerEval";
import { loadBreakerSubjects } from "@/lib/agents/breakerNightly";
import type { AgentParams } from "@/lib/agents/params";
import { ASX_SOURCE } from "@/lib/data/asxToken";

type Exec = Pick<Client, "execute">;

export type IntradayAnnouncement = {
  readonly annId: string;
  readonly code: string;
  readonly type: string | null;
  readonly title: string;
  readonly priceSensitive: boolean;
  /** ISO-8601 UTC. */
  readonly publishedAt: string;
};

export type IntradayInput = {
  readonly db: Client;
  readonly market: string;
  /** Sydney date the evaluation belongs to (the `d` of the rows). */
  readonly today: string;
  /** ISO-8601 UTC; stamps the alert only. */
  readonly now: string;
  readonly params: AgentParams;
  readonly announcements: readonly IntradayAnnouncement[];
  readonly sink?: BreakerAlertSink;
};

export type IntradayResult = { evaluated: number; rows: number; red: number };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function alreadyDone(
  db: Exec,
  subjectId: string,
  breakerId: string,
  d: string,
  prefix: string,
): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM thesis_breaker_eval
          WHERE subject_id = ? AND breaker_id = ? AND d = ? AND phase = 'intraday'
            AND substr(value_text, 1, length(?)) = ? LIMIT 1`,
    args: [subjectId, breakerId, d, prefix, prefix],
  });
  return rs.rows.length > 0;
}

async function nextSeq(db: Exec, subjectId: string, breakerId: string, d: string): Promise<number> {
  const rs = await db.execute({
    sql: `SELECT COALESCE(MAX(seq), 0) AS n FROM thesis_breaker_eval
          WHERE subject_id = ? AND breaker_id = ? AND d = ? AND phase = 'intraday'`,
    args: [subjectId, breakerId, d],
  });
  return Number(rs.rows[0]?.n ?? 0) + 1;
}

/** Evaluates the event breakers of every affected position for the given announcements. */
export async function evaluateIntraday(i: IntradayInput): Promise<IntradayResult> {
  const out: IntradayResult = { evaluated: 0, rows: 0, red: 0 };
  if (i.announcements.length === 0) return out;
  const codes = new Set(i.announcements.map((a) => a.code));
  const subjects = (await loadBreakerSubjects(i.db, i.today)).filter((s) => codes.has(s.code));
  if (subjects.length === 0) return out;
  const sink = i.sink ?? createAlertRowSink(i.db);
  const anns = [...i.announcements].sort(
    (a, b) => cmp(a.publishedAt, b.publishedAt) || cmp(a.annId, b.annId),
  );
  for (const s of subjects) {
    for (const a of anns) {
      if (a.code !== s.code || a.publishedAt < s.decidedAt) continue;
      const ref = `${ASX_SOURCE}|${a.annId}`;
      const prefix = `${ref}: `;
      const item = itemFromAnnouncement({
        ref,
        type: a.type,
        title: a.title,
        priceSensitive: a.priceSensitive,
      });
      const obs: BreakerObservation = {
        d: i.today,
        phase: "intraday",
        closeMicro: null,
        smaMicro: null,
        refCloseMicro: null,
        shortDeltaPpm: null,
        regime: null,
        items: [item],
      };
      const ev = evaluateBreakers(s.breakers, obs, i.params);
      out.evaluated += 1;
      for (const e of ev.evaluations) {
        if (await alreadyDone(i.db, s.id, e.id, i.today, prefix)) continue;
        const seq = await nextSeq(i.db, s.id, e.id, i.today);
        const res = await i.db.execute({
          sql: `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind,
                  card_id, market, code, status, value_text, trigger_text, amber_text, trigger_ref,
                  rule_version)
                VALUES (?, ?, ?, 'intraday', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [
            s.id,
            e.id,
            i.today,
            seq,
            s.kind,
            s.cardId,
            i.market,
            s.code,
            e.status,
            `${prefix}${e.valueText}`,
            e.triggerText,
            e.amberText,
            e.status === "red" ? e.triggerRef : null,
            BREAKER_EVAL_RULE_VERSION,
          ],
        });
        out.rows += res.rowsAffected;
        if (e.status !== "red" || res.rowsAffected === 0) continue;
        out.red += 1;
        await sink.record({
          key: `tb:${s.id}:${e.id}:${i.today}`,
          market: i.market,
          code: s.code,
          d: i.today,
          phase: "intraday",
          subjectKind: s.kind,
          subjectId: s.id,
          cardId: s.cardId,
          executionId: s.executionId,
          breakerId: e.id,
          status: "red",
          valueText: e.valueText,
          triggerText: e.triggerText,
          triggerRef: e.triggerRef,
          effect: "none",
          detectedAt: i.now,
        });
      }
    }
  }
  return out;
}
