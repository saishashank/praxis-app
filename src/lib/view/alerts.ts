// Masking of the alert inbox (DAT-124, ROL-107, UX-009 "alert inbox uses letters"; D-128). The inbox
// spans several Melbourne dates, so each alert is lettered from the active set of ITS OWN date
// (signals plus alerts of that date, UX-009), which keeps "Stock A" the same stock on every page for
// that date and never reuses a letter within it. Also: the alert text and "why" lines pass through
// maskText, and a key that contains a code or a trade id (`proxy:`, `tb:`) is replaced by an opaque
// `mk:` key that the ack and snooze routes resolve server-side.
import type { Client } from "@libsql/client";
import type { AlertView } from "@/lib/alerts/api";
import { activeCodesByDate, melbourneDate } from "./active";
import { opaqueDigest } from "./opaqueRef";
import { loadMaskLookup, maskText, StockAliases, type MaskLookup } from "./mask";

const OPAQUE_PREFIX = "mk:";
const OPAQUE_RE = /^mk:([0-9a-f]{16})$/;
const CODE_BEARING_KEY = /^(?:tb|proxy):/;

/** `mk:` + 16 hex of SHA-256 for a key that would show a code or trade id; other keys are unchanged. */
export function publicAlertKey(key: string): string {
  if (!CODE_BEARING_KEY.test(key)) return key;
  return OPAQUE_PREFIX + opaqueDigest("mk", key);
}

export const isOpaqueAlertKey = (key: string): boolean => OPAQUE_RE.test(key);

const WINDOW_DAYS = 60; // threshold-ok: how far back an opaque key can still be resolved
const DAY_MS = 86_400_000; // threshold-ok: unit conversion

/** The stored key behind an opaque key (null if none matches); any other key is returned as given. */
export async function resolveAlertKey(
  mainDb: Pick<Client, "execute">,
  key: string,
  now: Date = new Date(),
): Promise<string | null> {
  const m = OPAQUE_RE.exec(key);
  if (m === null) return key;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const r = await mainDb.execute({
    sql: "SELECT alert_key FROM alert WHERE (alert_key LIKE 'tb:%' OR alert_key LIKE 'proxy:%') AND detected_at >= ?",
    args: [since],
  });
  for (const x of r.rows) {
    const stored = String(x.alert_key);
    if (publicAlertKey(stored) === key) return stored;
  }
  return null;
}

/**
 * Returns a masked copy of the inbox rows. Anything that cannot be lettered becomes "Another stock";
 * a row is never returned with its code, its code-bearing key or an unmasked text.
 */
export async function maskAlertViews(
  mainDb: Pick<Client, "execute">,
  alerts: readonly AlertView[],
): Promise<AlertView[]> {
  const markets = [...new Set(alerts.map((a) => a.market))];
  const dates = alerts
    .map((a) => melbourneDate(a.detectedAt))
    .filter((d): d is string => d !== null)
    .sort();
  const sets = new Map<string, Set<string>>(); // `${market}|${d}` -> codes
  const lookups = new Map<string, MaskLookup>();
  for (const market of markets) {
    lookups.set(market, await loadMaskLookup(mainDb, market));
    if (dates.length === 0) continue;
    const lo = dates[0]!;
    const hi = dates[dates.length - 1]!;
    for (const part of [await activeCodesByDate(mainDb, market, lo, hi)]) {
      for (const [d, codes] of part) {
        const k = `${market}|${d}`;
        const s = sets.get(k) ?? new Set<string>();
        for (const c of codes) s.add(c);
        sets.set(k, s);
      }
    }
  }
  const aliasCache = new Map<string, StockAliases>();
  const aliasFor = (a: AlertView): StockAliases => {
    const d = melbourneDate(a.detectedAt) ?? "";
    const k = `${a.market}|${d}`;
    let al = aliasCache.get(k);
    if (!al) {
      // The row's own code is in its date's set by construction; adding it here only guards a failed lookup.
      al = new StockAliases([...(sets.get(k) ?? []), ...(a.code !== null ? [a.code] : [])]);
      aliasCache.set(k, al);
    }
    return al;
  };
  return alerts.map((a) => {
    const aliases = aliasFor(a);
    const lookup = lookups.get(a.market)!;
    return {
      ...a,
      key: publicAlertKey(a.key),
      code: a.code === null ? null : aliases.label(a.code),
      text: maskText(a.text, aliases, lookup),
      why: maskText(a.why, aliases, lookup),
      executions: a.executions.map((e) => ({ ...e, label: maskText(e.label, aliases, lookup) })),
    };
  });
}
