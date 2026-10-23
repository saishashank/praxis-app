// Index-history backfill (D-175): the ASX 200 (^AXJO) daily bars since the history floor, so the
// replay and the regime gate know the market mood on past dates. Without them every family is
// blocked on "unknown" (REGIME_BLOCKS) and a full replay records no signal at all.
//   node scripts/backfill/index.mjs request --from YYYY-MM-DD --out request.json [--to YYYY-MM-DD]
//   node scripts/backfill/index.mjs commit --index index.json --from YYYY-MM-DD [--to YYYY-MM-DD]
// `request` writes the fetcher's request (scripts/ingest/yahoo_fetch.py; no secrets, no database).
// `commit` validates index.json with parseIndexText and inserts first-seen rows (writeIndexBars:
// ON CONFLICT DO NOTHING, so a re-run writes 0 and the nightly rows are never touched).
// env (commit only): TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: counts and statuses only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { isRealDate } from "../../src/lib/data/backfill/rules.mjs";
import {
  INDEX_YAHOO_SYMBOL,
  parseIndexText,
  writeIndexBars,
} from "../../src/lib/data/index/indexBars.mjs";

/** The fetcher needs at least one equity code; one liquid code keeps the request tiny. */
export const ANCHOR_CODE = "BHP";

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" && args[i + 1] !== "" ? args[i + 1] : null;
};

/** Today's date in Sydney (the market's calendar day). */
export const sydneyToday = (nowMs) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date(nowMs));

/** The fetcher request for [from, to]: one anchor code plus the index symbol. */
export function buildRequest(from, to) {
  return { codes: [ANCHOR_CODE], start: from, end: to, indices: [INDEX_YAHOO_SYMBOL] };
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => import("@libsql/client").Client,
 *   out?: (s: string) => void, nowMs?: () => number }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const [cmd, ...rest] = argv;
  const from = flag(rest, "--from");
  const to = flag(rest, "--to") ?? sydneyToday(nowMs());
  if (
    (cmd !== "request" && cmd !== "commit") ||
    !isRealDate(from) ||
    !isRealDate(to) ||
    from > to
  ) {
    out("index backfill: failed (usage: request|commit --from YYYY-MM-DD [--to YYYY-MM-DD])");
    return 1;
  }
  if (cmd === "request") {
    const file = flag(rest, "--out");
    if (file === null) {
      out("index backfill: failed (usage: request --out <file>)");
      return 1;
    }
    writeFileSync(file, JSON.stringify(buildRequest(from, to)));
    out(`index backfill request: ${from}..${to}`);
    return 0;
  }
  const file = flag(rest, "--index");
  if (file === null || !existsSync(file)) {
    out("index backfill commit: failed (index file missing)");
    return 1;
  }
  const parsed = parseIndexText(readFileSync(file, "utf8"), { from, to });
  if (parsed.status !== "ok") {
    out(`index backfill commit: failed (index file ${parsed.status})`);
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!url || (!token && !String(url).startsWith("file:"))) {
    out("index backfill commit: failed (database not configured)");
    return 1;
  }
  const db = (deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t })))(
    url,
    token || undefined,
  );
  try {
    const written = await writeIndexBars(db, {
      rows: parsed.rows,
      ingestedAt: new Date(nowMs()).toISOString(),
    });
    const rejected = Object.values(parsed.rejected).reduce((a, n) => a + n, 0);
    out(
      `index backfill commit: ok rows=${parsed.rows.length} written=${written} rejected=${rejected}`,
    );
    return 0;
  } catch (e) {
    // Never print a driver error: it can carry the database URL.
    out(`index backfill commit: failed (${e instanceof Error ? e.name : "unknown error"})`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2), process.env).then((c) => process.exit(c));
}
