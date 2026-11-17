// CXA-003 runner (M23 R2; D-1629, D-1630, D-1685 to D-1688). Offline, no network, no database:
//   node scripts/research/run-lineage.mjs --history <folder> --prereg docs/research/prereg/CXA-003.json
//        --lineage <cxa003_... | all> --out <folder outside the repository> --calendar <index file, relative to the history folder>
//        [--bars-dir yahoo] [--shorts-dir asic] [--ledger docs/research/registry.json] [--root <repo>] [--allow-dirty] [--no-look]
// The history folder and the output folder must lie OUTSIDE the repository (SEC-110). The run refuses a lineage that has no
// plan entry with the hash of the committed plan file, and a lineage whose look is already in the ledger. Order of work
// (BLD-051, D-1687): entries and floors for every lineage, development figures, the one holdout look per lineage and its
// larger-parcel variant (each appended to the ledger the moment it is taken), then the full-window figures, which decide
// nothing. It prints counts and aggregate figures only; per-setup rows and codes are never printed or written.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../arena/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_IDS = ["cxa003_hi52_vol", "cxa003_lowvol", "cxa003_short_cover"];
const KEY_OF = {
  cxa003_hi52_vol: "hi52_vol",
  cxa003_lowvol: "lowvol",
  cxa003_short_cover: "short_cover",
};
const STR_ARGS = [
  "history",
  "prereg",
  "lineage",
  "out",
  "calendar",
  "bars-dir",
  "shorts-dir",
  "ledger",
  "root",
  "now",
];

export function parseArgs(argv) {
  const out = { allowDirty: false, noLook: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--no-look") out.noLook = true;
    else if (a.startsWith("--") && STR_ARGS.includes(a.slice(2))) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ["history", "prereg", "lineage", "out", "calendar"])
    if (out[k] === undefined) throw new Error(`--${k} is required`);
  return out;
}

const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const posix = (p) => p.split(path.sep).join("/");

/** True when `target` is the repository root or lies inside it. */
export function insideRepo(target, root = ROOT) {
  const rel = path.relative(root, path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Where the plan and the runner stand in git: the plan commit must be an ancestor of HEAD and nothing may be dirty. */
function provenance(root, preregRel, allowDirty) {
  if (allowDirty) return { runnerCommit: "test", preregCommit: "test", preregDate: "test" };
  const dirty = git(
    ["status", "--porcelain", "--", "src", "scripts", "docs/research", "tests"],
    root,
  );
  if (dirty !== "")
    throw new Error(
      "the working tree has uncommitted changes under src, scripts, tests or docs/research",
    );
  const head = git(["rev-parse", "HEAD"], root);
  const [commit, date] = git(["log", "-1", "--format=%H %cs", "--", preregRel], root).split(" ");
  if (!commit) throw new Error("the plan file is not committed");
  git(["merge-base", "--is-ancestor", commit, head], root); // throws when it is not an ancestor
  return { runnerCommit: head.slice(0, 12), preregCommit: commit.slice(0, 12), preregDate: date };
}

function appendLedger(ledgerPath, lib, entry) {
  const ledger = lib.parseLedger(readFileSync(ledgerPath, "utf8"));
  const next = {
    format: 1,
    entries: [...ledger.entries, { ...entry, seq: ledger.entries.length + 1 }],
  };
  writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function loadHistory(args, lib) {
  const bars = path.join(args.history, args["bars-dir"] ?? "yahoo");
  const shortsDir = path.join(args.history, args["shorts-dir"] ?? "asic");
  const calendarFile = JSON.parse(readFileSync(path.join(args.history, args.calendar), "utf8"));
  const dates = lib.sessionsFromIndexFile(calendarFile);
  const sessionOf = new Map(dates.map((d, i) => [d, i]));
  const series = new Map();
  let files = 0;
  for (const name of readdirSync(bars).sort()) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    const code = name.slice(0, -5);
    if (!/^[A-Za-z0-9]{2,6}$/.test(code)) continue;
    files += 1;
    const s = lib.parseSeries(
      code,
      JSON.parse(readFileSync(path.join(bars, name), "utf8")),
      sessionOf,
      dates.length,
    );
    if (s !== null) series.set(code, s);
  }
  const shorts = new Map();
  let reports = 0;
  if (existsSync(shortsDir)) {
    for (const name of readdirSync(shortsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const j = JSON.parse(readFileSync(path.join(shortsDir, name), "utf8"));
      for (const m of j.months ?? []) {
        for (const r of m.rows ?? []) {
          if (typeof r.pct_short !== "number" || !Number.isFinite(r.pct_short)) continue;
          if (typeof r.published_at !== "string" || typeof r.as_of !== "string") continue;
          if (!series.has(r.code)) continue; // a code with no bars can never be a setup
          let list = shorts.get(r.code);
          if (list === undefined) shorts.set(r.code, (list = []));
          list.push({ asOf: r.as_of, pct: r.pct_short, published: r.published_at.slice(0, 10) });
          reports += 1;
        }
      }
    }
  }
  // oldest first; a repeated report date keeps the later row
  for (const [code, list] of shorts) {
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
    const kept = [];
    for (const r of list) {
      if (kept.length > 0 && kept[kept.length - 1].asOf === r.asOf) kept[kept.length - 1] = r;
      else kept.push(r);
    }
    shorts.set(code, kept);
  }
  return { world: { dates, series }, shorts, files, reports };
}

const fmt = (v) => (v === null || v === undefined ? "n/a" : Math.round(v * 100) / 100);

/** One window's figure as a short aggregate line. */
function line(tag, f) {
  if (f.status === "below_sample") return `${tag}: below sample (${f.reason})`;
  const w = f.withHaircut;
  return `${tag}: ${f.verdict} n=${w.n} blocks=${f.counts.blocks} mean=${fmt(w.meanPpm)} ppm lower=${fmt(w.lowerPpm)} ppm (alpha ${fmt(w.alpha)})`;
}

function resultRow(window, f) {
  if (f.status === "below_sample") return { window, mean: null, lower: null, n: 0 };
  return { window, mean: f.withHaircut.meanPpm, lower: f.withHaircut.lowerPpm, n: f.withHaircut.n };
}

const noHaircutText = (figs) =>
  Object.entries(figs)
    .map(([w, f]) =>
      f.status === "looked"
        ? `${w} mean ${fmt(f.withoutHaircut.meanPpm)} ppm (lower ${fmt(f.withoutHaircut.lowerPpm)})`
        : `${w} below sample`,
    )
    .join("; ");

export async function run(argv, io = { log: (t) => console.log(t) }) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root ?? ROOT);
  const history = path.resolve(args.history);
  const outDir = path.resolve(args.out);
  if (insideRepo(history, root))
    throw new Error("the history folder must lie outside the repository");
  if (insideRepo(outDir, root))
    throw new Error("the output folder must lie outside the repository");
  const preregAbs = path.resolve(root, args.prereg);
  const preregRel = posix(path.relative(root, preregAbs));
  if (preregRel.startsWith("..")) throw new Error("the plan file must lie inside the repository");
  const planText = readFileSync(preregAbs, "utf8").replace(/\r\n/g, "\n");
  const planSha = sha256(planText);
  const plan = JSON.parse(planText);
  const ledgerPath = path.resolve(root, args.ledger ?? "docs/research/registry.json");

  const ledgerLib = await loadEngine(path.join("src", "lib", "research", "ledgerFile.ts"));
  const ledger = ledgerLib.parseLedger(readFileSync(ledgerPath, "utf8"));
  const planIds = plan.lineages.map((l) => l.id);
  const asked = args.lineage === "all" ? planIds : args.lineage.split(",");
  for (const id of asked) if (!planIds.includes(id)) throw new Error(`${id} is not in the plan`);
  for (const id of asked) {
    const mine = ledger.entries.filter((e) => e.lineage === id && e.market === plan.market);
    if (mine.some((e) => ledgerLib.hasLook(e)))
      throw new Error("A second look at a finished test was refused.");
    if (!mine.some((e) => e.sha === planSha && e.preregPath === preregRel && !ledgerLib.hasLook(e)))
      throw new Error(
        `no plan entry with the hash of ${preregRel} for ${id}: the plan must be committed and entered first`,
      );
  }
  for (const id of asked.filter((i) => BASE_IDS.includes(i))) {
    const v = plan.variants.find((x) => x.of === id);
    const mine = ledger.entries.filter((e) => e.lineage === v.id && e.market === plan.market);
    if (mine.some((e) => ledgerLib.hasLook(e)))
      throw new Error("A second look at a finished test was refused.");
    if (!mine.some((e) => e.sha === planSha && e.preregPath === preregRel))
      throw new Error(`no plan entry with the hash of ${preregRel} for ${v.id}`);
  }
  const prov = provenance(root, preregRel, args.allowDirty);

  const lib = await loadEngine(path.join("src", "lib", "research", "lineages", "cxa003.ts"));
  const names = await loadEngine(path.join("src", "lib", "research", "names.ts"));

  io.log("loading the history extract (read only)");
  const h = loadHistory({ ...args, history }, lib);
  const { world, shorts } = h;
  io.log(
    `calendar ${world.dates.length} sessions; ${h.files} bar files, ${world.series.size} with bars; ${h.reports} short-position rows`,
  );
  const universe = new lib.Universe(world);
  const prices = lib.priceBook(world);
  const pool = universe.pool();
  const boundary = lib.boundarySessionOf(world.dates, plan.common.split.holdoutFrom);
  const lastSession = world.dates.length - 1;
  const floors = { minSetups: plan.common.floors.setups, minBlocks: plan.common.floors.blocks };

  // 1. entries and floors for every lineage with a history (no price is read)
  const split = {};
  const entry = {};
  for (const id of BASE_IDS) {
    const key = KEY_OF[id];
    const setups = lib.buildSetups(key, world, universe, shorts);
    const w = lib.splitWindows(setups, boundary, lastSession);
    const e = lib.holdoutEntryCounts(w, floors);
    split[id] = { key, setups, w };
    entry[id] = e;
    io.log(
      `${id}: ${setups.length} setups, development ${w.development.length}, holdout ${w.holdout.length} ` +
        `(after one position per code: ${e.counts.setups} setups, ${e.counts.blocks} blocks, floors ${e.floorsMet ? "met" : "not met"}), ` +
        `purged ${w.purged}, unfinished ${w.unfinished}`,
    );
  }
  const k = Math.max(1, BASE_IDS.filter((id) => entry[id].floorsMet).length);
  io.log(`k (base lineages with the holdout floors met, counted from entries) = ${k}`);

  const doIds = asked.filter((i) => BASE_IDS.includes(i));
  const study = (id, setups, parcel) =>
    lib.figuresOf(
      lib.studyWindow({
        key: KEY_OF[id],
        setups,
        prices,
        pool,
        k,
        parcelMicro: parcel,
        costProfile: plan.common.costProfile,
        floors,
        replicates: plan.common.bootstrap.replicates,
      }),
    );
  const base = BigInt(plan.common.parcelMicro);
  const large = (id) => BigInt(plan.variants.find((v) => v.of === id).parcelMicro);
  const dev = {};
  const hold = {};
  const full = {};
  const looks = [];

  // 2. development figures, printed first
  for (const id of doIds) {
    dev[id] = {
      base: study(id, split[id].w.development, base),
      large: study(id, split[id].w.development, large(id)),
    };
    io.log(line(`${id} development`, dev[id].base));
    io.log(line(`${id}_p5000 development (Larger account, not your book)`, dev[id].large));
  }

  if (args.noLook) {
    io.log(
      "--no-look: stopped after the counts and the development figures; no look was taken and nothing was written",
    );
    return { reports: [], looks: [] };
  }

  // 3. the one holdout look per lineage, then its variant; each is appended to the ledger when taken
  const lookedAt = (args.now ?? new Date().toISOString()).replace(/\.\d+Z$/, "Z");
  for (const id of doIds) {
    hold[id] = {};
    if (!entry[id].floorsMet) {
      io.log(`${id}: INCONCLUSIVE, holdout floors not met, no look spent`);
      continue;
    }
    for (const [which, parcel, lineage] of [
      ["base", base, id],
      ["large", large(id), plan.variants.find((v) => v.of === id).id],
    ]) {
      const f = study(id, split[id].w.holdout, parcel);
      hold[id][which] = f;
      const verdict = f.status === "below_sample" ? null : f.verdict;
      if (verdict === null) continue; // the floors were counted first, so this cannot happen
      const stats = {
        meanExcessAfterHaircutPpm: f.withHaircut.meanPpm,
        lowerPpm: f.withHaircut.lowerPpm,
        alpha: f.withHaircut.alpha,
        meanExcessPpm: f.withoutHaircut.meanPpm,
        lowerNoHaircutPpm: f.withoutHaircut.lowerPpm,
        meanNetPpm: f.meanNetPpm,
        sessions: f.counts.sessions,
        unfilled: f.unfilled,
        unmatched: f.unmatched,
        parcelMicro: String(parcel),
        k,
      };
      const e = {
        item: plan.item,
        lineage,
        market: plan.market,
        sha: planSha,
        preregPath: preregRel,
        lookedAt,
        verdict,
        nSetups: f.withHaircut.n,
        nBlocks: f.counts.blocks,
        stats,
        ...(which === "large" ? { note: "Larger account, not your book" } : {}),
      };
      appendLedger(ledgerPath, ledgerLib, e);
      looks.push({
        lineage,
        market: plan.market,
        date: lookedAt.slice(0, 10),
        sha: planSha,
        verdict,
      });
      io.log(line(`${lineage} HOLDOUT LOOK`, f));
    }
  }
  const problems = ledgerLib.checkLedger(
    ledgerLib.parseLedger(readFileSync(ledgerPath, "utf8")).entries,
    (p) => (existsSync(path.join(root, p)) ? readFileSync(path.join(root, p), "utf8") : null),
  );
  if (problems.length > 0) throw new Error(`the ledger check failed: ${problems.join("; ")}`);

  // 4. full-window figures: they decide nothing
  for (const id of doIds) {
    const all = split[id].setups.filter((s) => s.signalSession + 1 + s.hold <= lastSession);
    full[id] = { base: study(id, all, base), large: study(id, all, large(id)) };
    io.log(line(`${id} full window`, full[id].base));
  }

  // 5. result and report inputs, outside the repository
  mkdirSync(outDir, { recursive: true });
  const allLooks = ledgerLib
    .parseLedger(readFileSync(ledgerPath, "utf8"))
    .entries.filter((e) => e.item === plan.item && e.verdict !== undefined)
    .map((e) => ({
      lineage: e.lineage,
      market: e.market,
      date: e.lookedAt.slice(0, 10),
      sha: e.sha,
      verdict: e.verdict,
    }));
  const dataBlock = {
    sourceClass:
      "daily bars and short-position reports of the build machine history extract (kept outside the repository)",
    window: `${world.dates[0]} to ${world.dates[lastSession]}`,
    universe:
      "the top-turnover tier of the app tier rule, recomputed on every signal session from bars up to that session",
    knownTime:
      "a signal is known at the close of its signal session; a short-position report counts from the session after its stored publication date",
    caveats: [
      "survivors only: the extract holds codes that still trade, so a haircut of one percentage point per 60 sessions held is assumed (each figure is shown with and without it)",
      "prices are split-adjusted vendor bars; dividends are not added to either a setup or its controls",
      "the publication time of a short-position report is assumed (end of the third weekday after its date)",
      "controls are drawn from the same survivors, which removes part of the survivorship bias",
    ],
  };
  const reports = [];
  const mk = (lineageId, baseId, variant) => {
    const f = variant ? "large" : "base";
    const spec = plan.lineages.find((l) => l.id === baseId);
    const e = entry[baseId];
    const hasLook = hold[baseId]?.[f] !== undefined && hold[baseId][f].status === "looked";
    const lookFig = hold[baseId]?.[f];
    const verdict = hasLook ? lookFig.verdict : "INCONCLUSIVE";
    const label = variant ? plan.variants.find((v) => v.of === baseId).label : null;
    const figs = {
      development: dev[baseId][f],
      holdout: lookFig ?? { status: "below_sample", reason: "floors not met", counts: e.counts },
      full: full[baseId][f],
    };
    const reason = !hasLook
      ? `the holdout entries (${e.counts.setups} setups, ${e.counts.blocks} blocks) do not meet the floors, so no look was spent`
      : verdict === "PASS"
        ? "the lower bound of the mean excess after the haircut is above zero"
        : verdict === "NULL"
          ? "the lower bound of the mean excess after the haircut is not above zero"
          : "the statistic could not be computed";
    return {
      item: plan.item,
      title: names.lineageName(lineageId),
      lineage: lineageId,
      market: plan.market,
      verdict,
      hypothesis: spec.hypothesis,
      prereg: {
        file: preregRel,
        sha256: planSha,
        commit: prov.preregCommit,
        date: prov.preregDate,
        runnerCommit: prov.runnerCommit,
      },
      data: dataBlock,
      split: {
        kind: "split",
        development: { from: world.dates[0], to: plan.common.split.developmentTo },
        holdout: { from: plan.common.split.holdoutFrom, to: world.dates[lastSession] },
      },
      n: {
        setups: e.counts.setups,
        sessions: e.counts.sessions,
        blocks: e.counts.blocks,
        floorSetups: floors.minSetups,
        floorBlocks: floors.minBlocks,
        floorMet: e.floorsMet,
      },
      statistic: {
        definition: `Mean excess return after the haircut: each setup is bought at the next open and sold ${spec.hold} sessions later, net of the broker fees, less the mean of up to 20 matched controls on the same session; the lower bound is the one-sided block-bootstrap bound (block = hold). Only the holdout decides; development and full-window figures are shown beside it. Without the haircut: ${noHaircutText(figs)}.`,
        costProfile: plan.common.costProfile,
        parcel: `${Number(variant ? large(baseId) : base) / 1_000_000} whole units of the market currency`,
        control:
          spec.matchOn.join(" and ") === "tier" ? "same tier" : "same tier and volatility decile",
        haircut: "1 percentage point per 60 sessions held (assumed; survivors only)",
        variantLabel: label,
      },
      result: {
        unit: "parts per million of the entry value",
        alpha: hasLook ? lookFig.withHaircut.alpha : null,
        rows: [
          resultRow("development", figs.development),
          resultRow("holdout", figs.holdout),
          resultRow("full", figs.full),
        ],
      },
      verdictReason: reason,
      ...(verdict === "INCONCLUSIVE"
        ? {
            missingData: "enough holdout entries to meet the floors",
            firesLater: "not before the data holds that many entries; the plan hash stays the same",
          }
        : {}),
      looks: allLooks,
      refusals: [],
      next: variant
        ? "Nothing. This figure is a simulation at a larger parcel; it never trades and is never counted among the base tests."
        : verdict === "PASS"
          ? "The lineage goes to the shadow path after the Owner review; nothing trades."
          : "No further look is allowed on this plan; any new idea is a new lineage with its own plan.",
    };
  };
  for (const id of doIds) {
    reports.push(mk(id, id, false));
    reports.push(mk(plan.variants.find((v) => v.of === id).id, id, true));
  }
  for (const id of asked.filter((i) => !BASE_IDS.includes(i))) {
    const spec = plan.lineages.find((l) => l.id === id);
    reports.push({
      item: plan.item,
      title: names.lineageName(id),
      lineage: id,
      market: plan.market,
      verdict: "INCONCLUSIVE",
      hypothesis: spec.hypothesis,
      prereg: {
        file: preregRel,
        sha256: planSha,
        commit: prov.preregCommit,
        date: prov.preregDate,
        runnerCommit: prov.runnerCommit,
      },
      data: { ...dataBlock, window: "none", universe: "none", caveats: [spec.history] },
      split: { kind: "full", reason: "no history exists, so there is nothing to split" },
      n: {
        setups: 0,
        sessions: 0,
        blocks: 0,
        floorSetups: floors.minSetups,
        floorBlocks: floors.minBlocks,
        floorMet: false,
      },
      statistic: {
        definition: "Not computed: the history this test needs does not exist yet.",
        costProfile: plan.common.costProfile,
        parcel: `${Number(base) / 1_000_000} whole units of the market currency`,
        control: "same tier and volatility decile",
        haircut: "1 percentage point per 60 sessions held (assumed; survivors only)",
      },
      result: { unit: "parts per million of the entry value", alpha: null, rows: [] },
      verdictReason: "the history this test needs does not exist yet; no look was spent",
      missingData: "the history this test needs does not exist yet",
      firesLater:
        "when forward data holds enough entries to meet the floors, under the same plan hash",
      looks: allLooks,
      refusals: [],
      next: "Nothing now. The plan stays frozen; production keeps collecting the inputs.",
    });
  }
  for (const r of reports)
    writeFileSync(
      path.join(outDir, `${r.lineage}.report.json`),
      `${JSON.stringify(r, null, 2)}\n`,
      "utf8",
    );
  writeFileSync(
    path.join(outDir, "cxa003-result.json"),
    `${JSON.stringify({ plan: { sha: planSha, file: preregRel }, provenance: prov, k, entry, development: dev, holdout: hold, full }, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2)}\n`,
    "utf8",
  );
  io.log(`wrote ${reports.length} report inputs and the result file (outside the repository)`);
  return { reports, looks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      console.error(`run-lineage: ${e.message}`);
      process.exit(1);
    },
  );
}
