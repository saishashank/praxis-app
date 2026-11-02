// M17 WP3: arming (ARN-112, D-397). Step 1 of every poll tick, idempotent: an alert id that already has
// a row (armed, hit or cleared) is never armed again, so a cleared alert stays cleared until the pick is
// re-issued at a later 18:10 (a new pick key is a new alert id). `armed_at` is the first tick of the
// pick's first session; nothing is evaluated before arming.
import type { Exec } from "@/lib/cortex/store/common";
import { armableOrders } from "./armable";
import { alertExists, alertIdOf, insertTransition } from "./store";
import type { ArmableOrder } from "./types";

export type ArmResult = { armed: number; orders: ArmableOrder[] };

export async function armForSession(
  db: Exec,
  market: string,
  session: string,
  userIds: readonly string[],
  now: Date,
): Promise<ArmResult> {
  const orders = await armableOrders(db, market, session);
  let armed = 0;
  for (const o of orders) {
    for (const userId of userIds) {
      const alertId = alertIdOf(userId, market, o.pickKey.d, o.pickKey.profile, o.pickKey.rank);
      if (await alertExists(db, alertId)) continue;
      const wrote = await insertTransition(db, {
        alertId,
        seq: 1,
        userId,
        market,
        pickD: o.pickKey.d,
        profile: o.pickKey.profile,
        rank: o.pickKey.rank,
        code: o.code,
        sessionD: session,
        state: "armed",
        limitMicro: o.limitMicro,
        stopMicro: o.stopMicro,
        at: now.toISOString(),
        hitMicro: null,
        quoteAt: null,
        clearReason: null,
      });
      if (wrote) armed += 1;
    }
  }
  return { armed, orders };
}
