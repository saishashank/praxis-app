// D-913 "Follow the picks" portfolio on the Picks page: what trading exactly the published picks would
// have done with the practice money. Reads the stored rows of src/lib/picks/portfolioStore.ts (the
// newest value, the start, the open holdings at their latest price, the closed trades' tally). A masked
// viewer sees the letter of each stock and percentages only, no amounts or prices (DAT-124).
import "server-only";
import { newerThanClose, readLatestQuotes } from "@/lib/data/quotes/latest";
import { PORTFOLIO_PROFILE } from "@/lib/picks/portfolioStore";
import { getConfig } from "@/lib/config/store";
import { soft } from "./common";
import { maskKitByDate, money, priceMicro, type LoaderEnv, type MoneyView } from "./shell";

const PPM = 1_000_000n; // threshold-ok: parts per million
const SLOTS_DEFAULT = 5; // threshold-ok: D-913 default, used only if the read fails
const SEED_AUD_DEFAULT = 5000; // threshold-ok: D-913 default, used only if the read fails
const SERIES_DAYS = 120; // threshold-ok: values read for the sparkline (bounded)

export type PortfolioHolding = {
  stock: string;
  entryD: string | null;
  entry: MoneyView | null;
  now: MoneyView | null;
  /** Price change since the buy, ppm. */
  changePpm: number | null;
};

export type PortfolioView = {
  masked: boolean;
  profile: string;
  /** False before the first pick. */
  started: boolean;
  /** Most stocks held at once (config). */
  slots: number;
  /** The newest valued session; null before the first pick or for a masked viewer. */
  asOfD: string | null;
  seed: MoneyView | null;
  value: MoneyView | null;
  cash: MoneyView | null;
  sinceStartPpm: number | null;
  holdings: PortfolioHolding[];
  closed: number;
  wins: number;
  /** Value since the start per session, ppm, oldest first. */
  series: number[];
};

const ppm = (num: bigint, den: bigint): number | null =>
  den > 0n ? Number((num * PPM) / den) : null; // money-float-ok: ppm of exact micro amounts

export async function loadPickPortfolio(env: LoaderEnv): Promise<PortfolioView> {
  const market = env.market;
  const masked = env.mask.masked;
  const profile = PORTFOLIO_PROFILE;
  const empty: PortfolioView = {
    masked,
    profile,
    started: false,
    slots: SLOTS_DEFAULT,
    asOfD: null,
    seed: null,
    value: null,
    cash: null,
    sinceStartPpm: null,
    holdings: [],
    closed: 0,
    wins: 0,
    series: [],
  };
  const days = await soft(
    async () =>
      (
        await env.main.execute({
          sql: `SELECT d, cash_micro, value_micro FROM pick_portfolio_day
                WHERE market = ? AND profile = ? ORDER BY d DESC LIMIT ?`,
          args: [market, profile, SERIES_DAYS],
        })
      ).rows,
    [],
  );
  const slots = await soft(async () => {
    const v = await getConfig(env.main, "picks_portfolio_slots");
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : SLOTS_DEFAULT;
  }, SLOTS_DEFAULT);
  if (days.length === 0) return { ...empty, slots };
  const newest = days[0]!;
  const seedAud = await soft(async () => {
    const v = await getConfig(env.main, "picks_portfolio_seed_aud");
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : SEED_AUD_DEFAULT;
  }, SEED_AUD_DEFAULT);
  const seed = BigInt(seedAud) * PPM;
  const valueNow = BigInt(String(newest.value_micro));
  const trades = await env.main.execute({
    sql: `SELECT pub_d, code, entry_d, entry_micro, exit_d, net_micro FROM pick_portfolio_trade
          WHERE market = ? AND profile = ? ORDER BY entry_d DESC, pub_d DESC, rank LIMIT ?`,
    args: [market, profile, 500], // threshold-ok: bounded trade read
  });
  const open = trades.rows.filter((t) => t.exit_d === null);
  const closedRows = trades.rows.filter((t) => t.exit_d !== null);
  const codes = [...new Set(open.map((t) => String(t.code)))];
  const nowOf = new Map<string, bigint>();
  if (codes.length > 0) {
    const closes = await soft(
      async () =>
        (
          await env.main.execute({
            sql: `SELECT pb.code, pb.d, pb.c FROM price_bar pb
                  WHERE pb.market = ? AND pb.code IN (${codes.map(() => "?").join(", ")})
                    AND pb.d = (SELECT MAX(x.d) FROM price_bar x WHERE x.market = pb.market AND x.code = pb.code)`,
            args: [market, ...codes],
          })
        ).rows,
      [],
    );
    const closeD = new Map<string, string>();
    for (const c of closes) {
      nowOf.set(String(c.code), BigInt(priceMicro(Number(c.c)))); // money-float-ok: stored REAL bar price
      closeD.set(String(c.code), String(c.d));
    }
    const quotes = await soft(() => readLatestQuotes(env.main, market, codes), new Map());
    for (const code of codes) {
      const live = newerThanClose(quotes.get(code), closeD.get(code) ?? null);
      if (live) nowOf.set(code, live.lastMicro);
    }
  }
  const kit = masked
    ? await maskKitByDate(
        env,
        open.map((t) => ({ d: String(t.pub_d), code: String(t.code) })),
      )
    : null;
  const holdings: PortfolioHolding[] = open.map((t) => {
    const code = String(t.code);
    const entry = BigInt(String(t.entry_micro));
    const now = nowOf.get(code) ?? null;
    return {
      stock: kit ? kit.aliasOf(String(t.pub_d)).label(code) : code,
      entryD: masked ? null : String(t.entry_d),
      entry: masked ? null : money(entry.toString(), env.currency),
      now: masked || now === null ? null : money(now.toString(), env.currency),
      changePpm: now === null ? null : ppm(now - entry, entry),
    };
  });
  const series = [...days]
    .reverse()
    .map((x) => ppm(BigInt(String(x.value_micro)) - seed, seed) ?? 0);
  return {
    masked,
    profile,
    started: true,
    slots,
    asOfD: masked ? null : String(newest.d),
    seed: masked ? null : money(seed.toString(), env.currency),
    value: masked ? null : money(valueNow.toString(), env.currency),
    cash: masked ? null : money(String(newest.cash_micro), env.currency),
    sinceStartPpm: ppm(valueNow - seed, seed),
    holdings,
    closed: closedRows.length,
    wins: closedRows.filter((t) => BigInt(String(t.net_micro)) > 0n).length,
    series,
  };
}
