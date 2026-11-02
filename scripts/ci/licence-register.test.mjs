import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DOC_PATH,
  ROOT,
  SOURCE_FACTS,
  build,
  declaredSources,
  loadSeed,
  main,
  parseRegisterInserts,
  parseTuple,
  render,
} from "./licence-register.mjs";

test("parseTuple reads quoted text with escapes, NULL and numbers", () => {
  assert.deepEqual(parseTuple("'a, b', NULL, 1, 'it''s', 0"), ["a, b", null, 1, "it's", 0]);
});

test("parseRegisterInserts reads the up part only and ignores comments", () => {
  const sql = [
    "-- +up",
    "-- INSERT INTO source_register (source) VALUES ('commented');",
    "INSERT INTO source_register (source, risk, status)",
    "VALUES ('a', 'low', 'enabled'), ('b', 'high', 'pending');",
    "-- +down",
    "INSERT INTO source_register (source, risk, status) VALUES ('down', 'low', 'enabled');",
  ].join("\n");
  assert.deepEqual(
    parseRegisterInserts(sql).map((r) => r.source),
    ["a", "b"],
  );
});

test("the seed lists exactly the sources the code declares, and each has facts and real code files", () => {
  const rows = loadSeed();
  const ids = rows.map((r) => r.source).sort();
  assert.deepEqual(ids, [...declaredSources()].sort());
  assert.deepEqual(ids, Object.keys(SOURCE_FACTS).sort());
  for (const f of Object.values(SOURCE_FACTS)) {
    for (const c of f.code) assert.ok(fs.existsSync(path.join(ROOT, c)), c);
  }
});

test("every source is in the document with its status, and ASX acceptance is pending Owner", () => {
  const doc = build();
  for (const r of loadSeed()) {
    assert.ok(doc.includes(`\`${r.source}\``), r.source);
  }
  const asx = doc.split("\n").find((l) => l.startsWith("| `asx_announcements`"));
  assert.match(asx, /pending Owner \(O-23\)/);
  assert.match(asx, /\| high \| pending \|/);
  assert.match(doc, /ASX announcements \(O-23\): the risk acceptance date is pending Owner/);
  const rba = doc.split("\n").find((l) => l.startsWith("| `rba`"));
  assert.match(rba, /not needed/);
});

test("the document is deterministic and holds no person, email or secret-like text", () => {
  const a = build();
  assert.equal(a, build());
  assert.doesNotMatch(a, /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(a, /\b[0-9a-f]{32,}\b/i);
  assert.doesNotMatch(a, /\b\d{4}-\d{2}-\d{2}\b/);
});

test("a registered source without facts fails the build", () => {
  assert.throws(
    () => render([{ source: "new_source", risk: "low", status: "enabled", permitted_use: "x" }]),
    /no SOURCE_FACTS entry for registered source new_source/,
  );
});

function fakeRoot(extra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licreg-"));
  const real = loadSeed();
  fs.mkdirSync(path.join(dir, "db/migrations/main"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src/lib/data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  const values = real
    .map(
      (r) =>
        `('${r.source}', '${r.permitted_use}', '${r.risk}', '${r.status}', ${r.owner_ref ? `'${r.owner_ref}'` : "NULL"}, ${r.summarisation_permitted})`,
    )
    .join(",\n");
  fs.writeFileSync(
    path.join(dir, "db/migrations/main/0001_x.sql"),
    `-- +up\nINSERT INTO source_register (source, permitted_use, risk, status, owner_ref, summarisation_permitted) VALUES ${values};\n${extra}\n-- +down\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src/lib/data/schema.ts"),
    'export const AU_SOURCES = ["asx_announcements", "yahoo_eod", "rba", "abs", "asic_short"] as const;\nexport const UNIVERSE_SOURCE = "asx_listed_companies";\n',
  );
  return dir;
}

test("--check passes on a fresh document, fails when it is stale or missing, and plain run writes it", () => {
  const dir = fakeRoot();
  const lines = [];
  const out = (s) => lines.push(s);
  assert.equal(main(["--check"], dir, out), 1, "missing document is stale");
  assert.equal(main([], dir, out), 0);
  assert.equal(main(["--check"], dir, out), 0);
  const file = path.join(dir, DOC_PATH);
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\nextra`);
  assert.equal(main(["--check"], dir, out), 1);
  assert.match(lines.at(-1), /stale/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a source declared in code but missing from the seed fails", () => {
  const dir = fakeRoot();
  fs.appendFileSync(path.join(dir, "src/lib/data/schema.ts"), "export const EXTRA = 1;\n");
  const schema = path.join(dir, "src/lib/data/schema.ts");
  fs.writeFileSync(
    schema,
    fs.readFileSync(schema, "utf8").replace('"asic_short"', '"asic_short", "brand_new"'),
  );
  const lines = [];
  assert.equal(
    main(["--check"], dir, (s) => lines.push(s)),
    1,
  );
  assert.match(lines.at(-1), /brand_new/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the committed document is up to date", () => {
  const lines = [];
  assert.equal(
    main(["--check"], ROOT, (s) => lines.push(s)),
    0,
    lines.join("\n"),
  );
});

test("0018 UPDATEs show in the document: the ASX listed-companies file cites O-23b (DAT-236)", () => {
  const doc = build();
  const asx = doc.split("\n").find((l) => l.startsWith("| `asx_listed_companies`"));
  assert.match(asx, /\| O-23b \| pending Owner \(O-23b\) \|/);
  assert.match(asx, /under its own terms \(O-23b\)/);
  const rba = doc.split("\n").find((l) => l.startsWith("| `rba`"));
  assert.match(rba, /copyrighted by the RBA/);
  assert.match(doc, /Wikidata structured data is CC0/);
  assert.match(doc, /CC BY-SA 4\.0/);
});
