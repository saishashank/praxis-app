// Movers check (D-886, Owner 2026-11-04: "at the end of the day, why haven't we picked the top 20
// movers, and have we stopped the top 20 losers"). For the session's 20 biggest rises and 20 biggest
// falls, exactly as the Market tab lists them (loadMarket, same filters), it says per company what
// the six strategies did:
//   rises: held during the rise, or an idea the evening before that was not bought (with the plain
//          reasons), or not followed (outside the traded universe), or followed with no rule matched;
//   falls: held during the fall (sold by the stop that day, or still held with the stop in force), or
//          avoided (not held; an idea that was not bought says why).
// Computed from the stored nightly data when the page opens; nothing is written. Codes and names
// would reveal the companies, so a masked viewer gets `hidden` and no rows (DAT-124).
import "server-only";
import { notTakenText } from "./cardParts";
import { strategyNames, strOrNull } from "./common";
import { loadMarket, parseMarketQuery, type MarketRow } from "./market";
import { marketOf, type LoaderEnv } from "./shell";

const TOP_N = 20; // threshold-ok: D-886 the Owner's "top 20"

export type MoverVerdict =
  | "held"
  | "idea_not_bought"
  | "not_followed"
  | "no_rule"
  | "sold_by_stop"
  | "held_in_fall"
  | "avoided";

export type MoverRow = {
  code: string;
  name: string | null;
  changePpm: number;
  verdict: MoverVerdict;
  /** One plain sentence: what happened and why. */
  text: string;
  /** Strategy names involved (holders, or the strategies that had the idea). */
  strategies: string[];
};

export type MoversCheck = {
  hidden: boolean;
  /** The session of the moves; null when no prices are stored. */
  d: string | null;
  /** The session before (when the strategies decided what to hold during `d`). */
  prev: string | null;
  rises: MoverRow[];
  falls: MoverRow[];
  /** Counts for the summary line. */
  summary: { risesHeld: number; fallsHeld: number; fallsSold: number };
};

const EMPTY: MoversCheck = {
  hidden: false,
  d: null,
  prev: null,
  rises: [],
  falls: [],
  summary: { risesHeld: 0, fallsHeld: 0, fallsSold: 0 },
};

const str = (v: unknown): string => String(v);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");
/** Appends `v` to the list of `k`. */
function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** The top rises and falls of the latest session, two pages of the Market lists (10 a page). */
async function topMovers(
  env: LoaderEnv,
): Promise<{ d: string | null; up: MarketRow[]; down: MarketRow[] }> {
  const q = parseMarketQuery(new URLSearchParams())!;
  const first = await loadMarket(env, q);
  if (first.d === null) return { d: null, up: [], down: [] };
  // both pages read the same stored session (nothing is written between the two reads)
  const second = await loadMarket(env, { ...q, upPage: 2, downPage: 2 });
  return {
    d: first.d,
    up: [...first.up.rows, ...second.up.rows].slice(0, TOP_N),
    down: [...first.down.rows, ...second.down.rows].slice(0, TOP_N),
  };
}

export type MoverContext = {
  /** The session of the moves. */
  d: string;
  /** Trades of the six strategies open during `d`, by code. */
  holds: ReadonlyMap<
    string,
    ReadonlyArray<{ family: string; exitD: string | null; exitType: string | null }>
  >;
  /** Ideas (signals) of the evening before, by code, with the card outcome. */
  ideas: ReadonlyMap<
    string,
    ReadonlyArray<{ family: string; taken: boolean; reason: string | null }>
  >;
  /** Universe status of the evening before, by code ("active", "below_floor", ...). */
  followed: ReadonlyMap<string, string>;
  nameOf: (family: unknown) => string;
};

const reasonsOf = (ctx: MoverContext, code: string): string[] => [
  ...new Set(
    (ctx.ideas.get(code) ?? [])
      .filter((i) => !i.taken)
      .map((i) => notTakenText(i.reason ?? "reason not recorded")),
  ),
];
const ideaFamilies = (ctx: MoverContext, code: string): string[] => [
  ...new Set((ctx.ideas.get(code) ?? []).map((i) => ctx.nameOf(i.family))),
];

/** D-886: what the strategies did with one of the top rises of session `ctx.d`. */
export function riseRow(
  ctx: MoverContext,
  r: Pick<MarketRow, "stock" | "name" | "changePpm">,
): MoverRow {
  const code = r.stock;
  const base = { code, name: r.name, changePpm: r.changePpm };
  const h = ctx.holds.get(code) ?? [];
  if (h.length > 0) {
    const who = [...new Set(h.map((x) => ctx.nameOf(x.family)))];
    return {
      ...base,
      verdict: "held",
      strategies: who,
      text: `Held during the rise by ${who.join(", ")}.`,
    };
  }
  const reasons = reasonsOf(ctx, code);
  if (reasons.length > 0) {
    return {
      ...base,
      verdict: "idea_not_bought",
      strategies: ideaFamilies(ctx, code),
      text: `An idea the evening before, not bought: ${reasons.join("; ")}.`,
    };
  }
  const status = ctx.followed.get(code);
  if (status !== "active") {
    return {
      ...base,
      verdict: "not_followed",
      strategies: [],
      text:
        status === "below_floor"
          ? "Not followed: too small or too thinly traded for the strategies."
          : "Not followed: outside the companies the strategies trade.",
    };
  }
  return {
    ...base,
    verdict: "no_rule",
    strategies: [],
    text: "Followed, but no strategy's buy rule matched it the evening before.",
  };
}

/** D-886: what the strategies did with one of the top falls of session `ctx.d`. */
export function fallRow(
  ctx: MoverContext,
  r: Pick<MarketRow, "stock" | "name" | "changePpm">,
): MoverRow {
  const code = r.stock;
  const base = { code, name: r.name, changePpm: r.changePpm };
  const h = ctx.holds.get(code) ?? [];
  if (h.length > 0) {
    const who = [...new Set(h.map((x) => ctx.nameOf(x.family)))];
    const soldThatDay = h.filter((x) => x.exitD === ctx.d);
    if (soldThatDay.length === h.length) {
      return {
        ...base,
        verdict: "sold_by_stop",
        strategies: who,
        text: `Held by ${who.join(", ")} and sold that day${soldThatDay.some((x) => x.exitType === "IS") ? " by the stop loss" : ""}.`,
      };
    }
    return {
      ...base,
      verdict: "held_in_fall",
      strategies: who,
      text: `Held during the fall by ${who.join(", ")}; the stop loss stays in force.`,
    };
  }
  const reasons = reasonsOf(ctx, code);
  return {
    ...base,
    verdict: "avoided",
    strategies: reasons.length > 0 ? ideaFamilies(ctx, code) : [],
    text:
      reasons.length > 0
        ? `Avoided: an idea the evening before, not bought (${reasons.join("; ")}).`
        : "Avoided: no strategy held it.",
  };
}

export async function loadMoversCheck(env: LoaderEnv): Promise<MoversCheck> {
  if (env.mask.masked) return { ...EMPTY, hidden: true };
  const market = marketOf(env);
  const { d, up, down } = await topMovers(env);
  if (d === null) return EMPTY;
  const codes = [...new Set([...up, ...down].map((r) => r.stock))];
  if (codes.length === 0) return { ...EMPTY, d };

  const pr = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ? AND d < ?",
    args: [market, d],
  });
  const prev = strOrNull(pr.rows[0]?.d);
  const names = await strategyNames(env.main);
  const nameOf = (family: unknown): string => names[str(family)]?.name ?? str(family);

  // Trades of the six strategies (main executions, current and past rounds, no controls) that were
  // open at some point of session d: bought on or before d, not sold before d.
  const held = await env.main.execute({
    sql: `SELECT t.code, e.family, xf.d AS exit_d, t.exit_type
          FROM trade t JOIN fill ef ON ef.id = t.entry_fill_id
          LEFT JOIN fill xf ON xf.id = t.exit_fill_id
          JOIN cohort c ON c.id = t.cohort_id AND c.control_idx IS NULL
          JOIN execution e ON e.id = c.execution_id AND e.kind = 'E' AND e.variant = 'U'
          WHERE e.market = ? AND ef.d <= ? AND (xf.d IS NULL OR xf.d >= ?)
            AND t.code IN (${placeholders(codes.length)})`,
    args: [market, d, d, ...codes],
  });
  const holds = new Map<
    string,
    Array<{ family: string; exitD: string | null; exitType: string | null }>
  >();
  for (const r of held.rows) {
    pushTo(holds, str(r.code), {
      family: str(r.family),
      exitD: strOrNull(r.exit_d),
      exitType: strOrNull(r.exit_type),
    });
  }

  // The evening before: the ideas (signals) and why each was or was not bought.
  const ideas = new Map<string, Array<{ family: string; taken: boolean; reason: string | null }>>();
  if (prev !== null) {
    const sg = await env.main.execute({
      sql: `SELECT s.code, s.family, c.taken, c.not_taken_reason
            FROM signal s LEFT JOIN decision_card c ON c.signal_id = s.id
            WHERE s.market = ? AND s.d = ? AND s.code IN (${placeholders(codes.length)})`,
      args: [market, prev, ...codes],
    });
    for (const r of sg.rows) {
      pushTo(ideas, str(r.code), {
        family: str(r.family),
        taken: Number(r.taken) === 1,
        reason: strOrNull(r.not_taken_reason),
      });
    }
  }

  // Whether the strategies followed the company at all (the traded universe of that evening).
  const followed = new Map<string, string>();
  if (prev !== null) {
    const us = await env.main.execute({
      sql: `SELECT code, status FROM universe_snapshot
            WHERE market = ? AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
              AND code IN (${placeholders(codes.length)})`,
      args: [market, market, prev, ...codes],
    });
    for (const r of us.rows) followed.set(str(r.code), str(r.status));
  }

  const ctx: MoverContext = { d, holds, ideas, followed, nameOf };
  const rises = up.map((r) => riseRow(ctx, r));
  const falls = down.map((r) => fallRow(ctx, r));
  return {
    hidden: false,
    d,
    prev,
    rises,
    falls,
    summary: {
      risesHeld: rises.filter((x) => x.verdict === "held").length,
      fallsHeld: falls.filter((x) => x.verdict === "held_in_fall").length,
      fallsSold: falls.filter((x) => x.verdict === "sold_by_stop").length,
    },
  };
}
