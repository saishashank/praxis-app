// D-956 settings of "My portfolio": the config keys read once per night (and by the page), each
// checked by its own validator; a missing, unreadable or invalid value gives the registry default.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import {
  CONFIG_KEYS,
  MY_PORTFOLIO_PROFILE_NAMES,
  MY_PORTFOLIO_PROFILES_DEFAULT,
  type ConfigKey,
  type MyPortfolioProfile,
} from "@/lib/config/keys";
import { isCostProfileCode, type CostProfileCode } from "@/lib/arena/costs";
import type { ProfileParams } from "./portfolio";

export type MyProfileName = (typeof MY_PORTFOLIO_PROFILE_NAMES)[number];
export const MY_PROFILES: readonly MyProfileName[] = MY_PORTFOLIO_PROFILE_NAMES;

export type PortfolioSettings = {
  readonly seedAud: number;
  readonly stockMaxPct: number;
  readonly strategyMaxPct: number;
  readonly costMaxPct: number;
  readonly minParcelAud: number;
  readonly costProfile: CostProfileCode;
  readonly profiles: Readonly<Record<MyProfileName, MyPortfolioProfile>>;
};

const PCT_PPM = 10_000; // threshold-ok: ppm in one percent

async function read(db: Pick<Client, "execute">, key: ConfigKey): Promise<unknown> {
  const def = CONFIG_KEYS[key].default as unknown;
  try {
    const v = await getConfig(db, key);
    return (await CONFIG_KEYS[key].validate(v, async () => undefined)) === null ? v : def;
  } catch {
    return def;
  }
}

export async function loadPortfolioSettings(
  db: Pick<Client, "execute">,
): Promise<PortfolioSettings> {
  const cost = await read(db, "cost_profile_default");
  return {
    seedAud: (await read(db, "my_portfolio_seed_aud")) as number,
    stockMaxPct: (await read(db, "my_portfolio_stock_max_pct")) as number,
    strategyMaxPct: (await read(db, "my_portfolio_strategy_max_pct")) as number,
    costMaxPct: (await read(db, "my_portfolio_cost_max_pct")) as number,
    minParcelAud: (await read(db, "my_portfolio_min_parcel_aud")) as number,
    costProfile: isCostProfileCode(cost) ? cost : "P6",
    profiles: ((await read(db, "my_portfolio_profiles")) ??
      MY_PORTFOLIO_PROFILES_DEFAULT) as Record<MyProfileName, MyPortfolioProfile>,
  };
}

const ppm = (pct: number): number => Math.round(pct * PCT_PPM);

/** The engine's profile parameters (the stock caps never above the portfolio's stock cap). */
export function profileParams(s: PortfolioSettings, name: MyProfileName): ProfileParams {
  const p = s.profiles[name];
  const stock = Math.min(p.stock_pct, s.stockMaxPct);
  return {
    holdings: p.holdings,
    riskPpm: ppm(p.risk_pct),
    stockCapPpm: ppm(stock),
    smallStockCapPpm: ppm(Math.min(p.small_stock_pct, stock)),
    allocation: {
      shrinkN: p.shrink_n,
      volTilt: p.vol_tilt,
      weakCash: p.weak_cash_pct / 100, // threshold-ok: percent to a fraction
    },
    bandPpm: ppm(p.band_pct),
    minHoldSessions: p.min_hold_sessions,
  };
}

export const pctPpm = ppm;
