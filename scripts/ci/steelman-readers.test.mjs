// OPS-111 (9), D-977: the steelman reader list comes from the import graph; a planted reader appears and the
// stored list is current.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MANIFEST, readers, render, ROOT, specifiers } from "./steelman-readers.mjs";

test("specifiers finds import, export-from, dynamic import and require", () => {
  const src =
    'import a from "@/lib/steelman/x";\nexport { b } from "@/lib/steelman/y";\nconst c = await import("@/lib/steelman/z");\nconst d = require("w");';
  assert.deepEqual(specifiers(src), [
    "@/lib/steelman/x",
    "@/lib/steelman/y",
    "@/lib/steelman/z",
    "w",
  ]);
});

test("a planted file that imports a steelman module is a reader; one that does not is not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-readers-"));
  try {
    fs.mkdirSync(path.join(dir, "src/lib/steelman"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src/lib/arena"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src/lib/steelman/inner.ts"),
      'import "@/lib/steelman/other";\n',
    );
    fs.writeFileSync(
      path.join(dir, "src/lib/arena/bad.ts"),
      'import { x } from "@/lib/steelman/store";\n',
    );
    fs.writeFileSync(
      path.join(dir, "src/lib/arena/fine.ts"),
      'import { y } from "@/lib/money/rational";\n',
    );
    assert.deepEqual(readers(dir), ["src/lib/arena/bad.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored list equals the live graph", () => {
  const stored = fs.readFileSync(path.join(ROOT, MANIFEST), "utf8");
  assert.equal(stored, render(readers()));
});
