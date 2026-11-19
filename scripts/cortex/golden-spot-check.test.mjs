// TST-137 (D-969): the golden-set spot check. A seeded draw is stable, agreement and Cohen's kappa are right on
// a hand table, and one run record is written. Real migrated file database, no network, ids and counts only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "../../src/lib/db/migrate-core.mjs";
import { agreement, cohenKappa, drawRows, LABELS, run } from "./golden-spot-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rows = Array.from({ length: 60 }, (_, i) => ({ id: `L${String(i).padStart(3, "0")}` }));

test("the seeded draw is stable, independent of row order, and different seeds differ", () => {
  const a = drawRows(rows, 7, 20).map((r) => r.id);
  const b = drawRows([...rows].reverse(), 7, 20).map((r) => r.id);
  assert.equal(a.length, 20);
  assert.deepEqual(a, b);
  assert.deepEqual(
    drawRows(rows, 7, 20).map((r) => r.id),
    a,
  );
  assert.notDeepEqual(
    drawRows(rows, 8, 20).map((r) => r.id),
    a,
  );
  assert.equal(new Set(a).size, 20);
  assert.equal(drawRows(rows.slice(0, 5), 1, 20).length, 5, "fewer rows than n: all of them");
});

test("agreement and kappa on a hand table", () => {
  // owner vs stored: A/A x4, B/B x4, owner A stored B x1, owner B stored A x1  -> po 0.8, pe 0.5, kappa 0.6
  const pairs = [
    ...Array(4).fill(["A", "A"]),
    ...Array(4).fill(["B", "B"]),
    ["A", "B"],
    ["B", "A"],
  ];
  assert.deepEqual(agreement(pairs), { agree: 8, total: 10, pct: 80 });
  assert.equal(cohenKappa(pairs), 0.6);
  // perfect agreement with spread: kappa 1; no spread at all: n/a; chance-level: 0
  assert.equal(
    cohenKappa([
      ["A", "A"],
      ["B", "B"],
    ]),
    1,
  );
  assert.equal(
    cohenKappa([
      ["A", "A"],
      ["A", "A"],
    ]),
    null,
  );
  assert.equal(
    cohenKappa([
      ["A", "A"],
      ["A", "B"],
      ["B", "A"],
      ["B", "B"],
    ]),
    0,
  );
  assert.equal(cohenKappa([]), null);
  assert.deepEqual(agreement([]), { agree: 0, total: 0, pct: 0 });
});

async function withDb(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-golden-"));
  const file = path.join(dir, "main.db");
  const db = createClient({ url: pathToFileURL(file).href });
  await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
  for (let i = 0; i < 40; i += 1) {
    await db.execute({
      sql: `INSERT INTO label (id, execution_id, rule_version, variant, label, n, d)
            VALUES (?, ?, 'v1', 'base', ?, 10, '2026-10-01')`,
      args: [`LB${String(i).padStart(3, "0")}`, `E${i % 7}`, LABELS[i % 3]],
    });
  }
  try {
    await fn({ db, file, dir });
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file a moment; it is in the OS temp folder
    }
  }
}

test("draw -> blind table without the stored label -> answers -> agreement and one run record", async () => {
  await withDb(async ({ db, file, dir }) => {
    const lines = [];
    const out = (s) => lines.push(s);
    const tpl = path.join(dir, "answers.json");
    assert.equal(await run(["--db", file, "--seed", "3", "--template", tpl], {}, { out }), 0);
    const shown = lines.filter((l) => l.startsWith("LB"));
    assert.equal(shown.length, 20);
    assert.ok(
      shown.every((l) => l.endsWith("| ?")),
      "blind: no stored label in the table",
    );
    assert.ok(
      !lines.join("\n").includes("PASSED-BACKTEST |"),
      "the stored label is not printed beside a row",
    );
    const ids = shown.map((l) => l.split(" | ")[0]);
    // the Owner agrees with the stored label on 15 and disagrees on 5
    const stored = Object.fromEntries(
      (await db.execute("SELECT id, label FROM label")).rows.map((r) => [
        String(r.id),
        String(r.label),
      ]),
    );
    const answers = Object.fromEntries(
      ids.map((id, i) => [
        id,
        i < 15 ? stored[id] : LABELS[(LABELS.indexOf(stored[id]) + 3) % LABELS.length],
      ]),
    );
    writeFileSync(tpl, JSON.stringify(answers));
    lines.length = 0;
    const now = Date.parse("2026-11-12T01:00:00Z");
    assert.equal(
      await run(["--db", file, "--seed", "3", "--answers", tpl], {}, { out, nowMs: () => now }),
      0,
    );
    assert.match(
      lines[0],
      /agreement 75 % \(15 of 20 answered\), kappa \d\.\d{3}, unanswered 0, seed 3/,
    );
    assert.match(lines.join("\n"), /recorded golden-spot-check:2026-11-12/);
    const rr = await db.execute(
      "SELECT job, status, details_json FROM run_record WHERE job = 'golden-spot-check'",
    );
    assert.equal(rr.rows.length, 1);
    assert.equal(JSON.parse(String(rr.rows[0].details_json)).agree, 15);
    // a second run the same day writes nothing more
    lines.length = 0;
    await run(["--db", file, "--seed", "3", "--answers", tpl], {}, { out, nowMs: () => now });
    assert.match(lines.join("\n"), /already recorded/);
    assert.equal(
      (await db.execute("SELECT 1 FROM run_record WHERE job = 'golden-spot-check'")).rows.length,
      1,
    );
    assert.ok(!lines.join("\n").match(/file:|secret|token/i));
  });
});

test("an unknown label word counts as unanswered; a bad file and bad flags fail with a word", async () => {
  await withDb(async ({ file, dir }) => {
    const lines = [];
    const out = (s) => lines.push(s);
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "not json");
    assert.equal(await run(["--db", file, "--answers", bad], {}, { out }), 1);
    writeFileSync(bad, JSON.stringify({ LB000: "nonsense" }));
    lines.length = 0;
    assert.equal(
      await run(["--db", file, "--seed", "1", "--n", "5", "--answers", bad], {}, { out }),
      0,
    );
    assert.match(lines[0], /unanswered 5/);
    assert.equal(await run(["--n", "0"], {}, { out }), 2);
    assert.equal(await run([], {}, { out }), 1); // no database
  });
});

test("an empty label table says so and draws nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-golden-empty-"));
  const file = path.join(dir, "main.db");
  const db = createClient({ url: pathToFileURL(file).href });
  try {
    await migrateUp(db, await loadMigrations(path.join(root, "db", "migrations", "main")));
    const lines = [];
    assert.equal(await run(["--db", file], {}, { out: (s) => lines.push(s) }), 0);
    assert.match(lines[0], /no labels yet/);
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // see above
    }
  }
});
