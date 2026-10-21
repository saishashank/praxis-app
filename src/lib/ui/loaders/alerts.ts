// Alert inbox loader (UX-060..062, UXN-157/158/160/161; docs/M7_design.md 3 row 17; D-136 draft).
// Reads through the existing inbox (`listInbox`, D-101) and masks the rows for a masked user with the
// same function the JSON route uses (`maskAlertViews`, D-129), so the page and `GET /api/alerts`
// cannot differ. P0 is always an open group.
import { ALERT_TIERS, type AlertTier } from "@/lib/sentinel/schema";
import { listInbox, getQuietHours, type AlertView, type QuietHours } from "@/lib/alerts/api";
import { maskAlertViews } from "@/lib/view/alerts";
import type { LoaderEnv, LoaderState } from "./shell";

export type AlertsQuery = { tier?: AlertTier; unacked: boolean };
export type AlertGroup = { tier: AlertTier; open: boolean; alerts: AlertView[] };
export type AlertsModel = {
  state: LoaderState;
  masked: boolean;
  badge: number;
  quietHours: QuietHours | null;
  groups: AlertGroup[];
};

/** `?tier=&unacked=`: null when a value is not allowed. */
export function parseAlertsQuery(sp: URLSearchParams): AlertsQuery | null {
  const tier = sp.get("tier");
  if (tier !== null && tier !== "" && !(ALERT_TIERS as readonly string[]).includes(tier)) {
    return null;
  }
  const un = sp.get("unacked");
  if (un !== null && !["1", "true", "0", "false", ""].includes(un)) return null;
  return {
    tier: tier ? (tier as AlertTier) : undefined,
    unacked: un === "1" || un === "true",
  };
}

export async function loadAlerts(env: LoaderEnv, q: AlertsQuery): Promise<AlertsModel> {
  const r = await listInbox(
    { mainDb: env.main, authDb: env.auth },
    env.user.id,
    { tier: q.tier, unacked: q.unacked },
    env.now,
  );
  const alerts = env.mask.masked ? await maskAlertViews(env.main, r.alerts) : r.alerts;
  const groups: AlertGroup[] = ALERT_TIERS.map((tier) => ({
    tier,
    open: tier === "P0" || alerts.some((a) => a.tier === tier && a.ackedAt === null),
    alerts: alerts.filter((a) => a.tier === tier),
  })).filter((g) => g.alerts.length > 0 || g.tier === "P0");
  return {
    state: alerts.length === 0 ? "empty" : "ok",
    masked: env.mask.masked,
    badge: r.badge,
    quietHours: await getQuietHours(env.auth, env.user.id),
    groups,
  };
}
