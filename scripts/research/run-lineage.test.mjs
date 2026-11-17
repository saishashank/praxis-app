// M23 R2 (D-1629, D-1630, D-1688): the CXA-003 runner on a synthetic ZZ history folder. A second run of the same lineage is
// refused, a history or output folder inside the repository is refused, a lineage without a plan entry is refused, the
// runner makes no network call, and nothing it writes carries a code. Synthetic folders only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "./run-lineage.mjs";

const DAY = 86_400;
const STAMPS = [];
for (let d = 0; STAMPS.length < 760; d += 1) {
  const ts = Date.UTC(2020, 0, 1) / 1000 + d * DAY;
  const dow = new Date(ts * 1000).getUTCDay();
  if (dow !== 0 && dow !== 6) STAMPS.push(ts);
}
const sha = (t) => createHash("sha256").update(t).digest("hex");
const CODES = Array.from({ length: 12 }, (_, i) => `ZZ${String.fromCharCode(65 + i)}`);

function bars(amp, phase) {
  const close = STAMPS.map((_, i) => 10 + amp * Math.sin(i * 1.7 + phase));
  return {
    tz: "UTC",
    timestamps: STAMPS,
    open: close,
    low: close.map((c) => c * 0.99),
    close,
    volume: STAMPS.map(() => 500_000),
    splits: {},
  };
}

const PLAN = {
  item: "CXA-003",
  market: "ZZ",
  common: {
    costProfile: "P6",
    parcelMicro: "600000000",
    bootstrap: { replicates: 200 },
    floors: { setups: 5, blocks: 3 },
    split: { developmentTo: "2021-12-31", holdoutFrom: "2022-01-01" },
  },
  lineages: [
    { id: "cxa003_hi52_vol", hypothesis: "h1", hold: 60, matchOn: ["tier", "volDecile"] },
    { id: "cxa003_lowvol", hypothesis: "h2", hold: 21, matchOn: ["tier"] },
    { id: "cxa003_short_cover", hypothesis: "h3", hold: 20, matchOn: ["tier", "volDecile"] },
    { id: "cxa003_earnings_drift", hypothesis: "h4", history: "none" },
  ],
  variants: ["cxa003_hi52_vol", "cxa003_lowvol", "cxa003_short_cover"].map((of) => ({
    id: `${of}_p5000`,
    of,
    parcelMicro: "5000000000",
    label: "Larger account, not your book",
  })),
};

function world() {
  const base = mkdtempSync(path.join(tmpdir(), "run-lineage-"));
  const root = path.join(base, "repo");
  const history = path.join(base, "history");
  const out = path.join(base, "out");
  mkdirSync(path.join(root, "docs", "research", "prereg"), { recursive: true });
  mkdirSync(path.join(history, "yahoo"), { recursive: true });
  mkdirSync(path.join(history, "asic"), { recursive: true });
  writeFileSync(
    path.join(history, "yahoo", "_IDX.json"),
    JSON.stringify({ tz: "UTC", timestamps: STAMPS, close: STAMPS.map(() => 1) }),
  );
  CODES.forEach((c, i) =>
    writeFileSync(
      path.join(history, "yahoo", `${c}.json`),
      JSON.stringify(bars(0.05 + i * 0.05, i)),
    ),
  );
  const planText = `${JSON.stringify(PLAN)}\n`;
  writeFileSync(path.join(root, "docs", "research", "prereg", "CXA-003.json"), planText);
  const entries = [...PLAN.lineages.map((l) => l.id), ...PLAN.variants.map((v) => v.id)].map(
    (id, i) => ({
      seq: i + 1,
      item: "CXA-003",
      lineage: id,
      market: "ZZ",
      sha: sha(planText),
      preregPath: "docs/research/prereg/CXA-003.json",
    }),
  );
  writeFileSync(
    path.join(root, "docs", "research", "registry.json"),
    JSON.stringify({ format: 1, entries }, null, 2),
  );
  return { base, root, history, out };
}

const quiet = { log: () => {} };
const argsOf = (w, lineage, over = {}) => [
  "--history",
  over.history ?? w.history,
  "--prereg",
  "docs/research/prereg/CXA-003.json",
  "--lineage",
  lineage,
  "--out",
  over.out ?? w.out,
  "--calendar",
  "yahoo/_IDX.json",
  "--root",
  w.root,
  "--allow-dirty",
];

test("a run takes one look for each lineage that meets its floors, none for the others, and writes no code", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("no network in the runner");
  };
  const w = world();
  try {
    const lines = [];
    await run(argsOf(w, "all"), { log: (t) => lines.push(t) });
    const ledger = JSON.parse(
      readFileSync(path.join(w.root, "docs", "research", "registry.json"), "utf8"),
    );
    const looks = ledger.entries.filter((e) => e.verdict !== undefined);
    assert.deepEqual(
      looks.map((e) => e.lineage),
      ["cxa003_lowvol", "cxa003_lowvol_p5000"],
    );
    assert.ok(["PASS", "NULL", "INCONCLUSIVE"].includes(looks[0].verdict));
    assert.equal(looks[1].note, "Larger account, not your book");
    assert.equal(ledger.entries.length, 7 + 2); // the plan entries are never edited, the looks are appended
    assert.ok(lines.some((l) => l.startsWith("cxa003_lowvol development")));
    assert.ok(
      lines.findIndex((l) => l.includes("development")) <
        lines.findIndex((l) => l.includes("HOLDOUT LOOK")),
    );
    assert.ok(
      lines.findIndex((l) => l.includes("HOLDOUT LOOK")) <
        lines.findIndex((l) => l.includes("full window")),
    );
    // report inputs: three lineages with a variant each and one without history
    const files = readdirSync(w.out).sort();
    assert.ok(files.includes("cxa003_earnings_drift.report.json"));
    const none = JSON.parse(
      readFileSync(path.join(w.out, "cxa003_earnings_drift.report.json"), "utf8"),
    );
    assert.equal(none.verdict, "INCONCLUSIVE");
    const hi = JSON.parse(readFileSync(path.join(w.out, "cxa003_hi52_vol.report.json"), "utf8"));
    assert.equal(hi.verdict, "INCONCLUSIVE");
    const variant = JSON.parse(
      readFileSync(path.join(w.out, "cxa003_lowvol_p5000.report.json"), "utf8"),
    );
    assert.equal(variant.statistic.variantLabel, "Larger account, not your book");
    for (const f of files) {
      const text = readFileSync(path.join(w.out, f), "utf8");
      assert.ok(!/ZZ[A-L]\b/.test(text), `${f} carries a code`);
    }
    assert.ok(!lines.some((l) => /ZZ[A-L]\b/.test(l)));
  } finally {
    globalThis.fetch = realFetch;
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("a second run of the same lineage is refused", async () => {
  const w = world();
  try {
    await run(argsOf(w, "cxa003_lowvol"), quiet);
    await assert.rejects(() => run(argsOf(w, "cxa003_lowvol"), quiet), /second look/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("a history or output folder inside the repository is refused", async () => {
  const w = world();
  try {
    await assert.rejects(
      () => run(argsOf(w, "all", { history: path.join(w.root, "docs") }), quiet),
      /history folder/,
    );
    await assert.rejects(
      () => run(argsOf(w, "all", { out: path.join(w.root, "docs", "x") }), quiet),
      /output folder/,
    );
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("a lineage without a plan entry for the hash of the plan file is refused", async () => {
  const w = world();
  try {
    const p = path.join(w.root, "docs", "research", "registry.json");
    const ledger = JSON.parse(readFileSync(p, "utf8"));
    ledger.entries = ledger.entries.map((e) => ({ ...e, sha: sha("another plan") }));
    writeFileSync(p, JSON.stringify(ledger));
    await assert.rejects(() => run(argsOf(w, "cxa003_lowvol"), quiet), /no plan entry/);
    await assert.rejects(() => run(argsOf(w, "cxa003_unknown"), quiet), /not in the plan/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("--no-look stops after the counts and the development figures: no ledger entry, no output", async () => {
  const w = world();
  try {
    const p = path.join(w.root, "docs", "research", "registry.json");
    const before = readFileSync(p, "utf8");
    const lines = [];
    await run([...argsOf(w, "all"), "--no-look"], { log: (t) => lines.push(t) });
    assert.equal(readFileSync(p, "utf8"), before);
    assert.ok(lines.some((l) => l.includes("development")));
    assert.ok(!lines.some((l) => l.includes("HOLDOUT LOOK")));
    assert.throws(() => readdirSync(w.out));
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

// --- CXA-009 sector_ic mode (M23 R3; D-1714) on a synthetic ZZ folder ---------------------------------------------------
const SEC_PLAN = (months) => ({
  item: "CXA-009",
  market: "ZZ",
  lineages: [{ id: "sector_ic", hypothesis: "h" }],
  bootstrap: { block_months: 3, replicates: 200, seed: "20261018", alpha: 0.1 },
  floors: { months, groups_min_members: 3, groups_per_month: 4 },
});

function sectorWorld(months) {
  const w = world();
  const planText = `${JSON.stringify(SEC_PLAN(months))}\n`;
  writeFileSync(path.join(w.root, "docs", "research", "prereg", "CXA-009.json"), planText);
  writeFileSync(
    path.join(w.root, "docs", "research", "registry.json"),
    JSON.stringify(
      {
        format: 1,
        entries: [
          {
            seq: 1,
            item: "CXA-009",
            lineage: "sector_ic",
            market: "ZZ",
            sha: sha(planText),
            preregPath: "docs/research/prereg/CXA-009.json",
          },
        ],
      },
      null,
      2,
    ),
  );
  mkdirSync(path.join(w.history, "meta"), { recursive: true });
  writeFileSync(
    path.join(w.history, "meta", "asx_listed_2030-01-01.json"),
    JSON.stringify({
      as_of: "2030-01-01",
      rows: CODES.map((code, i) => ({ code, industry: `Group ${Math.floor(i / 3)}` })),
    }),
  );
  return w;
}

const secArgs = (w, over = {}) => [
  "--history",
  over.history ?? w.history,
  "--prereg",
  "docs/research/prereg/CXA-009.json",
  "--lineage",
  "sector_ic",
  "--out",
  over.out ?? w.out,
  "--calendar",
  "yahoo/_IDX.json",
  "--root",
  w.root,
  "--allow-dirty",
];

test("sector_ic below its month floor is INCONCLUSIVE: no ledger entry, a report input, no code written", async () => {
  const w = sectorWorld(95);
  try {
    const p = path.join(w.root, "docs", "research", "registry.json");
    const before = readFileSync(p, "utf8");
    const lines = [];
    await run(secArgs(w), { log: (t) => lines.push(t) });
    assert.equal(readFileSync(p, "utf8"), before);
    const rep = JSON.parse(readFileSync(path.join(w.out, "sector_ic.report.json"), "utf8"));
    assert.equal(rep.verdict, "INCONCLUSIVE");
    assert.equal(rep.n.floorMet, false);
    assert.ok(lines.some((l) => l.includes("no look was spent")));
    assert.ok(!/ZZ[A-L]\b/.test(readFileSync(path.join(w.out, "sector_ic.report.json"), "utf8")));
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("sector_ic with the floor met takes one look, appends it, and a second run is refused", async () => {
  const w = sectorWorld(5);
  try {
    const lines = [];
    await run(secArgs(w), { log: (t) => lines.push(t) });
    const ledger = JSON.parse(
      readFileSync(path.join(w.root, "docs", "research", "registry.json"), "utf8"),
    );
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[1].seq, 2);
    assert.equal(ledger.entries[1].lineage, "sector_ic");
    assert.ok(["PASS", "NULL", "INCONCLUSIVE"].includes(ledger.entries[1].verdict));
    assert.ok(ledger.entries[1].nBlocks >= 5);
    assert.ok(lines.some((l) => l.includes("sector_ic LOOK")));
    const rep = JSON.parse(readFileSync(path.join(w.out, "sector_ic.report.json"), "utf8"));
    assert.equal(rep.result.rows.length, 3);
    await assert.rejects(() => run(secArgs(w), quiet), /second look/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test("sector_ic --no-look counts only: nothing written; folders inside the repository are refused", async () => {
  const w = sectorWorld(5);
  try {
    const p = path.join(w.root, "docs", "research", "registry.json");
    const before = readFileSync(p, "utf8");
    const lines = [];
    await run([...secArgs(w), "--no-look"], { log: (t) => lines.push(t) });
    assert.equal(readFileSync(p, "utf8"), before);
    assert.ok(lines.some((l) => l.includes("qualifying monthly blocks")));
    assert.throws(() => readdirSync(w.out));
    await assert.rejects(
      () => run(secArgs(w, { history: path.join(w.root, "docs") }), quiet),
      /history folder/,
    );
    await assert.rejects(
      () => run(secArgs(w, { out: path.join(w.root, "docs", "x") }), quiet),
      /output folder/,
    );
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});
