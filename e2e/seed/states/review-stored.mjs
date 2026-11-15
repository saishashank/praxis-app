// State `review-stored` (M21 A1, D-1236, D-1203; UXN-320 a): one stored Evening Review for the newest e2e weekday, so
// the review frame (sandboxed, no script) renders in e2e: the plain seed holds no stored review (e2e/reviews.spec.ts).
// The page is Praxis's own e-mail HTML frozen at send time; this one is small, synthetic and has no script, no link and
// no real code. Idempotent: (d, version) is the primary key, so a second apply is ignored.
import { tradingDays } from "../data.mjs";

const SHA = "b".repeat(64);
const HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Evening Review</title></head><body>' +
  "<h1>Evening Review</h1><p>This is a synthetic review stored for the end-to-end checks. " +
  "It holds no real company, price or link.</p>" +
  "<h2>What happened today</h2><p>Nothing real happened: this text exists so the frame has a height to measure.</p>" +
  "</body></html>";
const TEXT =
  "Evening Review\nThis is a synthetic review stored for the end-to-end checks.\nWhat happened today\nNothing real happened.";
const MARKDOWN =
  "# Evening Review\n\nThis is a synthetic review stored for the end-to-end checks.\n\n## What happened today\n\nNothing real happened.\n";

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const d = tradingDays(nowIso, 1)[0];
  await client.execute({
    sql: `INSERT OR IGNORE INTO evening_review (d, version, kind, missing_json, facts_json, facts_sha, html, text, markdown,
            size_html, narrative, created_at)
          VALUES (?, 1, 'full', '[]', '{}', ?, ?, ?, ?, ?, 'rules', ?)`,
    args: [d, SHA, HTML, TEXT, MARKDOWN, HTML.length, nowIso],
  });
}
