// RBA and ABS macro fetchers, shared part (DAT-251 c, D-973). Node, no dependency. One request per source,
// an identifying User-Agent, a conditional `If-Modified-Since` (the last Last-Modified is kept in
// worker_state under macro:<source>:last_modified), numbers parsed to integer micro units by string
// arithmetic (never a float), written to `macro_series` with an upsert that changes a row only when its
// value changed (Turso free plan: a repeat run writes nothing). Derived numbers only, source named
// (RBA copyright notice, DAT-236). Runs as a Friday step of ingest-batch1.yml gated by the repository
// variable MACRO_FETCH (unset = skipped, the feature ships OFF, D-973). Tests use fixtures: no network.
import { createClient } from "@libsql/client";

export const DEFAULT_UA = "praxis-research/1.0 (personal, non-commercial; weekly macro series)";
const TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 2_000_000; // threshold-ok: the RBA F1 file is ~300 KB; a body ten times that is refused

/** "4.35" -> 4350000, "-0.5" -> -500000, "1e3" or "" -> null. Up to 6 decimals; more are truncated toward zero. */
export function toMicro(text) {
  const m = /^\s*(-?)(\d{1,12})(?:\.(\d{1,12}))?\s*$/.exec(String(text ?? ""));
  if (m === null) return null;
  const frac = (m[3] ?? "").padEnd(6, "0").slice(0, 6);
  const v = Number(m[2]) * 1_000_000 + Number(frac);
  if (!Number.isSafeInteger(v)) return null;
  return m[1] === "-" ? -v : v;
}

const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};
const pad = (n, w = 2) => String(n).padStart(w, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** RBA "04-Jan-2011" -> "2011-01-04", else null. */
export function rbaDate(s) {
  const m = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/.exec(String(s).trim());
  if (m === null || MONTHS[m[2]] === undefined) return null;
  const d = Number(m[1]);
  const mo = MONTHS[m[2]];
  const y = Number(m[3]);
  if (d < 1 || d > lastDay(y, mo)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** ABS TIME_PERIOD ("2025-Q1", "2025-03", "2025-M03", "2025", "2025-03-31") -> the last day of the period, else null. */
export function absDate(s) {
  const t = String(s).trim();
  let m = /^(\d{4})-Q([1-4])$/.exec(t);
  if (m !== null) {
    const mo = Number(m[2]) * 3;
    return `${m[1]}-${pad(mo)}-${pad(lastDay(Number(m[1]), mo))}`;
  }
  m = /^(\d{4})-M?(\d{2})$/.exec(t);
  if (m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return `${m[1]}-${m[2]}-${pad(lastDay(Number(m[1]), Number(m[2])))}`;
  }
  m = /^(\d{4})$/.exec(t);
  if (m !== null) return `${m[1]}-12-31`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m !== null && Number(m[3]) >= 1 && Number(m[3]) <= lastDay(Number(m[1]), Number(m[2])))
    return t;
  return null;
}

/** One CSV line into fields (quotes, doubled quotes, commas). A BOM on the first line is dropped. */
export function csvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  const s = line.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export const csvLines = (text) => String(text).split(/\r?\n/);

/** One polite GET; `status`, `body` (text, size-capped) and `lastModified`. Never throws. */
export async function getCsv(url, { ua, accept, ifModifiedSince, fetchImpl = fetch }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { "user-agent": ua || DEFAULT_UA, accept };
    if (ifModifiedSince) headers["if-modified-since"] = ifModifiedSince;
    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    const status = res.status ?? (res.ok ? 200 : 0);
    if (status === 304) return { status, body: null, lastModified: null };
    if (status < 200 || status >= 300) return { status, body: null, lastModified: null };
    const body = await res.text();
    if (body.length > MAX_BODY_CHARS) return { status: 413, body: null, lastModified: null };
    return { status, body, lastModified: res.headers?.get?.("last-modified") ?? null };
  } catch {
    return { status: 0, body: null, lastModified: null };
  } finally {
    clearTimeout(t);
  }
}

const upsert = (r, fetchedAt) => ({
  sql:
    "INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT (source, series_id, d) DO UPDATE SET value_micro = excluded.value_micro, " +
    "fetched_at = excluded.fetched_at WHERE macro_series.value_micro <> excluded.value_micro",
  args: [r.source, r.series_id, r.d, r.value_micro, fetchedAt],
});

/**
 * The common run: read the stored Last-Modified, one GET, parse, write, remember the new Last-Modified.
 * `deps.openDb`, `deps.fetchImpl`, `deps.nowMs`, `deps.out` are injectable. Output: counts only.
 * Exit 0 done / not modified, 1 failed, 2 usage.
 */
export async function runMacro({ source, url, accept, parse }, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const label = `macro-${source}`;
  if (!env.TURSO_MAIN_URL) {
    out(`${label}: failed (database not configured)`);
    return 1;
  }
  const db = (deps.openDb ?? ((u, t) => createClient({ url: u, authToken: t })))(
    env.TURSO_MAIN_URL,
    env.TURSO_MAIN_TOKEN || undefined,
  );
  const nowIso = new Date((deps.nowMs ?? Date.now)()).toISOString();
  const key = `macro:${source}:last_modified`;
  try {
    const prev = await db.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [key],
    });
    let since = null;
    if (prev.rows.length > 0) {
      try {
        const v = JSON.parse(String(prev.rows[0].value_json));
        if (typeof v === "string" && v !== "") since = v;
      } catch {
        // ignore a damaged value: the next run is unconditional
      }
    }
    const r = await getCsv(url, {
      ua: env.MACRO_USER_AGENT,
      accept,
      ifModifiedSince: since,
      fetchImpl: deps.fetchImpl,
    });
    if (r.status === 304) {
      out(`${label}: not modified`);
      return 0;
    }
    if (r.body === null) {
      out(`${label}: failed (request status ${r.status})`);
      return 1;
    }
    const rows = parse(r.body);
    if (rows === null || rows.length === 0) {
      out(`${label}: failed (the table did not parse)`);
      return 1;
    }
    const stmts = rows.map((x) => upsert(x, nowIso));
    if (r.lastModified) {
      stmts.push({
        sql:
          "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        args: [key, JSON.stringify(r.lastModified), nowIso],
      });
    }
    const res = await db.batch(stmts, "write");
    const changed = res.slice(0, rows.length).reduce((n, x) => n + x.rowsAffected, 0);
    out(`${label}: ok rows=${rows.length} changed=${changed}`);
    return 0;
  } catch {
    out(`${label}: failed (unexpected error)`);
    return 1;
  } finally {
    db.close();
  }
}
