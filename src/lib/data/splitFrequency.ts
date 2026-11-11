// How often do splits and consolidations occur in the stored data? (M14 DAT-232, D-236; DAT-252 (3),
// D-974: the figures go into the AT-45 reference.) Read only: SELECTs, nothing is written.
//   - split / consolidation / bonus-issue days per calendar year (corporate_action, ex_date);
//   - the share of codes (with price bars) that have at least one;
//   - the share of N-session windows (default 20, the volume-ratio window) that contain an ex-date.
// Run once against production through the `splitFrequency` scenario of scripts/arena/diagnose.mjs
// (a SELECT-only client) or with scripts/data/split-frequency.mjs. Output: counts and shares only.
import type { Client } from "@libsql/client";

export const QUANTITY_TYPES = ["split", "consolidation", "bonus_issue"];

export type SplitSummary = {
  window: number;
  actions: number;
  perYear: Record<string, number>;
  codesWithBars: number;
  codesWithSplit: number;
  codesWithSplitPct: number;
  windows: number;
  windowsTouched: number;
  windowsTouchedPct: number;
};

type Action = { code: string; exDate: string; type: string };

/**
 * Pure summary. `barDates`: Map<code, string[]> sorted ascending. A window is `window` consecutive bars
 * of one code; it is touched when an ex-date of that code falls within [first bar date, last bar date].
 */
export function summarise(
  actions: readonly Action[],
  barDates: ReadonlyMap<string, readonly string[]>,
  window = 20,
): SplitSummary {
  const quantity = actions.filter((a) => QUANTITY_TYPES.includes(a.type));
  const perYear: Record<string, number> = {};
  for (const a of quantity) {
    const y = a.exDate.slice(0, 4);
    perYear[y] = (perYear[y] ?? 0) + 1;
  }
  const exByCode = new Map<string, string[]>();
  for (const a of quantity) {
    const list = exByCode.get(a.code) ?? [];
    list.push(a.exDate);
    exByCode.set(a.code, list);
  }
  let codesWithBars = 0;
  let codesWithSplit = 0;
  let windows = 0;
  let touched = 0;
  for (const [code, dates] of [...barDates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    codesWithBars++;
    const ex = exByCode.get(code) ?? [];
    if (ex.length > 0) codesWithSplit++;
    for (let i = window - 1; i < dates.length; i++) {
      windows++;
      const from = dates[i - window + 1]!;
      const to = dates[i]!;
      if (ex.some((e) => e >= from && e <= to)) touched++;
    }
  }
  const share = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1e6) / 1e4); // percent, 2 dp
  return {
    window,
    actions: quantity.length,
    perYear,
    codesWithBars,
    codesWithSplit,
    codesWithSplitPct: share(codesWithSplit, codesWithBars),
    windows,
    windowsTouched: touched,
    windowsTouchedPct: share(touched, windows),
  };
}

type Q = Pick<Client, "execute">;

/**
 * Reads the stored data and summarises it.
 * rows-ok: corporate_action holds hundreds of rows; price_bar is read once, about 1.4 million rows
 * (0.3 % of the free plan's monthly reads, PRD-045) - this runs once for the AT-45 reference, never nightly.
 */
export async function measure(db: Q, window = 20): Promise<SplitSummary> {
  const acts = await db.execute(
    `SELECT code, ex_date, type FROM corporate_action WHERE type IN ('split','consolidation','bonus_issue') ORDER BY code, ex_date`,
  );
  const bars = await db.execute(`SELECT code, d FROM price_bar ORDER BY code, d`);
  const barDates = new Map<string, string[]>();
  for (const r of bars.rows) {
    const code = String(r.code);
    const list = barDates.get(code) ?? [];
    list.push(String(r.d));
    barDates.set(code, list);
  }
  return summarise(
    acts.rows.map((r) => ({
      code: String(r.code),
      exDate: String(r.ex_date),
      type: String(r.type),
    })),
    barDates,
    window,
  );
}
