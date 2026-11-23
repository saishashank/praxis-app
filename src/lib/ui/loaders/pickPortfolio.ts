// D-950 "My portfolio" on Home and the Picks page: the three practice portfolios side by side, one per
// risk profile. Reads the stored rows of src/lib/picks/portfolioStore.ts in a few queries for all three
// (the newest value, the worst fall, the open holdings at their latest price, the newest split, the
// closed tally and the latest trades). A masked viewer sees the letter of each stock and percentages
// only, no amounts, prices or dates (DAT-124).
import "server-only";
import {
  LATEST_READ_MAX,
  newerThanClose,
  quoteTimeMelbourne,
  readLatestQuotes,
} from "@/lib/data/quotes/latest";
import { STRATEGIES, type StrategyKey } from "@/lib/picks/allocation";
import { loadPortfolioSettings, MY_PROFILES } from "@/lib/picks/portfolioConfig";
import { splitLine, strategyNames } from "@/lib/picks/portfolioWords";
import { familyNames } from "@/lib/review/names";
import { soft } from "./common";
import { maskKitByDate, money, priceMicro, type LoaderEnv, type MoneyView } from "./shell";

const PPM = 1_000_000n; // threshold-ok: parts per million
const RECENT_TRADES = 3; // threshold-ok: latest trades shown per portfolio

export type MyHolding = {
  stock: string;
  /** Full company name; null for a masked viewer or when no name is stored. */
  company: string | null;
  strategy: string;
  entryD: string | null;
  entry: MoneyView | null;
  now: MoneyView | null;
  /** Price change since the buy, ppm. */
  changePpm: number | null;
};

export type MyTrade = { d: string | null; stock: string; company: string | null; words: string };

export type MyPortfolio = {
  profile: string;
  /** False before the first pick. */
  started: boolean;
  /** Most stocks held at once (config). */
  holdingsMax: number;
  /** The newest valued session; null before the first pick or for a masked viewer. */
  asOfD: string | null;
  seed: MoneyView | null;
  /** Live value (cash plus holdings at delayed quotes) when a holding has a newer quote, else the close value. */
  value: MoneyView | null;
  cash: MoneyView | null;
  /** Value minus the seed. */
  gain: MoneyView | null;
  sinceStartPpm: number | null;
  /** "Delayed, 13:05" when value, gain and sinceStartPpm are live; null when they are end of day. */
  liveLabel: string | null;
  /** The stored end-of-day value and since-start, kept beside live figures; null when not live. */
  closeValue: MoneyView | null;
  closeSinceStartPpm: number | null;
  /** The largest fall from a peak so far, ppm (0 or below). */
  worstFallPpm: number | null;
  holdings: MyHolding[];
  /** "Follow the trend 35%, Nightly shortlist 25%, cash 40%"; null before the first split. */
  split: string | null;
  /** Why the split last changed. */
  splitWhy: string | null;
  trades: MyTrade[];
  closed: number;
  wins: number;
};

export type MyPortfoliosView = {
  masked: boolean;
  seed: MoneyView | null;
  /** Most of a portfolio in one stock and per strategy, percent (config). */
  stockMaxPct: number;
  strategyMaxPct: number;
  /** D-1858: the day the portfolios started fresh (YYYY-MM-DD). */
  startD: string;
  portfolios: MyPortfolio[];
};

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const big = (v: unknown): bigint => BigInt(s(v));
const ppm = (num: bigint, den: bigint): number | null =>
  den > 0n ? Number((num * PPM) / den) : null; // money-float-ok: ppm of exact micro amounts
const byProfile = (rows: Row[]): Map<string, Row[]> => {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(s(r.profile), [...(m.get(s(r.profile)) ?? []), r]);
  return m;
};

export async function loadMyPortfolios(env: LoaderEnv): Promise<MyPortfoliosView> {
  const market = env.market;
  const masked = env.mask.masked;
  const settings = await loadPortfolioSettings(env.main);
  const names = strategyNames(await soft(() => familyNames(env.main), {}));
  const seed = BigInt(settings.seedAud) * PPM;
  const q = async (sql: string, args: (string | number)[] = [market]): Promise<Row[]> =>
    soft(async () => (await env.main.execute({ sql, args })).rows as unknown as Row[], []);
  const latest = byProfile(
    await q(`SELECT profile, d, cash_micro, value_micro FROM pick_portfolio_day pd
             WHERE market = ? AND d = (SELECT MAX(x.d) FROM pick_portfolio_day x
               WHERE x.market = pd.market AND x.profile = pd.profile)`),
  );
  const worst = byProfile(
    await q(`SELECT profile, MIN(fall_ppm) AS worst FROM pick_portfolio_day WHERE market = ?
             GROUP BY profile`),
  );
  const holds = byProfile(
    await q(`SELECT profile, code, strategy, pub_d, entry_d, entry_micro, qty FROM pick_portfolio_hold
             WHERE market = ? ORDER BY profile, pos`),
  );
  const splits = byProfile(
    await q(`SELECT profile, shares_json, cash_ppm, words FROM pick_portfolio_split ps
             WHERE market = ? AND d = (SELECT MAX(x.d) FROM pick_portfolio_split x
               WHERE x.market = ps.market AND x.profile = ps.profile)`),
  );
  const closed = byProfile(
    await q(`SELECT profile, pos, SUM(net_micro) AS net FROM pick_portfolio_trade
             WHERE market = ? AND side = 'sell' GROUP BY profile, pos HAVING MAX(closes) = 1`),
  );
  const recent = byProfile(
    await q(
      `SELECT profile, d, code, pub_d, words FROM (
         SELECT profile, seq, d, code, pub_d, words,
                ROW_NUMBER() OVER (PARTITION BY profile ORDER BY seq DESC) AS n
         FROM pick_portfolio_trade WHERE market = ?) WHERE n <= ? ORDER BY profile, seq DESC`,
      [market, RECENT_TRADES],
    ),
  );
  // latest prices of the held stocks (the close, or a newer delayed quote)
  const codes = [...new Set([...holds.values()].flat().map((h) => s(h.code)))];
  const nowOf = new Map<string, bigint>();
  const liveAt = new Map<string, string>(); // code -> quote time, only for codes shown live
  if (codes.length > 0) {
    const closes = await q(
      `SELECT pb.code, pb.d, pb.c FROM price_bar pb
       WHERE pb.market = ? AND pb.code IN (${codes.map(() => "?").join(", ")})
         AND pb.d = (SELECT MAX(x.d) FROM price_bar x WHERE x.market = pb.market AND x.code = pb.code)`,
      [market, ...codes],
    );
    const closeD = new Map<string, string>();
    for (const c of closes) {
      nowOf.set(s(c.code), BigInt(priceMicro(Number(c.c)))); // money-float-ok: stored REAL bar price
      closeD.set(s(c.code), s(c.d));
    }
    const quotes = await soft(() => readLatestQuotes(env.main, market, codes), new Map());
    for (const code of codes) {
      const live = newerThanClose(quotes.get(code), closeD.get(code) ?? null);
      if (live) {
        nowOf.set(code, live.lastMicro);
        liveAt.set(code, live.quoteAt);
      }
    }
  }
  // company names of the held and traded codes (unmasked viewers only; chunks of 200, no OFFSET)
  const companyOf = new Map<string, string>();
  if (!masked) {
    const all = [
      ...new Set([
        ...[...holds.values()].flat().map((h) => s(h.code)),
        ...[...recent.values()].flat().map((t) => s(t.code)),
      ]),
    ];
    for (let i = 0; i < all.length; i += LATEST_READ_MAX) {
      const chunk = all.slice(i, i + LATEST_READ_MAX);
      const rows = await q(
        `SELECT code, name FROM instrument WHERE market = ? AND code IN (${chunk.map(() => "?").join(", ")})`,
        [market, ...chunk],
      );
      for (const r of rows)
        if (r.name !== null && r.name !== undefined) companyOf.set(s(r.code), s(r.name));
    }
  }
  const kit = masked
    ? await maskKitByDate(env, [
        ...[...holds.values()].flat().map((h) => ({ d: s(h.pub_d), code: s(h.code) })),
        ...[...recent.values()].flat().map((t) => ({ d: s(t.pub_d), code: s(t.code) })),
      ])
    : null;
  const label = (pubD: unknown, code: unknown): string =>
    kit ? kit.aliasOf(s(pubD)).label(s(code)) : s(code);
  const nameOf = (x: unknown): string =>
    (STRATEGIES as readonly string[]).includes(s(x)) ? names[s(x) as StrategyKey] : "A strategy";

  const portfolios: MyPortfolio[] = MY_PROFILES.map((profile) => {
    const day = latest.get(profile)?.[0];
    const holdingsMax = settings.profiles[profile].holdings;
    const base: MyPortfolio = {
      profile,
      started: false,
      holdingsMax,
      asOfD: null,
      seed: masked ? null : money(seed, env.currency),
      value: null,
      cash: null,
      gain: null,
      sinceStartPpm: null,
      liveLabel: null,
      closeValue: null,
      closeSinceStartPpm: null,
      worstFallPpm: null,
      holdings: [],
      split: null,
      splitWhy: null,
      trades: [],
      closed: 0,
      wins: 0,
    };
    if (day === undefined) return base;
    const value = big(day.value_micro);
    const sp = splits.get(profile)?.[0];
    let split: string | null = null;
    let splitWhy: string | null = null;
    if (sp !== undefined) {
      try {
        const shares = (JSON.parse(s(sp.shares_json)) as { strategy: string; target_ppm: number }[])
          .filter((x) => (STRATEGIES as readonly string[]).includes(x.strategy))
          .map((x) => ({ strategy: x.strategy as StrategyKey, targetPpm: x.target_ppm }));
        split = splitLine(shares, Number(sp.cash_ppm), names); // money-float-ok: SQL integer ppm
        const words = s(sp.words);
        const dot = words.indexOf(". ");
        splitWhy = dot >= 0 ? words.slice(dot + 2) : null;
      } catch {
        split = null;
      }
    }
    const done = closed.get(profile) ?? [];
    // Live value (display only, ARN-021): cash plus each holding at its delayed quote (or its close),
    // when any holding has a quote newer than its close. Same prices as the holdings list below.
    const held = holds.get(profile) ?? [];
    const liveCodes = held.filter((h) => liveAt.has(s(h.code)));
    let liveValue: bigint | null = null;
    let liveLabel: string | null = null;
    if (liveCodes.length > 0 && held.every((h) => nowOf.has(s(h.code)))) {
      liveValue = held.reduce(
        (sum, h) => sum + big(h.qty) * nowOf.get(s(h.code))!,
        big(day.cash_micro),
      );
      const at = liveCodes.map((h) => liveAt.get(s(h.code))!).sort()[liveCodes.length - 1]!;
      liveLabel = `Delayed, ${quoteTimeMelbourne(at)}`;
    }
    const shown = liveValue ?? value;
    return {
      ...base,
      started: true,
      asOfD: masked ? null : s(day.d),
      value: masked ? null : money(shown, env.currency),
      cash: masked ? null : money(s(day.cash_micro), env.currency),
      gain: masked ? null : money(shown - seed, env.currency),
      sinceStartPpm: ppm(shown - seed, seed),
      liveLabel,
      closeValue: masked || liveLabel === null ? null : money(value, env.currency),
      closeSinceStartPpm: liveLabel === null ? null : ppm(value - seed, seed),
      worstFallPpm: Number(worst.get(profile)?.[0]?.worst ?? 0), // money-float-ok: SQL integer ppm
      holdings: held.map((h) => {
        const entry = big(h.entry_micro);
        const now = nowOf.get(s(h.code)) ?? null;
        return {
          stock: label(h.pub_d, h.code),
          company: companyOf.get(s(h.code)) ?? null,
          strategy: nameOf(h.strategy),
          entryD: masked ? null : s(h.entry_d),
          entry: masked ? null : money(entry, env.currency),
          now: masked || now === null ? null : money(now, env.currency),
          changePpm: now === null ? null : ppm(now - entry, entry),
        };
      }),
      split,
      splitWhy,
      trades: (recent.get(profile) ?? []).map((t) => ({
        d: masked ? null : s(t.d),
        stock: label(t.pub_d, t.code),
        company: companyOf.get(s(t.code)) ?? null,
        words: s(t.words),
      })),
      closed: done.length,
      wins: done.filter((x) => big(x.net) > 0n).length,
    };
  });
  return {
    masked,
    seed: masked ? null : money(seed, env.currency),
    stockMaxPct: settings.stockMaxPct,
    strategyMaxPct: settings.strategyMaxPct,
    startD: settings.startD,
    portfolios,
  };
}
