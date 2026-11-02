// M17 WP3: the one adapter from picks to alerts (D-384, ARN-112). Reads only. V1 picks now: the latest
// published list before the session, minus withdrawn picks (`pick_check`, `pick_outcome`), filled
// picks, and entries the pre-open re-check removed (`preopen_result`). limit = buy_max_micro,
// stop = stop_micro. The allowed-family Cortex branch returns nothing until a `family_status` row is
// `allowed` (none is, D-379/D-380).
import type { Exec } from "@/lib/cortex/store/common";
import type { ArmableOrder } from "./types";

export async function armableOrders(
  db: Exec,
  market: string,
  session: string,
): Promise<ArmableOrder[]> {
  const r = await db.execute({
    sql: `SELECT p.market AS market, p.d AS d, p.profile AS profile, p.rank AS rank, p.code AS code,
                 p.buy_max_micro AS limit_micro, p.stop_micro AS stop_micro, p.family AS family,
                 p.created_at AS created_at
          FROM pick p
          WHERE p.market = ?
            AND p.d = (SELECT MAX(x.d) FROM pick x WHERE x.market = ? AND x.d < ?)
            AND p.valid_until_d >= ?
            AND NOT EXISTS (SELECT 1 FROM pick_check c WHERE c.market = p.market AND c.d = p.d
                 AND c.profile = p.profile AND c.rank = p.rank AND c.valid = 0 AND c.night_d < ?)
            AND NOT EXISTS (SELECT 1 FROM pick_outcome o WHERE o.market = p.market AND o.d = p.d
                 AND o.profile = p.profile AND o.rank = p.rank AND o.kind = 'pick'
                 AND o.state IN ('missed','bought','closed'))
            AND NOT EXISTS (SELECT 1 FROM arena_order a JOIN preopen_result r ON r.order_id = a.id
                 WHERE a.kind = 'entry' AND a.code = p.code AND a.signal_id = p.signal_id
                 AND a.decided_d = p.d AND r.outcome = 'cancel' AND r.d <= ?)
          ORDER BY p.profile, p.rank`,
    args: [market, market, session, session, session, session],
  });
  return r.rows.map((x) => ({
    pickKey: {
      market: String(x.market),
      d: String(x.d),
      profile: String(x.profile),
      rank: Number(x.rank),
    },
    code: String(x.code),
    limitMicro: BigInt(x.limit_micro as number),
    stopMicro: BigInt(x.stop_micro as number),
    family: String(x.family),
    publishedAt: String(x.created_at),
  }));
}
