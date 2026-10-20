import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRows, extractTags, renderDoc } from "./config-reference.mjs";

function specDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfgref-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const row = (id, extra = {}) => ({
  id,
  file: "02_x.md",
  line: 1,
  tag: "[VERIFY]",
  statement: "s",
  kind: "value",
  configKey: null,
  status: "unverified",
  sourceUrl: "",
  verifiedOn: "",
  verifiedBy: "",
  note: "",
  ...extra,
});

test("extractTags numbers several tags on one line and ignores other files", () => {
  const dir = specDir({
    "02_a.md": "x [VERIFY] y [VERIFY at build]\r\nplain\n[VERIFY code]",
    "notes.txt": "[VERIFY]",
  });
  assert.deepEqual(
    extractTags(dir).map((t) => t.id),
    ["02:1#1", "02:1#2", "02:3#1"],
  );
});

test("checkRows: a tag without a row and a row without a tag both fail", () => {
  const tags = [{ id: "02:1#1", file: "02_a.md", line: 1 }];
  assert.equal(checkRows(tags, [row("02:1#1")]).length, 0);
  assert.match(checkRows(tags, [])[0], /has no row/);
  assert.match(checkRows(tags, [row("02:1#1"), row("02:9#1")])[0], /has no \[VERIFY\] tag/);
});

test("checkRows: verified needs an https source and a date; others stay blank", () => {
  const tags = [{ id: "02:1#1", file: "f", line: 1 }];
  assert.match(checkRows(tags, [row("02:1#1", { status: "verified" })])[0], /without a source/);
  const ok = row("02:1#1", {
    status: "verified",
    sourceUrl: "https://example.org/p",
    verifiedOn: "2026-10-21",
    verifiedBy: "agent",
  });
  assert.equal(checkRows(tags, [ok]).length, 0);
  assert.match(
    checkRows(tags, [row("02:1#1", { status: "owner", verifiedOn: "2026-10-21" })])[0],
    /carries a source/,
  );
  assert.match(checkRows(tags, [{ ...ok, verifiedOn: "21/10/2026" }])[0], /YYYY-MM-DD/);
});

test("checkRows: unknown config key is reported", () => {
  const tags = [{ id: "02:1#1", file: "f", line: 1 }];
  const p = checkRows(tags, [row("02:1#1", { configKey: "nope" })], new Set(["a"]));
  assert.match(p[0], /not in keys.ts/);
});

const input = () => ({
  keys: {
    zeta: { default: 1, unit: "x", editable: "B", range: [1, 3], ref: "r|1" },
    alpha: { default: { a: "b" }, unit: "", editable: "fixed", ref: "r" },
    arn011_gain_max: { default: 1, unit: "f", editable: "O", ref: "r" },
  },
  meta: { zeta: { bounds: "number, 1 to 3" } },
  rows: [row("02:1#1")],
  ch15: "the key zeta is in chapter 15",
});

test("renderDoc is deterministic and sorted, and marks keys missing from ch.15", () => {
  const a = renderDoc(input());
  const b = renderDoc(input());
  assert.equal(a, b);
  assert.ok(a.indexOf("`alpha`") < a.indexOf("`zeta`"));
  assert.ok(
    a.includes(
      "| `zeta` | `1` | x | Owner, within bounds (Lane B) | number, 1 to 3 | yes | r\\|1 |",
    ),
  );
  assert.ok(a.includes("| ARN-011 thresholds | `arn011_gain_max` | yes | no (proposed) |"));
  assert.ok(a.includes("| sort defaults | none | no (proposed) | no (proposed) |"));
  assert.ok(!a.includes("\r"));
});
