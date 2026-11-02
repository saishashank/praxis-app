import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, duplicates, main, oneLine, render } from "./decision-index.mjs";

test("oneLine keeps balanced quotes and brackets and caps the length", () => {
  const t = oneLine(
    'The header shows the logo with its tagline ("Learn. Earn. Repeat.", file) at the request. More.',
  );
  assert.match(t, /Repeat\.", file\) at the request\.$/);
  assert.ok(oneLine("x ".repeat(200)).length <= 160);
});

test("every duplicate id is reported, with no exception list (R4-I1)", () => {
  const rows = [
    { n: 900, file: "a", milestone: "a", text: "" },
    { n: 900, file: "b", milestone: "b", text: "" },
    { n: 377, file: "a", milestone: "a", text: "" },
    { n: 377, file: "b", milestone: "b", text: "" },
    { n: 378, file: "a", milestone: "a", text: "" },
  ];
  assert.deepEqual(duplicates(rows), [377, 900]);
});

test("the repository index covers the V2 decisions and is current", () => {
  const rows = collect();
  assert.deepEqual(duplicates(rows), []);
  const ids = new Set(rows.map((r) => r.n));
  for (const n of [703, 764, 790]) assert.ok(ids.has(n), `D-${n}`);
  assert.ok(render(rows).includes("| D-764 |"));
  assert.equal(main(["--check"]), 0);
});
