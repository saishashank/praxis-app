// Test helper (M20 US1): a migrated database with the US market in development `data_only` mode, its calendar for 2026,
// its register rows, and the four synthetic fixture companies as `instrument` rows. Never a production shape: the US is
// off there (PRD-040); this is the "development mode" of D-1119. Fixture data comes from the generator, never from disk.
import type { Client } from "@libsql/client";
import { ensureCalendarYears } from "@/lib/data/calendarAdmin";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { allowMarket, freshDb } from "../../db/helpers";
// @ts-expect-error plain ESM script without types
import { buildUsFixtures, SESSIONS } from "../../../scripts/ingest/us/synthetic.mjs";
// @ts-expect-error plain ESM script without types
import { buildFeeds } from "../../../scripts/ingest/us/feeds.mjs";

export const MARKET = "US";
export const FIXTURES = buildUsFixtures() as {
  sessions: string[];
  companies: { code: string; cik: string; name: string; sic: string; px: number; vol: number }[];
  files: Record<string, string>;
};
export const DAYS: string[] = SESSIONS;
/** An instant after the US close of a session date, in the same local date (18:30 New York time in November). */
export const nightMs = (d: string) => Date.parse(`${d}T23:30:00.000Z`);

export async function usDevDb(opts: { instruments?: boolean } = {}): Promise<Client> {
  const db = await freshDb("main");
  await allowMarket(db, MARKET);
  await db.execute({ sql: "UPDATE market SET mode = 'data_only' WHERE code = ?", args: [MARKET] });
  await ensureMarketSources(db, MARKET);
  await ensureCalendarYears(db, MARKET, [2026]);
  if (opts.instruments !== false) {
    for (const c of FIXTURES.companies) {
      await db.execute({
        sql: "INSERT INTO instrument (market, code, name, listed_on) VALUES (?, ?, ?, '2020-01-02')",
        args: [MARKET, c.code, c.name],
      });
    }
  }
  return db;
}

/** The files of one session: the bars text and the feeds object the day module takes. */
export function sessionFiles(d: string): { barsText: string; feeds: Record<string, unknown> } {
  const f = FIXTURES.files;
  const get = (rel: string): string | undefined => f[`${d}/${rel}`];
  const submissions: Record<string, unknown> = {};
  const documents: Record<string, string> = {};
  const indexCsv: Record<string, string> = {};
  let finraDaily: string | null = null;
  for (const [path, text] of Object.entries(f)) {
    if (!path.startsWith(`${d}/`)) continue;
    const rel = path.slice(d.length + 1);
    let m: RegExpExecArray | null;
    if ((m = /^edgar\/submissions-(.+)\.json$/.exec(rel))) submissions[m[1]!] = JSON.parse(text);
    else if ((m = /^edgar\/(?:form4|schedule13)-(.+)\.xml$/.exec(rel))) documents[m[1]!] = text;
    else if ((m = /^index\/(.+)\.csv$/.exec(rel))) indexCsv[m[1]!] = text;
    else if (/^finra\//.test(rel)) finraDaily = text;
  }
  const feeds = buildFeeds({
    submissions,
    documents,
    finraDaily,
    halts: get("halts/halts.xml") ?? null,
    suspensions: get("halts/suspensions.xml") ?? null,
    indexCsv,
  });
  return { barsText: get("bars.json")!, feeds };
}
