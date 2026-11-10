// TEMPORARY STUB of the daily-learning contract. The real module is built on the learning-loop
// branch and replaces this file at merge; the Evening Review only depends on these types.
import type { Client } from "@libsql/client";

export type MoverCause =
  | "news_before_open"
  | "news_during_day"
  | "sector_move"
  | "market_move"
  | "volume_no_news"
  | "stock_specific";
export type MoverExplanation = {
  code: string;
  name: string | null;
  side: "gainer" | "loser";
  movePpm: number;
  cause: MoverCause;
  causeText: string;
  indexMovePpm: number | null;
  sectorName: string | null;
  sectorMovePpm: number | null;
  volumeVsUsualPpm: number | null;
  setupBefore: string[];
  caughtBy: string | null;
  nearMiss: string | null;
};
export type FeatureLesson = {
  feature: string;
  sessions: number;
  n: number;
  nextDayAvgPpm: number;
  baseAvgPpm: number;
  liftPpm: number;
  hitRatePpm: number;
  verdict: "beats the market" | "lags the market" | "no clear edge yet";
  change: "new" | "stronger" | "weaker" | "unchanged";
};
export type ImprovementItem = {
  title: string;
  evidence: string;
  action: string;
  area: "picks" | "strategies" | "data" | "learning";
};
export type DailyLearning = {
  d: string;
  summary: string[];
  movers: MoverExplanation[];
  lessons: FeatureLesson[];
  improvements: ImprovementItem[];
  hypothesesOpened: string[];
};

export async function loadDailyLearning(
  _db: Pick<Client, "execute">,
  _market: string,
  _d: string,
): Promise<DailyLearning | null> {
  return null;
}
