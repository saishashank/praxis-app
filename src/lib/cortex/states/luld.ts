// US limit-up/limit-down pauses, exchange halts and SEC suspensions (M20 A5; DAT-244, CTX-016, D-1110 F). The
// `trading_halt` rows (kind `luld`, `halt`, `suspension`; `halted_at`, `resumed_at` ISO UTC, `resumed_at` null while
// the halt runs) drive the SAME halt machine as AU (`stepHalt`, states/halt.ts) through a `HaltModel`:
//
//   * a `luld` or `halt` row halts the code for every session whose OPEN falls inside [halted_at, resumed_at): the
//     machine then allows no exit fill, marks at the last trade before the halt, and on the first session whose open is
//     outside the window it re-scores at that session's open (the reopen bar: the gap against the pre-halt close
//     exits a position that reopens below the loss budget, `reopenGapExit`). The fill times the engine knows are the
//     session open (entries, close-signal exits); an intraday pause that does not cover the open is not a halted
//     session (a stop level has no known time inside the day, so the pause cannot be placed against it);
//   * a `suspension` row halts the same way AND, on the first session it covers, is the machine's "suspension from
//     quotation" notice, so the code takes the CTX-016 suspension path (declining mark, counted as a loss, outcome).
//
// Pure over the rows and the view; `loadHaltRows` is the one read of `trading_halt`.
import type { Client } from "@libsql/client";
import type { AsOfView } from "../pit/types";
import { localToUtc } from "@/lib/data/calendar";
import type { MarketProfile } from "@/lib/market/profileCore.mjs";
import { haltReader } from "../profileReaders";
import {
  CX16_MODEL,
  cx16Model,
  type HaltModel,
  type HaltNoticeKind,
  type HaltSourceRow,
} from "./halt";

/** One `trading_halt` row (DAT-244). */
export type TradingHaltRow = {
  readonly market: string;
  readonly code: string;
  readonly kind: "luld" | "suspension" | "halt";
  readonly haltedAt: string;
  readonly resumedAt: string | null;
  readonly reason: string | null;
  readonly source: string;
};

const KINDS: readonly string[] = ["luld", "suspension", "halt"];

/** The model's rows are this module's `HaltSourceRow` with kind and instants set. */
export function haltSourceOf(row: TradingHaltRow): HaltSourceRow {
  return { kind: row.kind, haltedAt: row.haltedAt, resumedAt: row.resumedAt };
}

/** True when the instant lies in [haltedAt, resumedAt) of the row (resumedAt null = still halted). */
export function haltCoversInstant(row: HaltSourceRow, instantUtc: string): boolean {
  if (row.haltedAt === undefined) return false;
  const at = Date.parse(instantUtc);
  if (Date.parse(row.haltedAt) > at) return false;
  return row.resumedAt === null || row.resumedAt === undefined || at < Date.parse(row.resumedAt);
}

export type LuldModelOptions = {
  /** The UTC instant (ISO) the regular session of date `d` opens (the profile's open in the market zone). */
  readonly sessionOpenUtc: (d: string) => string;
};

/** The US model (`us_luld`): halted sessions and suspension notices from `trading_halt` rows. */
export function luldModel(opts: LuldModelOptions): HaltModel {
  const coveredAt = (rows: readonly HaltSourceRow[], d: string): readonly HaltSourceRow[] => {
    const open = opts.sessionOpenUtc(d);
    return rows.filter((r) => haltCoversInstant(r, open));
  };
  return {
    id: "us_luld",
    noticeKind(row): HaltNoticeKind | null {
      if (row.kind === "suspension") return "suspension";
      if (row.kind === "luld" || row.kind === "halt") return "halt";
      return null;
    },
    viewFor(view: AsOfView, code: string, rows: readonly HaltSourceRow[]): AsOfView {
      const rowHalted = (t: number): boolean => coveredAt(rows, view.sessions[t]!).length > 0;
      return {
        ...view,
        halted(c: string, t: number): boolean | null {
          if (c === code && rowHalted(t)) return true;
          const base = view.halted(c, t);
          if (base !== null || c !== code) return base;
          // the halt rows are complete for the code: a session with a bar and no covering row traded
          const b = view.bars(c, t, 1)[0];
          return b !== undefined && b.d === view.sessions[t] ? false : null;
        },
        haltSince(c: string, t: number): string | null {
          const base = view.haltSince(c, t);
          if (c !== code || !rowHalted(t)) return base;
          let i = t;
          while (i > 0 && rowHalted(i - 1)) i -= 1;
          const fromRows = view.sessions[i]!;
          return base !== null && base < fromRows ? base : fromRows;
        },
      };
    },
    notices(view, _code, rows) {
      // the first session a suspension row covers is its notice
      const out = new Map<string, HaltNoticeKind>();
      for (const r of rows) {
        if (r.kind !== "suspension") continue;
        for (const d of view.sessions) {
          if (haltCoversInstant(r, opts.sessionOpenUtc(d))) {
            if (!out.has(d)) out.set(d, "suspension");
            break;
          }
        }
      }
      return out;
    },
  };
}

/** Rows of a code whose halt could touch the window [fromUtc, toUtc]: started by `toUtc`, not resumed before `fromUtc`. */
export async function loadHaltRows(
  db: Pick<Client, "execute">,
  market: string,
  code: string,
  fromUtc: string,
  toUtc: string,
): Promise<TradingHaltRow[]> {
  const r = await db.execute({
    // rows-ok: a code has a handful of halts in a window; index (market, code, halted_at), no paging needed
    sql: `SELECT market, code, kind, halted_at, resumed_at, reason, source FROM trading_halt
          WHERE market = ? AND code = ? AND halted_at <= ? AND (resumed_at IS NULL OR resumed_at >= ?)
          ORDER BY halted_at, id`,
    args: [market, code, toUtc, fromUtc],
  });
  return r.rows.map((x) => {
    const kind = String(x.kind);
    if (!KINDS.includes(kind)) throw new RangeError(`unknown trading_halt kind ${kind}`);
    return {
      market: String(x.market),
      code: String(x.code),
      kind: kind as TradingHaltRow["kind"],
      haltedAt: String(x.halted_at),
      resumedAt: x.resumed_at === null ? null : String(x.resumed_at),
      reason: x.reason === null ? null : String(x.reason),
      source: String(x.source),
    };
  });
}

/**
 * The value for `FillOrderEnv.halted` of a fill at `instantUtc` (arena/fills.ts): true when a halt row of the code
 * covers that instant. A close-signal exit and an entry fill at the session open pass the open instant.
 */
export function haltedAtInstant(rows: readonly HaltSourceRow[], instantUtc: string): boolean {
  return rows.some((r) => haltCoversInstant(r, instantUtc));
}

/**
 * The halt model a profile's `halt_model` field selects (the reader of profileReaders): the home `cx16` model, India's
 * `in_bands` (bands lock fills, `bands.ts`; a trading suspension notice runs the same machine), or the US `luld`
 * model with the profile's session open as the instant a fill happens.
 */
export function haltModelFor(profile: MarketProfile): HaltModel {
  const reader = haltReader(profile);
  if (reader === "us_luld") {
    const open = profile.sessionOpen;
    const tz = profile.tz;
    if (open === null || tz === null)
      throw new RangeError("the profile has no session open or zone");
    return luldModel({ sessionOpenUtc: (d) => localToUtc(d, open, tz).toISOString() });
  }
  return reader === "cx16" ? CX16_MODEL : cx16Model(reader);
}
