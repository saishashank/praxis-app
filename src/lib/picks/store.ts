// Storage of published picks (ARN-095): `pick` rows are append-only and carry the numbers shown
// at publication; every pick starts two `pick_outcome` rows in state `waiting`, one for the pick
// and one for its luck-check twin. Writing is idempotent: the same pick again writes nothing; a
// different pick under the same key raises (nothing can be edited afterwards).
import type { Client, InStatement } from "@libsql/client";
import { canonicalJson } from "./canonical";
import { PicksError, type Pick } from "./types";

type Db = Client;

const text = (v: unknown): string => String(v);

export async function writePicks(db: Db, picks: readonly Pick[]): Promise<number> {
  let written = 0;
  for (const p of picks) {
    const existing = await db.execute({
      sql: `SELECT pick_sha FROM pick WHERE market = ? AND d = ? AND profile = ? AND rank = ?`,
      args: [p.market, p.d, p.profile, p.rank],
    });
    if (existing.rows.length > 0) {
      if (text(existing.rows[0]!.pick_sha) !== p.pickSha) {
        throw new PicksError(`pick ${p.d}/${p.profile}/${p.rank} exists with different numbers`);
      }
      continue;
    }
    const stmts: InStatement[] = [
      {
        sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id,
                card_id, label, reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro,
                aim_reach_ppm, n_similar, bad_ppm, typical_ppm, good_ppm, time_frame_sessions,
                size_micro, risk_micro, factors_json, based_on_json, pick_sha, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          p.market,
          p.d,
          p.profile,
          p.rank,
          p.code,
          p.family,
          p.tier,
          p.ruleVersion,
          p.signalId,
          p.cardId,
          p.label,
          p.referenceMicro,
          p.buyMaxMicro,
          p.validUntilD,
          p.stopMicro,
          p.aimMicro,
          p.aimReachPpm,
          p.nSimilar,
          p.badPpm,
          p.typicalPpm,
          p.goodPpm,
          p.timeFrameSessions,
          p.sizeMicro,
          p.riskMicro,
          canonicalJson(p.factors),
          canonicalJson(p.basedOn),
          p.pickSha,
          p.createdAt,
        ],
      },
      outcomeInsert(p, "pick", p.code),
    ];
    if (p.luckCode !== null) stmts.push(outcomeInsert(p, "luck", p.luckCode));
    await db.batch(stmts, "write");
    written += 1;
  }
  return written;
}

function outcomeInsert(p: Pick, kind: "pick" | "luck", code: string): InStatement {
  return {
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
    args: [p.market, p.d, p.profile, p.rank, kind, code, p.pickSha, p.d],
  };
}
