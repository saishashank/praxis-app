// D-194: the ASX fetch step (no secrets): pages the market feed until the window is covered, reads
// the company list, fills each company's history on request, and never retries in a loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codesOf, fetchAll } from "./fetch.mjs";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const CSV =
  'ASX listed companies as at Mon Oct 26 2026\n\nCompany name,ASX code,GICS industry group\n"ZED A LTD","ZZA","Materials"\n"ZED B LTD","ZZB","Banks"\n';
const item = (h, code = "ZZA") => ({
  symbol: code,
  date: new Date(NOW - h * 3_600_000).toISOString(),
  documentKey: `2924-0315${h}-X`,
  headline: `h${h}`,
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ua: init.headers["user-agent"] });
    const r = routes(url);
    return r === null
      ? { ok: false, status: 403, text: async () => "" }
      : { ok: true, status: 200, text: async () => r };
  };
  return { impl, calls };
}

test("codesOf reads the codes of the listed-companies file", () => {
  assert.deepEqual(codesOf(CSV), ["ZZA", "ZZB"]);
});

test("pages the market feed until the 48 h window is covered, then the company list", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("page=0")) return JSON.stringify({ data: { items: [item(1), item(20)] } });
    if (url.includes("page=1")) return JSON.stringify({ data: { items: [item(30), item(60)] } });
    if (url.endsWith(".csv")) return CSV;
    return null;
  });
  const r = await fetchAll({
    nowMs: NOW,
    ua: "test-agent",
    fetchImpl: f.impl,
    sleep: async () => {},
  });
  assert.equal(r.stats.feedItems, 4);
  assert.equal(r.stats.companies, 2);
  assert.equal(r.stats.failed, 0);
  assert.ok(
    !f.calls.some((c) => c.url.includes("page=2")),
    "stops once the oldest item is past the window",
  );
  assert.ok(f.calls.every((c) => c.ua === "test-agent"));
  assert.equal(JSON.parse(r.files["feed.json"]).data.items.length, 4);
  assert.equal(r.files["history.json"], undefined);
});

test("with history, each company's list is fetched and tagged with its code; a refusal is counted", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/markets/")) return JSON.stringify({ data: { items: [] } });
    if (url.endsWith(".csv")) return CSV;
    if (url.includes("/companies/ZZA/"))
      return JSON.stringify({
        data: {
          symbol: "ZZA",
          items: [{ documentKey: "2924-031-A", date: "2026-10-20T00:00:00Z", headline: "x" }],
        },
      });
    return null; // ZZB refused
  });
  const r = await fetchAll({ nowMs: NOW, history: true, fetchImpl: f.impl, sleep: async () => {} });
  assert.equal(r.stats.historyItems, 1);
  assert.equal(r.stats.failed, 1);
  assert.equal(JSON.parse(r.files["history.json"]).data.items[0].symbol, "ZZA");
});
