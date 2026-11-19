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

/**
 * Codes the site shows a delayed price for outside the book (display only, ARN-021): the stocks the
 * practice portfolios hold now (`pick_portfolio_hold` is rewritten each run, so these are the latest
 * holdings), then the users' Home watchlist codes (`user_watchlist` lives in the auth database, so it
 * is read from `auth`; without it only the held codes are returned). Held first so a per-poll cap drops
 * watchlist codes before held ones. Bounded reads, no OFFSET (Turso free quota).
 */
export async function displayHeldCodes(
  db: Exec,
  market: string,
  auth?: Exec,
): Promise<{ held: string[]; watchlist: string[] }> {
  const held = await db.execute({
    sql: "SELECT DISTINCT code FROM pick_portfolio_hold WHERE market = ? ORDER BY code LIMIT 400",
    args: [market],
  });
  const wl = !auth
    ? { rows: [] as Record<string, unknown>[] }
    : await auth.execute({
        sql: "SELECT DISTINCT code FROM user_watchlist WHERE market = ? ORDER BY code LIMIT 400",
        args: [market],
      });
  const h = held.rows.map((x) => String(x.code));
  const seen = new Set(h);
  return { held: h, watchlist: wl.rows.map((x) => String(x.code)).filter((c) => !seen.has(c)) };
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

/**
 * M22 E5 (AGT-147, D-1443): the codes of tiers U1 then U2 of the latest snapshot, not halted, at most `limit` of them, in
 * priority order (tier, then code). Read only; the scan universe above is not changed by it.
 */
export async function tierCodes(
  db: Exec,
  market: string,
  d: string,
  limit: number,
): Promise<ScanCode[]> {
  if (limit <= 0) return [];
  // rows-ok: universe_snapshot primary key (market, d, ...) newest snapshot, tiers U1 and U2 only, LIMIT = the sweep's capacity
  const r = await db.execute({
    sql:
      "SELECT code, tier, halted, adv FROM universe_snapshot WHERE market = ? AND tier IN ('U1', 'U2') AND halted = 0 " +
      "AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?) ORDER BY tier, code LIMIT ?",
    args: [market, market, d, limit],
  });
  return r.rows.map((x) => ({
    code: String(x.code),
    kind: String(x.tier) as "U1" | "U2",
    halted: false,
    adv: x.adv === null ? null : Number(x.adv),
  }));
}
