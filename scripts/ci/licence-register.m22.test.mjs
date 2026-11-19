// M22 A1 (D-1439, D-1443, D-1444): the three pending register rows (the two prediction-market sources of DAT-248 and the
// batch delayed-quote endpoint of AGT-147) are defined in code, listed in the generated document with terms [VERIFY],
// and written by no migration (the AT-32 baseline hashes the register tables, D-1128).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  build,
  declaredPendingSources,
  loadSeed,
  PENDING_SOURCE_ROWS,
} from "./licence-register.mjs";

const IDS = ["polymarket_public", "kalshi_public", "yahoo_delayed_batch"];

test("the three rows are pending, off, [VERIFY], with no fetcher and no host yet", () => {
  assert.deepEqual(
    PENDING_SOURCE_ROWS.map((r) => r.id),
    IDS,
  );
  for (const r of PENDING_SOURCE_ROWS) {
    assert.equal(r.status, "pending", r.id);
    assert.equal(r.source_status, "off", r.id);
    assert.equal(r.summarisation_permitted, 0, r.id);
    assert.match(r.terms, /\[VERIFY\]/, r.id);
    assert.deepEqual(r.code, [], `${r.id} has no fetcher yet`);
    assert.deepEqual(r.hosts, [], `${r.id} names no host yet`);
    assert.equal(r.last_checked, null, r.id);
  }
});

test("the ids are declared in schema.ts and no migration inserts them", () => {
  assert.deepEqual([...declaredPendingSources()].sort(), [...IDS].sort());
  const seeded = loadSeed().map((r) => r.source);
  for (const id of IDS) assert.ok(!seeded.includes(id), `${id} is not a migration row`);
  for (const f of fs.readdirSync("db/migrations/main")) {
    const sql = fs.readFileSync(`db/migrations/main/${f}`, "utf8");
    for (const id of IDS) assert.ok(!sql.includes(id), `${f} must not name ${id}`);
  }
});

test("the document lists the rows in their own section", () => {
  const doc = build();
  assert.match(doc, /## Pending sources for the LLM and expert milestone/);
  for (const id of IDS) assert.match(doc, new RegExp(`\| \`${id}\` \|`), id);
  assert.match(doc, /\| `yahoo_delayed_batch` \| .*pending Owner \(O-26\)/);
  assert.equal(
    fs.readFileSync("docs/source-licence-register.md", "utf8"),
    doc,
    "the document is current",
  );
});
