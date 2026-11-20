import assert from "node:assert/strict";
import { test } from "node:test";
import { analyse, countSyllables, gradeOf, report, stripExcluded } from "./readability.mjs";

test("countSyllables on common words", () => {
  const cases = { cat: 1, table: 2, strategy: 3, simulated: 3, make: 1, boxes: 2, reading: 2 };
  for (const [w, n] of Object.entries(cases)) assert.equal(countSyllables(w), n, w);
});

test("gradeOf: plain text is low, dense text is high", () => {
  assert.ok(gradeOf(["The cat sat on the mat."]).grade < 2);
  const hard =
    "Notwithstanding considerable methodological heterogeneity, interdisciplinary investigations demonstrate statistically significant correlations.";
  assert.ok(gradeOf([hard]).grade > 14);
  assert.equal(gradeOf([]).grade, 0);
});

test("stripExcluded removes glossary terms (whole words) and number tokens", () => {
  assert.equal(
    stripExcluded("Net asset value A$1,200 now", ["net asset value"]).trim(),
    "A$1,200 now".replace("A$1,200 ", "").trim(),
  );
  assert.equal(stripExcluded("Cohorts and Cohort", ["Cohort"]).trim(), "Cohorts and");
  assert.equal(stripExcluded("Up 12.5% today", []), "Up today");
});

const SIMPLE = {
  path: "/",
  items: [
    { kind: "heading", text: "Today" },
    { kind: "button", text: "Save changes" },
  ],
};

test("analyse: simple copy passes", () => {
  const r = analyse([SIMPLE]);
  assert.deepEqual(r.failures, []);
  assert.equal(r.summary.length, 2);
});

const HARD =
  "Notwithstanding considerable methodological heterogeneity, interdisciplinary investigations demonstrate statistically significant correlations.";

test("analyse: a hard summary fails as an item; a hard group of 12+ words fails as a group", () => {
  const r = analyse([{ path: "/x", items: [{ kind: "summary", text: HARD }] }]);
  assert.ok(r.failures.some((f) => f.text === HARD));
  const group = analyse([
    {
      path: "/y",
      items: [
        { kind: "label", text: "Methodological heterogeneity" },
        { kind: "label", text: "Interdisciplinary investigations" },
        { kind: "label", text: "Statistically significant correlations" },
        { kind: "label", text: "Considerable heterogeneity" },
        { kind: "label", text: "Interdisciplinary methodological correlations" },
      ],
    },
  ]);
  assert.ok(group.failures.some((f) => f.kind === "label" && !f.text));
  assert.match(report(r), /FAIL \/x summary/);
});

test("analyse: glossary terms and numbers are excluded", () => {
  const text = HARD + " 42 items";
  const bad = analyse([{ path: "/x", items: [{ kind: "label", text }] }]);
  assert.ok(bad.failures.length > 0);
  const ok = analyse([{ path: "/x", items: [{ kind: "label", text }] }], {
    terms: [HARD.replace(/[.]$/, "")],
  });
  assert.deepEqual(ok.failures, []);
});

test("analyse: exceptions drop an exact text, optionally per page, and are reported", () => {
  const pages = [{ path: "/x", items: [{ kind: "summary", text: HARD }] }];
  const scoped = analyse(pages, { exceptions: [{ page: "/other", text: HARD }] });
  assert.ok(scoped.failures.length > 0);
  const r = analyse(pages, { exceptions: [{ page: "/x", text: HARD }] });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.applied, [HARD]);
  assert.match(report(r), /Exceptions in use/);
});

test("the Portfolio page passes with the repo's exceptions: only the three profile names are dropped (D-1852)", async () => {
  const fs = await import("node:fs");
  const { exceptions } = JSON.parse(
    fs.readFileSync(new URL("../../e2e/readability-exceptions.json", import.meta.url), "utf8"),
  );
  // The /portfolio items the CI e2e collected on 20 Nov (heading group graded 15.6).
  const items = [
    ["heading", "My portfolio"],
    ["heading", "Aggressive"],
    ["heading", "Balanced"],
    ["heading", "Conservative"],
    ["button", "Account and settings menu"],
    ["button", "Region: Australia (ASX)"],
  ].map(([kind, text]) => ({ kind, text }));
  const pages = [{ path: "/portfolio", items }];
  assert.equal(analyse(pages).failures.length, 1, "without exceptions the page fails");
  const r = analyse(pages, { exceptions });
  assert.deepEqual(r.failures, []);
  assert.deepEqual([...r.applied].sort(), ["Aggressive", "Balanced", "Conservative"]);
  // Page-scoped: the same words elsewhere are still graded.
  assert.ok(exceptions.every((e) => e.page === "/portfolio"));
});
