// DAT-252 (D-974): the Wikidata fallback engages only after 3 failed listed-companies runs in a row AND
// with the `wikidata_asx` register row enabled. No network: a fake fetch and a fixture export.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAll, FALLBACK_AFTER_RUNS, WIKIDATA_URL } from "./fetch.mjs";
import { convert } from "../data/universe-from-wikidata.mjs";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const EMPTY = JSON.stringify({ data: { items: [] } });
const WIKI = JSON.stringify({
  results: {
    bindings: [
      {
        code: { value: "ZZA" },
        companyLabel: { value: "Zed A Ltd" },
        industryLabel: { value: "Materials" },
      },
      { code: { value: "ZZB" }, companyLabel: { value: "Zed B Ltd" } },
    ],
  },
});
const reply = (status, body = "") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => body,
});
function fake() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, accept: init.headers.accept, ua: init.headers["user-agent"] });
    if (url.includes("/markets/")) return reply(200, EMPTY);
    if (url.endsWith(".csv")) return reply(503); // the listed-companies file keeps failing
    if (url === WIKIDATA_URL) return reply(200, WIKI);
    return reply(404);
  };
  return { impl, calls };
}
const run = async (state) => {
  const f = fake();
  const r = await fetchAll({
    nowMs: NOW,
    ua: "t",
    fetchImpl: f.impl,
    sleep: async () => {},
    state,
  });
  return { r, calls: f.calls };
};
const wiki = (calls) => calls.filter((c) => c.url === WIKIDATA_URL);

test("the threshold is three runs", () => assert.equal(FALLBACK_AFTER_RUNS, 3));

test("two failed runs (stored 1 plus this one): no request to Wikidata", async () => {
  const { r, calls } = await run({ delisted: [], consecutiveFailures: 1, wikidataEnabled: true });
  assert.equal(wiki(calls).length, 0);
  assert.equal(r.stats.fallback, "off");
});

test("third failed run but the register row is disabled: no request", async () => {
  const { r, calls } = await run({ delisted: [], consecutiveFailures: 2, wikidataEnabled: false });
  assert.equal(wiki(calls).length, 0);
  assert.equal(r.stats.fallback, "disabled");
  assert.equal(r.files["companies-wikidata.csv"], undefined);
});

test("third failed run with the row enabled: exactly one request, CSV accepted", async () => {
  const { r, calls } = await run({ delisted: [], consecutiveFailures: 2, wikidataEnabled: true });
  const w = wiki(calls);
  assert.equal(w.length, 1);
  assert.equal(w[0].ua, "t");
  assert.equal(w[0].accept, "application/sparql-results+json");
  assert.equal(r.stats.fallback, "ok");
  assert.equal(r.files["companies.csv"], undefined);
  assert.equal(r.files["companies-wikidata.csv"], convert(JSON.parse(WIKI)).csv);
  assert.equal(r.stats.companies, 2);
  assert.equal(JSON.parse(r.files["fetch-status.json"]).fallback, "ok");
});

test("a healthy listed-companies run never touches Wikidata, whatever the counter says", async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes("/markets/")) return reply(200, EMPTY);
    if (url.endsWith(".csv"))
      return reply(200, 'h\n\nCompany name,ASX code,GICS industry group\n"A","ZZA","x"\n');
    return reply(404);
  };
  await fetchAll({
    nowMs: NOW,
    fetchImpl: impl,
    sleep: async () => {},
    state: { delisted: [], consecutiveFailures: 9, wikidataEnabled: true },
  });
  assert.ok(!calls.includes(WIKIDATA_URL));
});
