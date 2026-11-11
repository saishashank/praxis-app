// M19 E2 (MKT-110, AT-68, D-994, D-1079): the PRODUCTION SHAPE of the market set, asserted at the end of the CI recorded
// day on the job's own database. A day that ran with the seed must leave exactly what production has:
//   - `market`: the home market (AU) `enabled 1`, mode `full` (the recorded day switches the run on, as production did at
//     go-live); every other built market (IN, US) `enabled 0`, mode `off`; no other market row;
//   - `market_row_count` (the nightly row-by-market invariant): no row for a market that is not enabled;
//   - the Worker's slot build names the home market only: the per-tick read of the Worker (MARKETS_SQL, read from
//     worker/src/markets.ts and run as written) returns that row and nothing else, its `slots_json` is the profile's
//     projection, and the recorded AU slot table (worker/test/fixtures/au-slots.snapshot.json) carries no other
//     market's code in an id or a key prefix.
// The market codes are read from the profile modules (the enabled set is the production default of `markets_enabled`,
// the variable unset), so this file writes none. Read-only. Output is codes, modes and counts only (SEC-110).
//   node scripts/e2e-day/assert-production-shape.mjs --work <recorded-day folder>   (reads <folder>/main.db)
//   node scripts/e2e-day/assert-production-shape.mjs --db <file>
// Exit 0 when every line holds, 1 when one fails, 2 on a usage or connection problem.
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOME_MARKET,
  marketsEnabledDefault,
  slotsJson,
} from "../../src/lib/market/profileCore.mjs";
import { builtMarkets } from "../../src/lib/market/seed/index.mjs";
import { staticProfile } from "../../src/lib/market/staticProfile.mjs";
import { localDbUrl } from "./check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The enabled set production has (D-994): the production default of the `markets_enabled` key. */
export const PRODUCTION_ENABLED = Object.freeze(marketsEnabledDefault({}));

/** The shape production has: `enabled` and the modes a built market may hold, per code. */
export const PRODUCTION_SHAPE = Object.freeze(
  Object.fromEntries(
    builtMarkets().map((code) => [
      code,
      Object.freeze(
        PRODUCTION_ENABLED.includes(code)
          ? { enabled: 1, modes: Object.freeze(["full"]) }
          : { enabled: 0, modes: Object.freeze(["off"]) },
      ),
    ]),
  ),
);

/** The Worker's per-tick statement as written in worker/src/markets.ts (null when the source no longer has it). */
export function workerMarketsSql(text) {
  const m = /export const MARKETS_SQL =\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

/** Market codes found as a tag (`:<CODE>`) in the ids and key prefixes of a recorded slot table. */
export function marketTagsIn(snapshotText) {
  return [...new Set([...snapshotText.matchAll(/:([A-Z]{2})(?=[:"])/g)].map((m) => m[1]))].sort();
}

/**
 * @param {{ execute(q: string | { sql: string, args?: unknown[] }): Promise<{ rows: Record<string, unknown>[] }> }} db
 * @param {{ workerMarketsText: string, slotSnapshotText: string }} src
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function checkProductionShape(db, src) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
    if (!pass) ok = false;
  };
  const built = Object.keys(PRODUCTION_SHAPE);

  // 1. the market rows
  const rows = (await db.execute("SELECT code, enabled, mode FROM market ORDER BY code")).rows;
  const byCode = new Map(rows.map((r) => [String(r.code), r]));
  const extra = [...byCode.keys()].filter((c) => !built.includes(c));
  say(
    extra.length === 0,
    `market rows are the built markets ${built.join(", ")} only${extra.length ? ` (also ${extra.join(", ")})` : ""}`,
  );
  for (const [code, want] of Object.entries(PRODUCTION_SHAPE)) {
    const r = byCode.get(code);
    if (r === undefined) {
      say(false, `${code}: no market row`);
      continue;
    }
    const enabled = Number(r.enabled);
    const mode = String(r.mode);
    say(
      enabled === want.enabled && want.modes.includes(mode),
      `${code}: enabled ${enabled}, mode ${mode} (want enabled ${want.enabled}, ${want.modes.join(" or ")})`,
    );
  }

  // 2. the invariant's rows
  const counted = (
    await db.execute(
      "SELECT market, COUNT(*) AS n FROM market_row_count WHERE market NOT IN (SELECT code FROM market WHERE enabled = 1) GROUP BY market",
    )
  ).rows;
  say(
    counted.length === 0,
    `market_row_count holds no row for a market that is not enabled${
      counted.length
        ? ` (${counted.map((r) => `${String(r.market)} x${Number(r.n)}`).join(", ")})`
        : ""
    }`,
  );

  // 3. the Worker's slot build
  const sql = workerMarketsSql(src.workerMarketsText);
  say(sql !== null, "worker/src/markets.ts still holds the per-tick market read");
  if (sql !== null) {
    const seen = (await db.execute(sql)).rows;
    const codes = seen.map((r) => String(r.code)).sort();
    say(
      JSON.stringify(codes) === JSON.stringify([...PRODUCTION_ENABLED].sort()),
      `the Worker's per-tick read returns ${PRODUCTION_ENABLED.join(", ")} only (got ${codes.join(", ") || "none"})`,
    );
    const home = seen.find((r) => String(r.code) === HOME_MARKET);
    say(
      home !== undefined && home.slots_json === slotsJson(staticProfile(HOME_MARKET)),
      "the home market row's slots_json is the profile's projection (the anchors the Worker builds its slots from)",
    );
  }
  const tags = marketTagsIn(src.slotSnapshotText).filter((c) => c !== HOME_MARKET);
  say(
    tags.length === 0,
    `the recorded home-market slot table names no other market${tags.length ? ` (${tags.join(", ")})` : ""}`,
  );
  return { ok, lines };
}

export function parseArgs(argv) {
  const out = { work: null, db: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--work" && i + 1 < argv.length) out.work = argv[++i];
    else if (argv[i] === "--db" && i + 1 < argv.length) out.db = argv[++i];
    else
      return {
        error: "usage: assert-production-shape.mjs --work <recorded-day folder> | --db <file>",
      };
  }
  if ((out.work === null) === (out.db === null))
    return { error: "give exactly one of --work and --db" };
  return out;
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) {
    out(args.error);
    return 2;
  }
  const url = localDbUrl(args.db ?? path.join(args.work, "main.db"));
  if (url === null) {
    out("refused: only a local database file is read");
    return 2;
  }
  let client = null;
  try {
    client = createClient({ url });
    const src = {
      workerMarketsText: readFileSync(path.join(ROOT, "worker/src/markets.ts"), "utf8"),
      slotSnapshotText: readFileSync(
        path.join(ROOT, "worker/test/fixtures/au-slots.snapshot.json"),
        "utf8",
      ),
    };
    const r = await checkProductionShape(client, src);
    for (const l of r.lines) out(l);
    out(r.ok ? "production shape: ok" : "production shape: FAILED");
    return r.ok ? 0 : 1;
  } catch {
    out("could not read the market tables of the recorded-day database");
    return 2;
  } finally {
    client?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
