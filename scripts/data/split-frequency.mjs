// How often do splits and consolidations occur in the stored data? (M14 DAT-232, D-236; the numbers
// go into the AT-45 report.) Read only: it runs SELECTs and writes nothing.
//   node scripts/data/split-frequency.mjs [--db <libsql url or file path>] [--window 20]
// Without --db it uses TURSO_MAIN_URL / TURSO_MAIN_TOKEN. Output: counts and shares only, no
// secrets and no row text.
//   - split / consolidation / bonus-issue days per calendar year (corporate_action, ex_date);
//   - the share of codes (with price bars) that have at least one;
//   - the share of N-session windows (default 20, the volume-ratio window) that contain an ex-date.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@libsql/client";

export const QUANTITY_TYPES = ["split", "consolidation", "bonus_issue"];

/**
 * Pure summary. `actions`: [{ code, exDate, type }]; `barDates`: Map<code, string[]> sorted
 * ascending. A window is `window` consecutive bars of one code; it is touched when an ex-date of
 * that code falls within [first bar date, last bar date] of the window.
 */
export function summarise(actions, barDates, window = 20) {
  const quantity = actions.filter((a) => QUANTITY_TYPES.includes(a.type));
  const perYear = {};
  for (const a of quantity) {
    const y = a.exDate.slice(0, 4);
    perYear[y] = (perYear[y] ?? 0) + 1;
  }
  const exByCode = new Map();
  for (const a of quantity) {
    const list = exByCode.get(a.code) ?? [];
    list.push(a.exDate);
    exByCode.set(a.code, list);
  }
  let codesWithBars = 0;
  let codesWithSplit = 0;
  let windows = 0;
  let touched = 0;
  for (const [code, dates] of [...barDates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    codesWithBars++;
    const ex = exByCode.get(code) ?? [];
    if (ex.length > 0) codesWithSplit++;
    for (let i = window - 1; i < dates.length; i++) {
      windows++;
      const from = dates[i - window + 1];
      const to = dates[i];
      if (ex.some((e) => e >= from && e <= to)) touched++;
    }
  }
  const share = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1e6) / 1e4); // percent, 2 dp
  return {
    window,
    actions: quantity.length,
    perYear,
    codesWithBars,
    codesWithSplit,
    codesWithSplitPct: share(codesWithSplit, codesWithBars),
    windows,
    windowsTouched: touched,
    windowsTouchedPct: share(touched, windows),
  };
}

export async function measure(db, window = 20) {
  const acts = await db.execute(
    `SELECT code, ex_date, type FROM corporate_action WHERE type IN ('split','consolidation','bonus_issue') ORDER BY code, ex_date`,
  );
  const bars = await db.execute(`SELECT code, d FROM price_bar ORDER BY code, d`);
  const barDates = new Map();
  for (const r of bars.rows) {
    const code = String(r.code);
    const list = barDates.get(code) ?? [];
    list.push(String(r.d));
    barDates.set(code, list);
  }
  return summarise(
    acts.rows.map((r) => ({
      code: String(r.code),
      exDate: String(r.ex_date),
      type: String(r.type),
    })),
    barDates,
    window,
  );
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" ? args[i + 1] : null;
};

async function main(argv, env) {
  const dbArg = flag(argv, "--db");
  const window = Number(flag(argv, "--window") ?? 20);
  if (!Number.isInteger(window) || window < 2) {
    console.log("split-frequency: failed (usage: [--db <url|file>] [--window <n>=20])");
    return 1;
  }
  const url =
    dbArg === null
      ? env.TURSO_MAIN_URL
      : /^[a-z]+:\/\//i.test(dbArg)
        ? dbArg
        : pathToFileURL(path.resolve(dbArg)).href;
  if (typeof url !== "string" || url === "") {
    console.log("split-frequency: failed (no database: pass --db or set TURSO_MAIN_URL)");
    return 1;
  }
  const db = createClient({ url, authToken: dbArg === null ? env.TURSO_MAIN_TOKEN : undefined });
  try {
    console.log(JSON.stringify(await measure(db, window), null, 2));
    return 0;
  } catch {
    console.log("split-frequency: failed (query error)");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
