// Synthetic data for the T4 tests (SEC-110: invented codes ZZA..ZZC, invented numbers, no vendor
// data). Deterministic: a tiny LCG, never Math.random.
import type { Client } from "@libsql/client";

export type Bar = { code: string; d: string; o: number; h: number; l: number; c: number; volume: number };

/** Weekdays of a month (the synthetic calendar has no holidays). */
export function weekdays(month: string): string[] {
  const out: string[] = [];
  for (let n = 1; n <= 31; n++) {
    const d = `${month}-${String(n).padStart(2, "0")}`;
    const t = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) break;
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(d);
  }
  return out;
}

/** One bar on the 0.005 tick grid around `close`. */
export function bar(code: string, d: string, close: number, volume: number): Bar {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return { code, d, o: r(close), h: r(close + 0.01), l: r(close - 0.01), c: r(close), volume };
}

/** A flat-ish series of closes for `dates` (deterministic wiggle of whole ticks). */
export function series(code: string, dates: string[], start: number, volume: number): Bar[] {
  let seed = 12345;
  let c = start;
  return dates.map((d) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    c = Math.round((c + ((seed >> 8) % 3 === 0 ? 0.01 : 0)) * 100) / 100;
    return bar(code, d, c, volume);
  });
}

/** Seed a confirmed (auto_confirmed) corporate action with its factor. */
export async function seedAction(
  db: Client,
  a: { id: number; code: string; type: string; exDate: string; factor: number; payload?: object },
): Promise<void> {
  await db.batch(
    [
      {
        sql: "INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json) VALUES (?, 'AU', ?, ?, ?, ?)",
        args: [a.id, a.code, a.type, a.exDate, JSON.stringify(a.payload ?? {})],
      },
      {
        sql: "INSERT INTO corporate_action_event (action_id, at, status, by) VALUES (?, '2026-09-20T00:00:00.000Z', 'auto_confirmed', 'system')",
        args: [a.id],
      },
      {
        sql: "INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at) VALUES ('AU', ?, ?, ?, ?, '2026-09-20T00:00:00.000Z')",
        args: [a.code, a.exDate, a.factor, a.id],
      },
    ],
    "write",
  );
}

/** Accept the vendor (O-26) for the tests that exercise the open gate. */
export async function acceptYahoo(db: Client): Promise<void> {
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_eod'");
}
