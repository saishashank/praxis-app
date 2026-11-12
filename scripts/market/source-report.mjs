// The DAT-101 source report of one market (M20 A3; D-1093, D-1094, D-1096, AT-M1). For each source row of
// src/lib/market/seed/<code>/sources.mjs it makes the one read the build allows:
//   - the terms page (GET, the body is hashed and dropped), once per distinct URL;
//   - one HEAD of the source's probe page or file (GET with a one-kilobyte range when HEAD is refused as not
//     allowed); a disabled source gets NO probe request (D-1125), a manual source has none, and a source that
//     needs the declared contact (EDGAR, D-1094) is skipped as `contact_missing` unless PRAXIS_EDGAR_CONTACT is set.
// Every request goes through the polite client (src/lib/data/sources/politeFetch.mjs): declared User-Agent, a
// per-host interval, backoff on 429 and 5xx, robots.txt obeyed (a disallowed or unreachable robots.txt means no
// request and the verdict says so).
//
//   node scripts/market/source-report.mjs --market IN|US --out <file.json> [--only <source id>]
//
// Writes <file>.json and the Markdown summary beside it (<file>.md): ids, statuses, dates, HTTP statuses, robots
// verdict, rate-limit header values and the first 12 hex of the terms-page hash. Never a body, a cookie, a
// contact value or a secret (SEC-110). No database and no Turso variable is touched: the report reads the seed.
// Exit 0 done, 1 failed, 2 usage. Output: counts only.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPoliteFetch,
  isPoliteFetchRefused,
} from "../../src/lib/data/sources/politeFetch.mjs";
import { marketSourcesOf } from "../../src/lib/market/seed/sourceSites.mjs";

export const REPORT_UA = "Praxis-M20-source-report/1.0 (private research; single owner)";
export const CONTACT_ENV = "PRAXIS_EDGAR_CONTACT";
const MARKET_RE = /^[A-Z]{2,5}$/;
const RATE_HEADERS = /^(x-ratelimit-|ratelimit-|retry-after$)/i;
const MAX_TERMS_BYTES = 2_000_000;

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** @param {string} text */
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * @param {{
 *   market: string,
 *   only?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => Date,
 *   env?: Record<string, string | undefined>,
 * }} p
 */
export async function runReport(p) {
  const env = p.env ?? process.env;
  const now = p.now ?? (() => new Date());
  const rows = marketSourcesOf(p.market).filter((r) => p.only === undefined || r.id === p.only);
  const contact = (env[CONTACT_ENV] ?? "").trim();
  const userAgent = contact === "" ? REPORT_UA : `Praxis-M20-source-report/1.0 (${contact})`;

  // The report's own host table: the hosts a row names, its probe host and its terms host.
  /** @type {Map<string, Set<string>>} */
  const hostSources = new Map();
  for (const r of rows) {
    for (const h of [...r.hosts, hostOf(r.probe?.url ?? ""), hostOf(r.terms_url ?? "")]) {
      if (h === null) continue;
      if (!hostSources.has(h)) hostSources.set(h, new Set());
      hostSources.get(h).add(r.id);
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const client = createPoliteFetch({
    fetchImpl: p.fetchImpl,
    sleep: p.sleep,
    env,
    gate: () => null, // the report reads the seed, there is no register or market to ask
    userAgent,
    siteOf: (host) => {
      const h = String(host).toLowerCase();
      const s = hostSources.get(h);
      return s === undefined ? null : { host: h, sources: [...s] };
    },
    sourceOf: (id) => byId.get(id),
  });

  /** One request through the client; refusals and errors become words. */
  async function call(row, url, init) {
    try {
      const res = await client.fetch(url, {
        ...init,
        source: row.id,
        ...(row.contact === true ? { userAgent } : {}),
      });
      return { res };
    } catch (e) {
      if (isPoliteFetchRefused(e)) return { refused: e.reason };
      return { error: "network" };
    }
  }

  const termsCache = new Map();
  async function terms(row) {
    if (row.terms_url === null) return { status: "none" };
    if (row.contact === true && contact === "")
      return { status: "skipped", reason: "contact_missing" };
    if (termsCache.has(row.terms_url)) return termsCache.get(row.terms_url);
    const r = await call(row, row.terms_url, { method: "GET" });
    let out;
    if (r.refused) out = { status: "refused", reason: r.refused };
    else if (r.error) out = { status: "error", reason: r.error };
    else {
      const buf = Buffer.from(await r.res.arrayBuffer()).subarray(0, MAX_TERMS_BYTES);
      out = {
        status: "ok",
        http_status: r.res.status,
        bytes: buf.length,
        sha256_12: r.res.status < 400 ? sha(buf).slice(0, 12) : null,
      };
    }
    termsCache.set(row.terms_url, out);
    return out;
  }

  async function probe(row) {
    if (row.status === "disabled")
      return { result: "skipped", reason: "disabled_until_owner_acceptance" };
    if (row.probe === null)
      return { result: "skipped", reason: row.hosts.length === 0 ? "manual" : "no_probe" };
    if (row.contact === true && contact === "")
      return { result: "skipped", reason: "contact_missing" };
    let r = await call(row, row.probe.url, { method: "HEAD" });
    let method = "HEAD";
    if (r.res && (r.res.status === 405 || r.res.status === 501)) {
      r = await call(row, row.probe.url, { method: "GET", headers: { range: "bytes=0-1023" } });
      method = "GET";
    }
    if (r.refused) {
      return {
        result: "refused",
        reason: r.refused,
        robots:
          r.refused === "robots_disallowed"
            ? "disallowed"
            : r.refused === "robots_unavailable"
              ? "unavailable"
              : "not_checked",
      };
    }
    if (r.error) return { result: "error", reason: r.error, robots: "allowed" };
    const headers = {};
    for (const [k, v] of r.res.headers.entries())
      if (RATE_HEADERS.test(k)) headers[k.toLowerCase()] = v;
    if (method === "GET") await r.res.arrayBuffer().catch(() => {});
    return {
      result: r.res.status < 400 ? "ok" : "http_error",
      method,
      http_status: r.res.status,
      robots: "allowed",
      rate_limit_headers: headers,
    };
  }

  const checkedAt = now().toISOString().slice(0, 10);
  const sources = [];
  for (const row of rows) {
    const t = await terms(row);
    const pr = await probe(row);
    sources.push({
      id: row.id,
      seeded_status: row.status,
      risk: row.risk,
      host: row.hosts[0] ?? hostOf(row.probe?.url ?? "") ?? null,
      terms: t,
      probe: pr,
    });
  }
  return {
    market: p.market,
    checked_at: checkedAt,
    user_agent:
      contact === "" ? "declared, no contact" : "declared, with contact (value not recorded)",
    sources,
  };
}

/** The Markdown summary of a report (ids, statuses, dates; never a body). @param {Awaited<ReturnType<typeof runReport>>} rep */
export function renderMarkdown(rep) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
  const lines = [
    `# DAT-101 source report: ${rep.market}`,
    "",
    `Checked ${rep.checked_at}. User-Agent: ${rep.user_agent}. Counts and statuses only; no page body is kept.`,
    "",
    "| Source | Seeded status | Robots | Probe | HTTP | Terms page | Terms hash |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of rep.sources) {
    lines.push(
      `| \`${s.id}\` | ${s.seeded_status} | ${cell(s.probe.robots ?? "n/a")} | ${cell(
        s.probe.result + (s.probe.reason ? ` (${s.probe.reason})` : ""),
      )} | ${cell(s.probe.http_status ?? "")} | ${cell(
        s.terms.status +
          (s.terms.reason
            ? ` (${s.terms.reason})`
            : s.terms.http_status
              ? ` ${s.terms.http_status}`
              : ""),
      )} | ${cell(s.terms.sha256_12 ?? "")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** @param {string[]} argv @param {string} flag */
const arg = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env @param {(line: string) => void} out
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => Date }} [deps]
 */
export async function main(argv, env = process.env, out = console.log, deps = {}) {
  const market = arg(argv, "--market");
  const file = arg(argv, "--out");
  if (market === undefined || !MARKET_RE.test(market) || file === undefined || file === "") {
    out("source-report: usage: --market <CODE> --out <file.json> [--only <source id>]");
    return 2;
  }
  if (marketSourcesOf(market).length === 0) {
    out("source-report: refused: no source rows for this market");
    return 2;
  }
  try {
    const rep = await runReport({ market, only: arg(argv, "--only"), env, ...deps });
    const base = file.replace(/\.json$/i, "");
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(`${base}.json`, `${JSON.stringify(rep, null, 2)}\n`);
    writeFileSync(`${base}.md`, renderMarkdown(rep));
    const n = (f) => rep.sources.filter(f).length;
    out(
      `source-report: done (${rep.sources.length} sources, ${n((s) => s.probe.result === "ok")} probed ok, ${n((s) => s.probe.result === "skipped")} skipped, ${n((s) => s.probe.result === "refused")} refused)`,
    );
    return 0;
  } catch {
    out("source-report: failed");
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
