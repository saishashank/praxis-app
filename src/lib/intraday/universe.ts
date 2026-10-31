// M17 WP5: the scan universe (DAT-239): tiers U1 and U2 of the latest universe snapshot, then
// watch-listed and held codes, capped at `intraday_scan_codes_max`. The scan never adds a code.
// Order is priority order: tier 1, tier 2, watch, held. Read only.
import type { Exec } from "@/lib/cortex/store/common";

export type ScanCodeKind = "U1" | "U2" | "watch" | "held";
export type ScanCode = {
  code: string;
  kind: ScanCodeKind;
  /** Snapshot facts (null when the code is only watch-listed or held and absent from the snapshot). */
  halted: boolean | null;
  adv: number | null;
};

const RANK: Record<ScanCodeKind, number> = { U1: 0, U2: 1, watch: 2, held: 3 };

export async function heldCodes(db: Exec, market: string): Promise<Set<string>> {
  void market; // book positions carry no market column; the arena is AU-only in V2
  const r = await db.execute(
    "SELECT DISTINCT code FROM nav_daily_pos WHERE d = (SELECT MAX(d) FROM nav_daily_pos) AND qty > 0",
  );
  return new Set(r.rows.map((x) => String(x.code)));
}

export async function scanUniverse(
  db: Exec,
  market: string,
  d: string,
  codesMax: number,
): Promise<ScanCode[]> {
  if (codesMax <= 0) return [];
  const out = new Map<string, ScanCode>();
  const put = (c: ScanCode): void => {
    const have = out.get(c.code);
    if (have === undefined || RANK[c.kind] < RANK[have.kind]) out.set(c.code, c);
  };
  const snap = await db.execute({
    sql:
      "SELECT code, tier, halted, adv FROM universe_snapshot WHERE market = ? " +
      "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?) ORDER BY code",
    args: [market, market, d],
  });
  const info = new Map<string, { halted: boolean; adv: number | null }>();
  for (const x of snap.rows) {
    const code = String(x.code);
    const row = { halted: Number(x.halted) === 1, adv: x.adv === null ? null : Number(x.adv) };
    info.set(code, row);
    const tier = String(x.tier);
    if (tier === "U1" || tier === "U2") put({ code, kind: tier, ...row });
  }
  const watch = await db.execute({
    sql:
      "SELECT DISTINCT code FROM watch_list_owner WHERE market = ? AND removed_at IS NULL " +
      "AND expires_d >= ? ORDER BY code",
    args: [market, d],
  });
  for (const x of watch.rows) {
    const code = String(x.code);
    put({
      code,
      kind: "watch",
      halted: info.get(code)?.halted ?? null,
      adv: info.get(code)?.adv ?? null,
    });
  }
  for (const code of [...(await heldCodes(db, market))].sort()) {
    put({
      code,
      kind: "held",
      halted: info.get(code)?.halted ?? null,
      adv: info.get(code)?.adv ?? null,
    });
  }
  return [...out.values()]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .slice(0, codesMax);
}
