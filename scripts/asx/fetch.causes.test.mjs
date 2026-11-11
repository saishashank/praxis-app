// DAT-251 a (D-972): causes, backoff, budget, parse hashes and the skip list of the ASX fetch step.
// No network: a fake fetch, a fake sleep and a fake clock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  causeOf,
  DEFAULT_BUDGET_MS,
  fetchAll,
  MAX_RETRY_AFTER_MS,
  retryAfterMs,
} from "./fetch.mjs";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const CSV3 =
  'h\n\nCompany name,ASX code,GICS industry group\n"A","ZZA","x"\n"B","ZZB","x"\n"C","ZZC","x"\n"D","ZZD","x"\n';
const EMPTY = JSON.stringify({ data: { items: [] } });
const reply = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
function routed(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [needle, r] of map) if (url.includes(needle)) return r;
    return reply(404);
  };
  return { impl, calls };
}

test("causeOf maps statuses; 401/403 are server_error, never not_found (a block is not a delisting)", () => {
  assert.equal(causeOf(0), "network");
  assert.equal(causeOf(200), "ok");
  assert.equal(causeOf(404), "not_found");
  assert.equal(causeOf(429), "rate_limited");
  assert.equal(causeOf(500), "server_error");
  assert.equal(causeOf(503), "server_error");
  assert.equal(causeOf(403), "server_error");
  assert.equal(causeOf(401), "server_error");
});

test("retryAfterMs reads whole seconds, caps at 60 s, ignores junk", () => {
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs("999"), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(retryAfterMs(undefined), null);
});

test("planted 404 / 429 / 500 / parse / network are classified per request", async () => {
  const f = routed([
    ["/markets/", reply(200, EMPTY)],
    [".csv", reply(200, CSV3)],
    ["/companies/ZZA/", reply(404)],
    ["/companies/ZZB/", reply(429, "", { "retry-after": "3" })],
    ["/companies/ZZC/", reply(500)],
    ["/companies/ZZD/", reply(200, "<html>not json</html>")],
  ]);
  const r = await fetchAll({ nowMs: NOW, history: true, fetchImpl: f.impl, sleep: async () => {} });
  assert.equal(r.stats.causes.not_found, 1);
  assert.equal(r.stats.causes.rate_limited, 1);
  assert.equal(r.stats.causes.server_error, 1);
  assert.equal(r.stats.causes.parse, 1);
  assert.deepEqual(r.stats.notFound, ["ZZA"]);
  assert.equal(r.stats.causes.ok, 2); // feed page + companies
  assert.equal(r.stats.failed, 4);
  const status = JSON.parse(r.files["fetch-status.json"]);
  assert.deepEqual(status.notFound, ["ZZA"]);
  assert.equal(status.companiesCause, "ok");
  const n = await fetchAll({
    nowMs: NOW,
    fetchImpl: async () => {
      throw new Error("boom");
    },
    sleep: async () => {},
  });
  assert.equal(n.stats.causes.network, 2); // feed page 0 and the company list
  assert.equal(JSON.parse(n.files["fetch-status.json"]).companiesCause, "network");
});

test("a parse failure records the body's SHA-256 and never the body", async () => {
  const body = "<html>secret-ish body</html>";
  const f = routed([
    ["/markets/", reply(200, EMPTY)],
    [".csv", reply(200, CSV3)],
    ["/companies/ZZA/", reply(200, body)],
  ]);
  const r = await fetchAll({ nowMs: NOW, history: true, fetchImpl: f.impl, sleep: async () => {} });
  const want = createHash("sha256").update(body).digest("hex");
  assert.deepEqual(r.stats.parseFailures, [{ code: "ZZA", sha256: want }]);
  assert.ok(!JSON.stringify(r.files).includes("secret-ish"));
});

test("a 429 widens the gap: Retry-After first, then doubling (the fake sleep sees it)", async () => {
  const waits = [];
  const f = routed([
    ["/markets/", reply(200, EMPTY)],
    [".csv", reply(200, CSV3)],
    ["/companies/ZZA/", reply(429, "", { "retry-after": "5" })],
    ["/companies/ZZB/", reply(429)],
    ["/companies/ZZC/", reply(429)],
    ["/companies/ZZD/", reply(200, EMPTY)],
  ]);
  await fetchAll({
    nowMs: NOW,
    history: true,
    fetchImpl: f.impl,
    sleep: async (ms) => waits.push(ms),
  });
  // gaps before: csv, ZZA, ZZB, ZZC, ZZD (the first request, the feed, waits for nothing)
  assert.deepEqual(waits, [700, 700, 5000, 10000, 20000]);
});

test("the run budget stops the history loop and leaves the rest for the next run", async () => {
  let t = 0;
  const f = routed([
    ["/markets/", reply(200, EMPTY)],
    [".csv", reply(200, CSV3)],
    ["/companies/", reply(200, EMPTY)],
  ]);
  const r = await fetchAll({
    nowMs: NOW,
    history: true,
    fetchImpl: f.impl,
    clock: () => t,
    budgetMs: DEFAULT_BUDGET_MS,
    sleep: async (ms) => {
      t += ms * 200; // each polite gap burns 140 s of fake time
    },
  });
  assert.equal(r.stats.budgetStop, true);
  assert.ok(r.stats.historyAttempted > 0 && r.stats.historyAttempted < 4);
  assert.equal(r.stats.historyLeft, 4 - r.stats.historyAttempted);
});

test("delisted codes in the state leave the history list", async () => {
  const f = routed([
    ["/markets/", reply(200, EMPTY)],
    [".csv", reply(200, CSV3)],
    ["/companies/", reply(200, EMPTY)],
  ]);
  const r = await fetchAll({
    nowMs: NOW,
    history: true,
    fetchImpl: f.impl,
    sleep: async () => {},
    state: { delisted: ["ZZB", "ZZC"], consecutiveFailures: 0, wikidataEnabled: false },
  });
  assert.equal(r.stats.skippedDelisted, 2);
  assert.ok(!f.calls.some((u) => u.includes("/ZZB/") || u.includes("/ZZC/")));
  assert.ok(f.calls.some((u) => u.includes("/ZZA/")));
});
