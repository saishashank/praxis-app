// Parameters of the movers gap additions (CR-MOV-A1…A8; D-740…D-759). Plain numbers read once from the
// configuration registry (keys.ts MOVERS_RANGED); every consumer takes this object, none reads a key
// itself. Defaults come from the registry, never from a second table here.
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";

export type MoversParams = {
  /** Local minute from which a halt resume is armed for the intraday scan (600 = 10:00). */
  readonly haltResumeArmMinute: number;
  readonly haltResumeBlockSessions: number;
  readonly haltWatchExpirySessions: number;
  readonly resultsWindowStartDay: number;
  readonly resultsWindowEndDay: number;
  readonly resultsPreWindowSessions: number;
  readonly knownDateMinHistoryDays: number;
  readonly volumeCreepVrMin: number;
  readonly volumeCreepArMinPct: number;
  readonly intradayArmCodesMax: number;
  readonly shortRiskPctMin: number;
  readonly shortRiskChangePpMin: number;
  readonly shortRiskF4Veto: boolean;
  readonly sectorCompositeMinMembers: number;
};

export function buildMoversParams(get: (k: ConfigKey) => unknown): MoversParams {
  const n = (k: ConfigKey): number => Number(get(k));
  return {
    haltResumeArmMinute: n("halt_resume_arm_minute"),
    haltResumeBlockSessions: n("halt_resume_block_sessions"),
    haltWatchExpirySessions: n("halt_watch_expiry_sessions"),
    resultsWindowStartDay: n("results_window_start_day"),
    resultsWindowEndDay: n("results_window_end_day"),
    resultsPreWindowSessions: n("results_pre_window_sessions"),
    knownDateMinHistoryDays: n("known_date_min_history_days"),
    volumeCreepVrMin: n("volume_creep_vr_min"),
    volumeCreepArMinPct: n("volume_creep_ar_min_pct"),
    intradayArmCodesMax: n("intraday_arm_codes_max"),
    shortRiskPctMin: n("short_risk_pct_min"),
    shortRiskChangePpMin: n("short_risk_change_pp_min"),
    shortRiskF4Veto: n("short_risk_f4_veto") === 1, // threshold-ok: 0/1 switch
    sectorCompositeMinMembers: n("sector_composite_min_members"),
  };
}

export const DEFAULT_MOVERS_PARAMS: MoversParams = buildMoversParams((k) => CONFIG_KEYS[k].default);

/** The registry keys this object reads, in a fixed order (the store loads them through getConfig). */
export const MOVERS_PARAM_KEYS: readonly ConfigKey[] = [
  "halt_resume_arm_minute",
  "halt_resume_block_sessions",
  "halt_watch_expiry_sessions",
  "results_window_start_day",
  "results_window_end_day",
  "results_pre_window_sessions",
  "known_date_min_history_days",
  "volume_creep_vr_min",
  "volume_creep_ar_min_pct",
  "intraday_arm_codes_max",
  "short_risk_pct_min",
  "short_risk_change_pp_min",
  "short_risk_f4_veto",
  "sector_composite_min_members",
];
