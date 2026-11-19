// India batch 1 CLI (M20 IN1; D-1127, D-1093, D-1125): the fetch step and the run step of the IN day, plain ESM.
//   node scripts/ingest/in/batch1.mjs fetch --d YYYY-MM-DD --dir <folder> [--market IN]
//   node scripts/ingest/in/batch1.mjs run   --d YYYY-MM-DD --dir <folder> [--market IN]
// `fetch` asks the exchange archive for the session's files THROUGH THE POLITE CLIENT (declared User-Agent, per-host
// interval, robots.txt, the register gate: a source whose row is not `enabled` is refused and nothing is requested) and
// writes what came back into <folder>. A refused or failed file is simply absent; the run step reports it. `run` reads
// the folder and runs `sources/in/day.mjs` `runDay` against the database of TURSO_MAIN_URL / TURSO_MAIN_TOKEN. Both
// resolve the market first (`--market IN`, or the single enabled one): with India off (production) they exit 2 with
// the standard refusal line before any request, file read or write. Output: statuses and counts only, never a row.
// The bhavcopy arrives as a one-file zip; it is inflated here (central directory, deflate or stored).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  createPoliteFetch,
  dbGate,
  isPoliteFetchRefused,
} from "../../../src/lib/data/sources/politeFetch.mjs";
import { prepareDay, runDay, FILE_KEYS, MARKET } from "../../../src/lib/data/sources/in/day.mjs";
import { resolveScriptMarket, takeMarketFlag } from "../../../src/lib/market/scriptMarket.mjs";
import { parseNow } from "../../e2e-day/now.mjs";
import { scriptDb } from "../../../src/lib/db/scriptClient.mjs";

const ARCHIVE = "https://nsearchives.nseindia.com";
const NSE = "https://www.nseindia.com";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The file names of the day folder, by day-module key. */
export const FILE_NAMES = Object.freeze({
  bhavcopy: "bhavcopy.csv",
  bands: "bands.csv",
  asm: "asm.json",
  gsm: "gsm.json",
  announcements_nse: "announcements_nse.json",
  announcements_bse: "announcements_bse.json",
  insider: "insider.csv",
  fo_oi: "fo_oi.csv",
  classification: "classification.csv",
  macro: "macro.csv",
  index: "index.csv",
});

/** The request of each fetchable key (the register id gates it); keys with no public URL are supplied by hand or not at all. */
export function requestOf(key, d) {
  const [y, m, dd] = d.split("-");
  switch (key) {
    case "bhavcopy":
      return {
        url: `${ARCHIVE}/content/cm/BhavCopy_NSE_CM_0_0_0_${y}${m}${dd}_F_0000.csv.zip`,
        source: "in_nse_bhavcopy",
        zip: true,
      };
    case "bands":
      return {
        url: `${ARCHIVE}/content/equities/sec_list_${dd}${m}${y}.csv`,
        source: "in_nse_bands",
      };
    case "asm":
      return { url: `${NSE}/api/reportASM`, source: "in_nse_asm_gsm" };
    case "gsm":
      return { url: `${NSE}/api/reportGSM`, source: "in_nse_asm_gsm" };
    case "classification":
      return {
        url: `${ARCHIVE}/content/indices/ind_nifty500list.csv`,
        source: "in_nse_classification",
      };
    default:
      return null;
  }
}

/** The first file of a zip, as text (reads the central directory: sizes are always there). @param {Buffer} buf */
export function firstZipEntry(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) return null;
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  return null;
}

/**
 * Fetch the day's files. Never throws for a refusal or an HTTP error: the key is absent and its status is a word.
 * @param {{ fetch: (url: string, init: any) => Promise<Response> }} client @param {string} d @param {readonly string[]} keys
 */
export async function fetchDay(client, d, keys) {
  /** @type {Record<string, string>} */
  const files = {};
  /** @type {Record<string, string>} */
  const status = {};
  for (const key of keys) {
    const req = requestOf(key, d);
    if (req === null) {
      status[key] = "no_public_source";
      continue;
    }
    try {
      const res = await client.fetch(req.url, { source: req.source, method: "GET" });
      if (res.status >= 400) {
        status[key] = `http_${res.status}`;
        continue;
      }
      const text = req.zip ? firstZipEntry(Buffer.from(await res.arrayBuffer())) : await res.text();
      if (text === null || text === "") status[key] = "unreadable";
      else {
        files[key] = text;
        status[key] = "ok";
      }
    } catch (e) {
      status[key] = isPoliteFetchRefused(e) ? `refused_${e.reason}` : "network";
    }
  }
  return { files, status };
}

const has = (v) => typeof v === "string" && v.trim() !== "";
/** @param {string[]} args @param {string} name */
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: Function, out?: (s: string) => void, nowMs?: () => number, client?: any }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const sim = parseNow(argv, env);
  if (sim.error) {
    out(`ingest-in: failed (${sim.error})`);
    return 2;
  }
  const nowMs = sim.nowMs ?? deps.nowMs ?? (() => Date.now());
  const mk = takeMarketFlag(sim.argv);
  if (mk.error) {
    out(`ingest-in: failed (${mk.error})`);
    return 2;
  }
  const [cmd, ...rest] = mk.argv;
  const d = flag(rest, "--d");
  const dir = flag(rest, "--dir");
  const reqFile = flag(rest, "--request");
  const bad =
    d === null || !DATE_RE.test(d) || (cmd === "prepare" ? reqFile === null : dir === null);
  if ((cmd !== "fetch" && cmd !== "run" && cmd !== "prepare") || bad) {
    out(
      "ingest-in: failed (usage: prepare --d D --request <file> | fetch|run --d D --dir <folder>)",
    );
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  if (!has(url)) {
    out("ingest-in: failed (database not configured)");
    return 1;
  }
  const db = (deps.openDb ?? ((u, t) => scriptDb({ url: u, token: t })))(url, env.TURSO_MAIN_TOKEN);
  const resolved = await resolveScriptMarket(db, mk.market, { supported: [MARKET] });
  if (!resolved.ok) {
    out(resolved.line);
    return resolved.exit;
  }
  const market = resolved.market;
  try {
    if (cmd === "prepare") {
      const prep = await prepareDay(db, { market, target: d, nowMs });
      if (prep.action !== "fetch") {
        out(`ingest-in: ${prep.action} (${prep.reason ?? "nothing to fetch"})`);
        return 0;
      }
      writeFileSync(reqFile, JSON.stringify(prep.request));
      out(
        `ingest-in: prepare ${d} (fetchable=${prep.fetchable.length} disabled=${prep.disabled.length})`,
      );
      return 0;
    }
    if (cmd === "fetch") {
      const prep = await prepareDay(db, { market, target: d, nowMs });
      if (prep.action !== "fetch") {
        out(`ingest-in: ${prep.action} (${prep.reason ?? "nothing to fetch"})`);
        return 0;
      }
      const client = deps.client ?? createPoliteFetch({ db, gate: dbGate(db), env });
      const { files, status } = await fetchDay(client, d, prep.fetchable);
      mkdirSync(dir, { recursive: true });
      for (const [k, text] of Object.entries(files))
        writeFileSync(path.join(dir, FILE_NAMES[k]), text);
      out(
        `ingest-in: fetched ${Object.keys(files).length} of ${prep.fetchable.length} files (${Object.entries(
          status,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")})`,
      );
      return 0;
    }
    /** @type {Record<string, string>} */
    const files = {};
    for (const key of FILE_KEYS) {
      const f = path.join(dir, FILE_NAMES[key]);
      if (existsSync(f)) files[key] = readFileSync(f, "utf8");
    }
    const r = await runDay(db, { market, d, files, nowMs, commitSha: env.COMMIT_SHA });
    out(
      `ingest-in: ${r.status} ${d} (${r.dates.map((x) => `${x.status}${x.outcome ? ` ${x.outcome}` : ""} bars=${x.bars}`).join("; ")})`,
    );
    return r.exit;
  } catch (e) {
    out(
      e && e.name === "MarketNotEnabled"
        ? "refused: market not enabled"
        : "ingest-in: failed (unexpected error)",
    );
    return e && e.name === "MarketNotEnabled" ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
