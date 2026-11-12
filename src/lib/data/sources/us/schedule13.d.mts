export const SCHEDULE13_PARSER_VERSION: string;
export function isSchedule13(form: string): boolean;
export function percentOfClass(xml: string | null | undefined): number | null;
export function noticeOfSchedule13(
  form: string,
  o?: { percent?: number | null; previousPercent?: number | null },
):
  | { kind: "sh_new" | "sh_increase" | "sh_decrease" }
  | { skipped: "not_13dg" | "amendment_direction_unknown" | "no_change" };
export function writeHolderNotice(
  db: { execute: (...a: never[]) => unknown },
  market: string,
  n: { annId: string; code: string; kind: string; publishedAt: string },
): Promise<boolean>;
