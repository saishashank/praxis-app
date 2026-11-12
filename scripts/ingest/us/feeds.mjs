// The feeds file of a US night (M20 US1): what the fetch step hands the database step. One JSON object:
//   { submissions: [{ code, json }], form4: [{ code, accession, acceptedAt, xml }],
//     schedule13: [{ code, accession, form, acceptedAt, xml }], finraDaily, halts, suspensions, indexCsv: { <index>: csv } }
// `buildFeeds` is pure: it takes the documents however they were obtained (the live fetch step, a recorded fixture
// folder, a test) and assembles the file. The Form 4 and 13D/G documents are picked by accession from the filings the
// submissions list, so the file holds only documents of filings the company really lists.
import { isSchedule13 } from "../../../src/lib/data/sources/us/schedule13.mjs";
import { parseSubmissions } from "../../../src/lib/data/sources/us/submissions.mjs";

/**
 * @param {{
 *   submissions?: Record<string, unknown>,       code -> submissions JSON
 *   documents?: Record<string, string>,          accession -> the Form 4 or 13D/G document text
 *   finraDaily?: string | null, halts?: string | null, suspensions?: string | null,
 *   indexCsv?: Record<string, string>,
 * }} input
 */
export function buildFeeds(input) {
  const feeds = {
    submissions: [],
    form4: [],
    schedule13: [],
    finraDaily: input.finraDaily ?? null,
    halts: input.halts ?? null,
    suspensions: input.suspensions ?? null,
    indexCsv: input.indexCsv ?? {},
  };
  for (const [code, json] of Object.entries(input.submissions ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    feeds.submissions.push({ code, json });
    for (const f of parseSubmissions(json).filings) {
      const xml = input.documents?.[f.accession];
      if (xml === undefined || f.acceptedAt === null) continue;
      if (f.form === "4") {
        feeds.form4.push({ code, accession: f.accession, acceptedAt: f.acceptedAt, xml });
      } else if (isSchedule13(f.form)) {
        feeds.schedule13.push({
          code,
          accession: f.accession,
          form: f.form,
          acceptedAt: f.acceptedAt,
          xml,
        });
      }
    }
  }
  return feeds;
}
