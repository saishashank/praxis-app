// How often do splits and consolidations occur in the stored data? (M14 DAT-232, D-236; the numbers
// go into the AT-45 report.) Read only: it runs SELECTs and writes nothing. The logic lives in
// src/lib/data/splitFrequency.ts (bundled here), and the same scenario runs from
// `node scripts/arena/diagnose.mjs --scenario splitFrequency` (DAT-252 (3), D-974).
//   node scripts/data/split-frequency.mjs [--db <libsql url or file path>] [--window 20]
// Without --db it uses TURSO_MAIN_URL / TURSO_MAIN_TOKEN. Output: counts and shares only, no
// secrets and no row text.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@libsql/client";
import { loadEngine } from "../arena/engine.mjs";

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
    const { measure } = await loadEngine("src/lib/data/splitFrequency.ts");
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
