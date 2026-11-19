// System Health: the small local reader that double-checks announcement categories (M22 L5, LLM-079, D-1416). Owner only,
// plain words, no model or file name. Read-only: it reads the switch and the shadow's own rows; nothing here is read by a
// decision. Lines:
//   "Small reader: off"
//   "Small reader: on, nothing compared yet"
//   "Small reader: on, agreed with the written rules on 37 of 40 announcements (93 %) on Tue 2 Dec"
//   "Small reader: on but cannot run (the local classifier has not been trained yet)"
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import lockJson from "@/lib/llm/minilm/model.lock.json";
import { readinessProblem, type Head, type MinilmLock } from "@/lib/llm/minilm/head";
import headJson from "@/lib/llm/minilm/head.weights.json";
import { agreementOf, type Agreement } from "@/lib/llm/minilm/shadow";

export type MinilmHealth = {
  /** "attention" when it is switched on but cannot run. */
  state: "ok" | "attention";
  line: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Tue 2 Dec" from a YYYY-MM-DD date (a calendar label, no zone involved). */
export function dayLabel(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

/** Pure: the line from the switch, the readiness problem (null when it can run) and the latest night's figure. */
export function minilmHealthOf(x: {
  enabled: boolean;
  problem: string | null;
  latest: { d: string; agreement: Agreement } | null;
}): MinilmHealth {
  if (!x.enabled) return { state: "ok", line: "Small reader: off" };
  if (x.problem !== null)
    return {
      state: "attention",
      line: `Small reader: on but cannot run (${x.problem.charAt(0).toLowerCase()}${x.problem.slice(1)})`,
    };
  if (x.latest === null || x.latest.agreement.rows === 0)
    return { state: "ok", line: "Small reader: on, nothing compared yet" };
  const a = x.latest.agreement;
  const pct = Math.round((100 * a.agree) / a.rows);
  const n = a.rows === 1 ? "announcement" : "announcements";
  return {
    state: "ok",
    line: `Small reader: on, agreed with the written rules on ${a.agree} of ${a.rows} ${n} (${pct} %) on ${dayLabel(x.latest.d)}`,
  };
}

/** Reads the switch and the latest night; a failed read is an attention line, never a throw. */
export async function loadMinilmHealth(db: Pick<Client, "execute">): Promise<MinilmHealth> {
  try {
    const enabled = (await getConfig(db, "minilm_enabled")) === "on";
    const problem = readinessProblem(
      headJson as unknown as Head,
      lockJson as unknown as MinilmLock,
    );
    let latest: { d: string; agreement: Agreement } | null = null;
    if (enabled) {
      // rows-ok: minilm_shadow primary key (market, d, ...) prefix, newest day first, LIMIT 1
      const r = await db.execute({
        sql: "SELECT d FROM minilm_shadow WHERE market = ? ORDER BY d DESC LIMIT 1",
        args: [HOME_MARKET],
      });
      const d = r.rows[0] ? String(r.rows[0].d) : null;
      if (d !== null) latest = { d, agreement: await agreementOf(db, HOME_MARKET, d) };
    }
    return minilmHealthOf({ enabled, problem, latest });
  } catch {
    return { state: "attention", line: "Small reader: its state could not be read" };
  }
}
