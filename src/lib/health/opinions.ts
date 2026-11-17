// System Health: the opinion meters (M22 C4; AGT-148, CTX-060; D-1427, D-1520). Owner only, plain words. One line per kind
// with a forward meter, and a line for the kinds that have none. Read-only: it reads the meters and the request table;
// nothing here can change a card, an order, a size, a breaker or a rule (PRD-033). The line is wired into the health page by
// task Z; this module only builds it. A kind that has earned a review is an attention line.
import { getConfig } from "@/lib/config/store";
import { num, str, type Exec } from "@/lib/cortex/store/common";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { loadMeters, NO_METER, type Meter, type MeterKind } from "@/lib/opinions/meter";
import { viewOf } from "@/lib/opinions/view";

export type OpinionsHealth = {
  /** "attention" when a kind has earned a review, or the rows cannot be read. */
  state: "ok" | "attention";
  lines: string[];
};

/** Pure: the lines from the meters and the kinds whose request is on file. */
export function opinionsHealthOf(
  meters: readonly Meter[],
  requested: ReadonlySet<MeterKind>,
): OpinionsHealth {
  const lines: string[] = [];
  let attention = false;
  for (const m of meters) {
    const v = viewOf(m, requested.has(m.kind));
    if (v.earned !== null) {
      attention = true;
      lines.push(`${v.label}: ${v.earned}`);
    } else {
      lines.push(`${v.label}: ${v.progress}${v.missing === null ? "" : `. ${v.missing}`}`);
    }
  }
  for (const n of NO_METER) lines.push(`${n.label}: no forward meter. ${n.reason}`);
  return { state: attention ? "attention" : "ok", lines };
}

/** The kinds of a market that have a request on file. */
export async function loadRequested(db: Exec, market: string): Promise<Set<MeterKind>> {
  // rows-ok: opinion_promotion_request primary key (market, kind), at most two rows
  const r = await db.execute({
    sql: "SELECT kind FROM opinion_promotion_request WHERE market = ? LIMIT 2",
    args: [market],
  });
  return new Set(r.rows.map((x) => str(x.kind) as MeterKind));
}

/** Reads the meters; a failed read is an attention line, never a throw. */
export async function loadOpinionsHealth(
  db: Exec,
  market: string = HOME_MARKET,
): Promise<OpinionsHealth> {
  try {
    const minN = num(await getConfig(db, "opinion_min_n"));
    const meters = await loadMeters(db, market, minN);
    return opinionsHealthOf(meters, await loadRequested(db, market));
  } catch {
    return { state: "attention", lines: ["Opinions: the meters could not be read."] };
  }
}
