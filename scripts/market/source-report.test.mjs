// M20 A3 (DAT-101, AT-M1, D-1093, D-1094): the source report on recorded responses. No network, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_UA, main, renderMarkdown, runReport } from "./source-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = () => new Date("2026-11-13T03:00:00Z");
const sleep = async () => {};
const sha12 = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex").slice(0, 12);

/** A recorded web: robots per host, pages per URL; every call is kept. */
function web({ robots = {}, pages = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const u = new URL(String(input));
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      ua: init.headers?.["user-agent"],
    });
    if (u.pathname === "/robots.txt") {
      const r = robots[u.hostname];
      return r === undefined
        ? new Response("", { status: 404 })
        : new Response(r, { status: 200, headers: { "content-type": "text/plain" } });
    }
    const page = pages[String(input)];
    if (page === undefined) return new Response("", { status: 404 });
    return new Response(init.method === "HEAD" ? null : (page.body ?? ""), {
      status: page.status ?? 200,
      headers: page.headers ?? {},
    });
  };
  return { fetchImpl, calls };
}

const OPEN = "User-agent: *\nAllow: /\n";

test("India: probe, terms hash, robots verdict, rate-limit headers, and what is never requested", async () => {
  const terms = "the exchange terms of use";
  const w = web({
    robots: {
      "www.nseindia.com": OPEN,
      "query1.finance.yahoo.com": "User-agent: *\nDisallow: /\n",
    },
    pages: {
      "https://www.nseindia.com/nse-terms-of-use": { body: terms },
      "https://www.nseindia.com/api/holiday-master?type=trading": {
        headers: { "x-ratelimit-remaining": "99", "set-cookie": "never=recorded" },
      },
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20251110_F_0000.csv.zip":
        {},
      "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html": { body: "yahoo terms" },
    },
  });
  const rep = await runReport({
    market: "IN",
    fetchImpl: w.fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "IN" },
  });
  assert.equal(rep.market, "IN");
  assert.equal(rep.checked_at, "2026-11-13");
  assert.equal(rep.sources.length, 16);
  const by = Object.fromEntries(rep.sources.map((s) => [s.id, s]));

  const holidays = by.in_nse_holidays;
  assert.equal(holidays.seeded_status, "enabled");
  assert.deepEqual(holidays.probe, {
    result: "ok",
    method: "HEAD",
    http_status: 200,
    robots: "allowed",
    rate_limit_headers: { "x-ratelimit-remaining": "99" },
  });
  assert.deepEqual(holidays.terms, {
    status: "ok",
    http_status: 200,
    bytes: Buffer.byteLength(terms),
    sha256_12: sha12(terms),
  });

  // Yahoo's robots.txt disallows: no probe request; the verdict says so
  assert.equal(by.in_yahoo_ns.probe.result, "refused");
  assert.equal(by.in_yahoo_ns.probe.reason, "robots_disallowed");
  assert.equal(by.in_yahoo_ns.probe.robots, "disallowed");
  assert.ok(!w.calls.some((c) => c.url.includes("finance.yahoo.com/v8")));

  // disabled: no probe (D-1125); manual: no probe
  for (const id of ["in_nse_announcements", "in_bse_announcements"]) {
    assert.deepEqual(by[id].probe, {
      result: "skipped",
      reason: "disabled_until_owner_acceptance",
    });
  }
  assert.deepEqual(by.in_nse_indices_manual.probe, { result: "skipped", reason: "manual" });
  assert.equal(by.in_nse_indices_manual.terms.status, "none");
  assert.ok(!w.calls.some((c) => c.url.includes("/api/corporate-announcements")));

  // an unknown probe page is a recorded HTTP error, not a failure of the run
  assert.equal(by.in_nse_asm_gsm.probe.result, "http_error");
  assert.equal(by.in_nse_asm_gsm.probe.http_status, 404);

  // the terms page of a URL shared by several sources is read once
  assert.equal(
    w.calls.filter((c) => c.url === "https://www.nseindia.com/nse-terms-of-use").length,
    1,
  );

  // every request carried the declared User-Agent and no contact
  for (const c of w.calls) assert.equal(c.ua, REPORT_UA);
  // never a body or a cookie in the output
  const text = JSON.stringify(rep) + renderMarkdown(rep);
  assert.ok(!text.includes(terms));
  assert.ok(!text.includes("never=recorded"));
});

test("US: EDGAR is skipped without the contact (no request to the SEC hosts), probed with it, and the contact never appears in the output", async () => {
  const w = web({
    robots: { "data.sec.gov": OPEN, "www.sec.gov": OPEN },
    pages: {
      "https://data.sec.gov/submissions/CIK0000320193.json": {},
      "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data": {
        body: "fair access",
      },
      "https://www.sec.gov/enforcement-litigation/trading-suspensions": {},
    },
  });
  const without = await runReport({
    market: "US",
    fetchImpl: w.fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "US" },
  });
  const e = without.sources.find((s) => s.id === "us_edgar");
  assert.deepEqual(e.probe, { result: "skipped", reason: "contact_missing" });
  assert.deepEqual(e.terms, { status: "skipped", reason: "contact_missing" });
  assert.ok(!w.calls.some((c) => /sec\.gov/.test(c.url)));
  assert.equal(without.user_agent, "declared, no contact");

  const DUMMY = "dummy-contact-value";
  const w2 = web({
    robots: { "data.sec.gov": OPEN, "www.sec.gov": OPEN },
    pages: {
      "https://data.sec.gov/submissions/CIK0000320193.json": {},
      "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data": {
        body: "fair access",
      },
      "https://www.sec.gov/enforcement-litigation/trading-suspensions": {},
    },
  });
  const withContact = await runReport({
    market: "US",
    fetchImpl: w2.fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "US", PRAXIS_EDGAR_CONTACT: DUMMY },
  });
  const e2 = withContact.sources.find((s) => s.id === "us_edgar");
  assert.equal(e2.probe.result, "ok");
  const sec = w2.calls.filter((c) => /sec\.gov/.test(c.url));
  assert.ok(sec.length > 0);
  for (const c of sec) assert.ok(c.ua.includes(DUMMY), "the SEC requests carry the contact");
  assert.ok(!JSON.stringify(withContact).includes(DUMMY));
  assert.ok(!renderMarkdown(withContact).includes(DUMMY));
  assert.equal(withContact.user_agent, "declared, with contact (value not recorded)");
});

test("a host that answers HEAD with 405 is probed once with a one-kilobyte GET range", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const u = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${u.pathname}${init.headers?.range ? " range" : ""}`);
    if (u.pathname === "/robots.txt") return new Response(OPEN);
    if (init.method === "HEAD") return new Response(null, { status: 405 });
    return new Response("x", { status: 206 });
  };
  const rep = await runReport({
    market: "US",
    only: "us_nyse_holidays",
    fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "US" },
  });
  assert.equal(rep.sources.length, 1);
  assert.equal(rep.sources[0].probe.method, "GET");
  assert.equal(rep.sources[0].probe.http_status, 206);
  assert.ok(calls.includes("HEAD /trade/hours-calendars"));
  assert.ok(calls.includes("GET /trade/hours-calendars range"));
});

test("an unreachable host is a recorded error and the run still completes", async () => {
  const fetchImpl = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response(OPEN);
    throw new TypeError("fetch failed");
  };
  const rep = await runReport({
    market: "IN",
    only: "in_mospi",
    fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "IN" },
  });
  assert.equal(rep.sources[0].probe.result, "error");
  assert.equal(rep.sources[0].terms.status, "error");
});

test("main writes the JSON and Markdown beside --out, prints counts only, and validates its arguments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srcrep-"));
  const w = web({
    robots: { "www.mospi.gov.in": OPEN },
    pages: { "https://www.mospi.gov.in/": {} },
  });
  const lines = [];
  const file = path.join(dir, "out", "report-IN.json");
  const code = await main(
    ["--market", "IN", "--out", file, "--only", "in_mospi"],
    { PRAXIS_MARKETS_ENABLED: "IN" },
    (l) => lines.push(l),
    {
      fetchImpl: w.fetchImpl,
      sleep,
      now: NOW,
    },
  );
  assert.equal(code, 0);
  assert.match(lines[0], /^source-report: done \(1 sources, 1 probed ok, 0 skipped, 0 refused\)$/);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(json.sources[0].id, "in_mospi");
  const md = fs.readFileSync(path.join(dir, "out", "report-IN.md"), "utf8");
  assert.match(md, /\| `in_mospi` \| enabled \| allowed \| ok \| 200 \|/);
  assert.match(md, /Checked 2026-11-13/);

  const bad = [];
  assert.equal(await main([], {}, (l) => bad.push(l)), 2);
  // the market must be named by PRAXIS_MARKETS_ENABLED (D-1142)
  assert.equal(await main(["--market", "IN", "--out", file], {}, (l) => bad.push(l)), 2);
  assert.equal(bad.at(-1), "source-report: refused: market not enabled");
  assert.equal(
    await main(["--market", "IN", "--out", file], { PRAXIS_MARKETS_ENABLED: "US" }, (l) =>
      bad.push(l),
    ),
    2,
  );
  assert.equal(bad.at(-1), "source-report: refused: market not enabled");
  assert.equal(
    await main(["--market", "in", "--out", file], { PRAXIS_MARKETS_ENABLED: "IN" }, (l) =>
      bad.push(l),
    ),
    2,
  );
  assert.equal(
    await main(["--market", "AU", "--out", file], { PRAXIS_MARKETS_ENABLED: "AU" }, (l) =>
      bad.push(l),
    ),
    2,
  );
  assert.match(bad.at(-1), /no source rows for this market/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the script reads the seed and touches no database or secret", () => {
  const src = fs.readFileSync(path.join(HERE, "source-report.mjs"), "utf8");
  assert.doesNotMatch(src, /scriptDb|createClient|TURSO|@libsql|secrets\./);
  assert.match(src, /PRAXIS_EDGAR_CONTACT/); // a name only
});

test("a disabled source gets neither a probe nor a terms-page request (D-1125)", async () => {
  const w = web({ robots: { "www.nseindia.com": OPEN, "www.bseindia.com": OPEN } });
  const rep = await runReport({
    market: "IN",
    only: "in_bse_announcements",
    fetchImpl: w.fetchImpl,
    sleep,
    now: NOW,
    env: { PRAXIS_MARKETS_ENABLED: "IN" },
  });
  assert.deepEqual(rep.sources[0].terms, {
    status: "skipped",
    reason: "disabled_until_owner_acceptance",
  });
  assert.equal(rep.sources[0].probe.result, "skipped");
  assert.equal(w.calls.length, 0);
});
