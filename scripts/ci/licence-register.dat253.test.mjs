// DAT-253 (D-975) and DAT-251 c / DAT-252 (D-973, D-974): the register document lists the two new
// pending rows, and the RBA / ABS / Wikidata entries name the code that fetches them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, loadSeed, SOURCE_FACTS } from "./licence-register.mjs";

test("asic_documents and ssrn_papers are seeded pending and appear in the document", () => {
  const rows = loadSeed();
  for (const id of ["asic_documents", "ssrn_papers"]) {
    const r = rows.find((x) => x.source === id);
    assert.ok(r, id);
    assert.equal(r.status, "pending");
  }
  const doc = build();
  assert.match(doc, /\| `asic_documents` \|/);
  assert.match(doc, /\| `ssrn_papers` \|/);
});

test("rba, abs and wikidata_asx name their fetching code and host", () => {
  assert.deepEqual(SOURCE_FACTS.rba.code, ["scripts/macro/rba.mjs"]);
  assert.deepEqual(SOURCE_FACTS.abs.code, ["scripts/macro/abs.mjs"]);
  assert.ok(SOURCE_FACTS.wikidata_asx.code.includes("scripts/asx/fetch.mjs"));
  assert.deepEqual(SOURCE_FACTS.wikidata_asx.hosts, ["query.wikidata.org"]);
  const wiki = loadSeed().find((r) => r.source === "wikidata_asx");
  assert.equal(wiki.status, "disabled", "the fallback stays off until the Owner accepts it");
});
