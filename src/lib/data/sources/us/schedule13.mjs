// Schedules 13D and 13G (substantial holders) -> `insider_notice` (M20 US1; DAT-243, AGT-105; D-1184). The table's
// kinds are `sh_new`, `sh_increase`, `sh_decrease`. A first filing (SC 13D, SC 13G, SCHEDULE 13D, SCHEDULE 13G) is a
// new holder: `sh_new`. An amendment (`/A`) is a change whose DIRECTION only the percent of class can give, against
// the holder's previous percent: the caller passes `previousPercent` when it has one, otherwise the amendment is
// skipped and counted (a direction is never guessed). No value is stored (`value_micro` null): a 13D/G states a
// percent, not a trade value.
import { assertMarketEnabled } from "../../../market/guard.mjs";

export const SCHEDULE13_PARSER_VERSION = "sched13-v1";
const FORM_RE = /^(?:SC|SCHEDULE) 13[DG](\/A)?$/i;

/** True for a 13D/13G form type. @param {string} form */
export const isSchedule13 = (form) => FORM_RE.test(form.trim());

/** The percent of class in an ownership XML (`<percentOfClass>7.5</percentOfClass>`), a number or null. @param {string | null | undefined} xml */
export function percentOfClass(xml) {
  const m = /<percentOfClass>\s*(\d+(?:\.\d+)?)\s*<\/percentOfClass>/i.exec(xml ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} form @param {{ percent?: number | null, previousPercent?: number | null }} [o]
 * @returns {{ kind: "sh_new" | "sh_increase" | "sh_decrease" } | { skipped: "not_13dg" | "amendment_direction_unknown" | "no_change" }}
 */
export function noticeOfSchedule13(form, o = {}) {
  const m = FORM_RE.exec(form.trim());
  if (m === null) return { skipped: "not_13dg" };
  if (m[1] === undefined) return { kind: "sh_new" };
  const { percent, previousPercent } = o;
  if (typeof percent !== "number" || typeof previousPercent !== "number")
    return { skipped: "amendment_direction_unknown" };
  if (percent === previousPercent) return { skipped: "no_change" };
  return { kind: percent > previousPercent ? "sh_increase" : "sh_decrease" };
}

/**
 * @param {{ execute: Function }} db @param {string} market
 * @param {{ annId: string, code: string, kind: string, publishedAt: string }} n
 * @returns {Promise<boolean>} whether a row was written
 */
export async function writeHolderNotice(db, market, n) {
  await assertMarketEnabled(db, market);
  const r = await db.execute({
    // rows-ok: one insert keyed by (market, ann_id), ignored when the notice exists
    sql: `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
          VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (market, ann_id) DO NOTHING`,
    args: [market, n.annId, n.code, n.kind, n.publishedAt, SCHEDULE13_PARSER_VERSION],
  });
  return r.rowsAffected === 1;
}
