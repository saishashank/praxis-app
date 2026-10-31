// Owner-run import of the offline Cortex artefacts (M15 P6; D-267, D-281, D-349, D-357).
//   node scripts/cortex/import.mjs <artefact-folder> [--dry-run]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN (a file: URL needs no token). Output: counts only, never a
// row, a value, a URL or a token. The folder is private data and must lie OUTSIDE this repository.
//
// ARTEFACT FORMAT (praxis-cortex-artefact/1): five JSON files in one folder.
//   manifest.json  { format: "praxis-cortex-artefact/1", market: "AU", created_at: ISO-8601 }
//   passports.json { passports: [ { angle_id, version>=1, domain 1..10, cluster, orientation 1|-1,
//                      kind score|gate|meta, inputs: string[], history_fields: object,
//                      status candidate|measured|active|watch|retired, horizon_sessions>0,
//                      evidence: object, measured: object|null, frozen_at } ] }
//   cells.json     { cells: [ { cell_id, family F1..F7|all, angle_id|null, kind, spec: object,
//                      logged_at, result_at|null, result: object|null, split development|validation,
//                      lineage_id|null } ] }       logged_at < result_at; result and result_at go together.
//                  kind "matched_cell": result is the CellStatistic JSON (cellKey, n, blocks, nEff,
//                    meanNet, lower90, lReal, gap95, byRegime {regime: {n, meanNet}}, excludedUnfilledShare).
//                  kind "placebo": result { passed: boolean, null_pass_rate: 0..1 }.
//                  kind "nav_at_risk": result { loss_95_pct, loss_worst_pct }.
//   maps.json      { maps: [ { family, rule_version, fitted_at, active_set_hash, n_eff>=0, pool,
//                      fit_split, params: { a, b, s_mean, s_sd, K, clusters: string[], top3_min_s,
//                      family_mean_net, tiers: ("U1"|"U2"|"U3")[], p_hidden: boolean, gain>=0,
//                      loss>=0, slots: integer>=1 } } ] }
//   evidence.json  { as_of_d: YYYY-MM-DD, families: [ { family, n_eff|null, min_neff_trade?: 150..400,
//                      brier_skill_lo90|null, slope_ub90|null, gate_cell_key (a matched_cell cellKey),
//                      mde: number|null, mde_rows: [ {n_eff, mde} for 100, 150 and 300 ],
//                      n_eff_live_per_session|null } ] }
// Every file is validated before anything is written (a failure names the file and the path, not the
// value). Statuses are NOT in the artefact: each family's status comes from the CTX-053 rules in
// src/lib/cortex/statusRules.mjs (CTX-072), recorded as the evaluator's row; the statement of an
// allowed family is generated from the template. Re-running is safe (insert-or-ignore on every key).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import {
  A_D5_08,
  allowedWeakStatement,
  capAngleStatus,
  decideFamily,
  FAMILIES,
  MIN_NEFF_TRADE_BOUNDS,
} from "../../src/lib/cortex/statusRules.mjs";

export const FORMAT = "praxis-cortex-artefact/1";
export const MIN_SCHEMA = 19;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Sorted-key JSON text (what the 0019 JSON columns hold). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const CLUSTERS = [
  "momentum",
  "low_volatility",
  "liquidity",
  "event",
  "quality",
  "sentiment",
  "regime",
  "risk",
  "calendar",
  "meta",
];
const ANGLE_STATUS = ["candidate", "measured", "active", "watch", "retired"];

/** A collector of schema errors: file + path + rule, never the offending value. */
function errors() {
  const list = [];
  const at = (file, p, msg) => list.push(`${file}: ${p}: ${msg}`);
  return { list, at };
}

function check(e, file, p, cond, msg) {
  if (!cond) e.at(file, p, msg);
  return cond;
}

function validateCellStat(e, file, p, r) {
  if (!check(e, file, p, isObj(r), "matched_cell result must be an object")) return;
  check(e, file, `${p}.cellKey`, isStr(r.cellKey), "string required");
  check(e, file, `${p}.n`, isInt(r.n) && r.n >= 0, "integer >= 0 required");
  check(e, file, `${p}.blocks`, isInt(r.blocks) && r.blocks >= 0, "integer >= 0 required");
  check(e, file, `${p}.nEff`, r.nEff === null || isNum(r.nEff), "number or null required");
  check(e, file, `${p}.meanNet`, isNum(r.meanNet), "number required");
  check(e, file, `${p}.lower90`, r.lower90 === null || isNum(r.lower90), "number or null required");
  check(e, file, `${p}.lReal`, isNum(r.lReal) && r.lReal >= 0, "number >= 0 required");
  check(e, file, `${p}.gap95`, isNum(r.gap95) && r.gap95 >= 0, "number >= 0 required");
  check(
    e,
    file,
    `${p}.excludedUnfilledShare`,
    isNum(r.excludedUnfilledShare) && r.excludedUnfilledShare >= 0 && r.excludedUnfilledShare <= 1,
    "number in 0..1 required",
  );
  if (check(e, file, `${p}.byRegime`, isObj(r.byRegime), "object required")) {
    for (const [k, v] of Object.entries(r.byRegime)) {
      check(
        e,
        file,
        `${p}.byRegime.${k}`,
        isObj(v) && isInt(v.n) && isNum(v.meanNet),
        "{n, meanNet} required",
      );
    }
  }
}

export function validateManifest(m) {
  const e = errors();
  const f = "manifest.json";
  if (check(e, f, "$", isObj(m), "object required")) {
    check(e, f, "format", m.format === FORMAT, `must be ${FORMAT}`);
    check(e, f, "market", isStr(m.market), "string required");
    check(
      e,
      f,
      "created_at",
      isStr(m.created_at) && !Number.isNaN(Date.parse(m.created_at)),
      "ISO date-time required",
    );
  }
  return e.list;
}

export function validatePassports(j) {
  const e = errors();
  const f = "passports.json";
  if (!check(e, f, "$", isObj(j) && Array.isArray(j.passports), "{ passports: [] } required"))
    return e.list;
  const seen = new Set();
  j.passports.forEach((r, i) => {
    const p = `passports[${i}]`;
    if (!check(e, f, p, isObj(r), "object required")) return;
    check(e, f, `${p}.angle_id`, isStr(r.angle_id), "string required");
    check(e, f, `${p}.version`, isInt(r.version) && r.version >= 1, "integer >= 1 required");
    check(
      e,
      f,
      `${p}.domain`,
      isInt(r.domain) && r.domain >= 1 && r.domain <= 10,
      "integer 1..10 required",
    );
    check(e, f, `${p}.cluster`, CLUSTERS.includes(r.cluster), "unknown cluster");
    check(
      e,
      f,
      `${p}.orientation`,
      r.orientation === 1 || r.orientation === -1,
      "1 or -1 required",
    );
    check(
      e,
      f,
      `${p}.kind`,
      ["score", "gate", "meta"].includes(r.kind),
      "score, gate or meta required",
    );
    check(e, f, `${p}.inputs`, isStrArr(r.inputs), "string array required");
    check(
      e,
      f,
      `${p}.history_fields`,
      isObj(r.history_fields) || Array.isArray(r.history_fields),
      "object required",
    );
    check(e, f, `${p}.status`, ANGLE_STATUS.includes(r.status), "unknown status");
    check(
      e,
      f,
      `${p}.horizon_sessions`,
      isInt(r.horizon_sessions) && r.horizon_sessions > 0,
      "integer > 0 required",
    );
    check(e, f, `${p}.evidence`, isObj(r.evidence), "object required");
    check(
      e,
      f,
      `${p}.measured`,
      r.measured === null || isObj(r.measured),
      "object or null required",
    );
    check(e, f, `${p}.frozen_at`, isStr(r.frozen_at), "string required");
    // D-305: no live session exists at import time, so A-D5-08 may be `measured` at most.
    if (isStr(r.angle_id) && capAngleStatus(r.angle_id, r.status, 0) !== r.status) {
      e.at(f, `${p}.status`, `${A_D5_08} may be measured at most until 60 live sessions (D-305)`);
    }
    const key = `${r.angle_id}#${r.version}`;
    check(e, f, p, !seen.has(key), "duplicate (angle_id, version)");
    seen.add(key);
  });
  return e.list;
}

export function validateCells(j) {
  const e = errors();
  const f = "cells.json";
  if (!check(e, f, "$", isObj(j) && Array.isArray(j.cells), "{ cells: [] } required"))
    return e.list;
  const seen = new Set();
  j.cells.forEach((c, i) => {
    const p = `cells[${i}]`;
    if (!check(e, f, p, isObj(c), "object required")) return;
    check(e, f, `${p}.cell_id`, isStr(c.cell_id), "string required");
    check(
      e,
      f,
      `${p}.family`,
      c.family === "all" || FAMILIES.includes(c.family),
      "family or all required",
    );
    check(
      e,
      f,
      `${p}.angle_id`,
      c.angle_id === null || isStr(c.angle_id),
      "string or null required",
    );
    check(e, f, `${p}.kind`, isStr(c.kind), "string required");
    check(e, f, `${p}.spec`, isObj(c.spec), "object required");
    check(e, f, `${p}.logged_at`, isStr(c.logged_at), "string required");
    check(
      e,
      f,
      `${p}.split`,
      c.split === "development" || c.split === "validation",
      "development or validation required",
    );
    check(
      e,
      f,
      `${p}.lineage_id`,
      c.lineage_id === null || isStr(c.lineage_id),
      "string or null required",
    );
    const hasR = c.result_at !== null && c.result_at !== undefined;
    const hasJ = c.result !== null && c.result !== undefined;
    check(e, f, p, hasR === hasJ, "result_at and result go together");
    if (hasR && isStr(c.logged_at)) {
      check(
        e,
        f,
        `${p}.result_at`,
        isStr(c.result_at) && c.logged_at < c.result_at,
        "logged_at must be before result_at",
      );
    }
    check(e, f, `${p}.cell_id`, !seen.has(c.cell_id), "duplicate cell_id");
    seen.add(c.cell_id);
    if (hasJ) {
      if (c.kind === "matched_cell") validateCellStat(e, f, `${p}.result`, c.result);
      if (c.kind === "placebo") {
        const r = c.result;
        check(
          e,
          f,
          `${p}.result`,
          isObj(r) &&
            typeof r.passed === "boolean" &&
            isNum(r.null_pass_rate) &&
            r.null_pass_rate >= 0 &&
            r.null_pass_rate <= 1,
          "{ passed, null_pass_rate 0..1 } required",
        );
      }
      if (c.kind === "nav_at_risk") {
        const r = c.result;
        check(
          e,
          f,
          `${p}.result`,
          isObj(r) && isNum(r.loss_95_pct) && isNum(r.loss_worst_pct),
          "{ loss_95_pct, loss_worst_pct } required",
        );
      }
    } else if (c.kind === "matched_cell") {
      e.at(f, `${p}.result`, "a matched_cell needs its result");
    }
  });
  return e.list;
}

export function validateMaps(j) {
  const e = errors();
  const f = "maps.json";
  if (!check(e, f, "$", isObj(j) && Array.isArray(j.maps), "{ maps: [] } required")) return e.list;
  const seen = new Set();
  j.maps.forEach((m, i) => {
    const p = `maps[${i}]`;
    if (!check(e, f, p, isObj(m), "object required")) return;
    check(e, f, `${p}.family`, FAMILIES.includes(m.family), "F1..F7 required");
    for (const k of ["rule_version", "fitted_at", "active_set_hash", "pool", "fit_split"]) {
      check(e, f, `${p}.${k}`, isStr(m[k]), "string required");
    }
    check(e, f, `${p}.n_eff`, isNum(m.n_eff) && m.n_eff >= 0, "number >= 0 required");
    const q = m.params;
    if (check(e, f, `${p}.params`, isObj(q), "object required")) {
      for (const k of ["a", "b", "s_mean", "s_sd", "top3_min_s", "family_mean_net"]) {
        check(e, f, `${p}.params.${k}`, isNum(q[k]), "number required");
      }
      check(e, f, `${p}.params.K`, isInt(q.K) && q.K >= 1 && q.K <= 6, "integer 1..6 required");
      check(e, f, `${p}.params.clusters`, isStrArr(q.clusters), "string array required");
      check(
        e,
        f,
        `${p}.params.tiers`,
        isStrArr(q.tiers) && q.tiers.every((t) => ["U1", "U2", "U3"].includes(t)),
        "U1/U2/U3 array required",
      );
      check(e, f, `${p}.params.p_hidden`, typeof q.p_hidden === "boolean", "boolean required");
      check(e, f, `${p}.params.gain`, isNum(q.gain) && q.gain >= 0, "number >= 0 required");
      check(e, f, `${p}.params.loss`, isNum(q.loss) && q.loss >= 0, "number >= 0 required");
      check(e, f, `${p}.params.slots`, isInt(q.slots) && q.slots >= 1, "integer >= 1 required");
    }
    const key = `${m.family}|${m.rule_version}|${m.fitted_at}`;
    check(e, f, p, !seen.has(key), "duplicate (family, rule_version, fitted_at)");
    seen.add(key);
  });
  return e.list;
}

export function validateEvidence(j) {
  const e = errors();
  const f = "evidence.json";
  if (
    !check(
      e,
      f,
      "$",
      isObj(j) && isDay(j.as_of_d) && Array.isArray(j.families),
      "{ as_of_d, families: [] } required",
    )
  ) {
    return e.list;
  }
  const seen = new Set();
  j.families.forEach((r, i) => {
    const p = `families[${i}]`;
    if (!check(e, f, p, isObj(r), "object required")) return;
    check(e, f, `${p}.family`, FAMILIES.includes(r.family), "F1..F7 required");
    check(
      e,
      f,
      `${p}.n_eff`,
      r.n_eff === null || (isNum(r.n_eff) && r.n_eff >= 0),
      "number >= 0 or null required",
    );
    check(
      e,
      f,
      `${p}.min_neff_trade`,
      r.min_neff_trade === undefined ||
        (isNum(r.min_neff_trade) &&
          r.min_neff_trade >= MIN_NEFF_TRADE_BOUNDS[0] &&
          r.min_neff_trade <= MIN_NEFF_TRADE_BOUNDS[1]),
      `within ${MIN_NEFF_TRADE_BOUNDS[0]}..${MIN_NEFF_TRADE_BOUNDS[1]} required`,
    );
    check(
      e,
      f,
      `${p}.brier_skill_lo90`,
      r.brier_skill_lo90 === null || isNum(r.brier_skill_lo90),
      "number or null required",
    );
    check(
      e,
      f,
      `${p}.slope_ub90`,
      r.slope_ub90 === null || isNum(r.slope_ub90),
      "number or null required",
    );
    check(e, f, `${p}.gate_cell_key`, isStr(r.gate_cell_key), "string required");
    check(e, f, `${p}.mde`, r.mde === null || isNum(r.mde), "number or null required");
    const rows = r.mde_rows;
    if (
      check(
        e,
        f,
        `${p}.mde_rows`,
        Array.isArray(rows) && rows.every((x) => isObj(x) && isNum(x.n_eff) && isNum(x.mde)),
        "[{ n_eff, mde }] required",
      )
    ) {
      for (const lvl of [100, 150, 300]) {
        check(
          e,
          f,
          `${p}.mde_rows`,
          rows.some((x) => x.n_eff === lvl),
          `a row for n_eff ${lvl} is required`,
        );
      }
    }
    check(
      e,
      f,
      `${p}.n_eff_live_per_session`,
      r.n_eff_live_per_session === null ||
        (isNum(r.n_eff_live_per_session) && r.n_eff_live_per_session >= 0),
      "number >= 0 or null required",
    );
    check(e, f, p, !seen.has(r.family), "duplicate family");
    seen.add(r.family);
  });
  return e.list;
}

/** Reads and validates the whole folder; returns { ok, errors, data }. */
export function loadArtefact(dir) {
  const read = (name) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) return { err: `${name}: missing file` };
    try {
      return { v: JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { err: `${name}: not valid JSON` };
    }
  };
  const errs = [];
  const data = {};
  const files = [
    ["manifest.json", validateManifest],
    ["passports.json", validatePassports],
    ["cells.json", validateCells],
    ["maps.json", validateMaps],
    ["evidence.json", validateEvidence],
  ];
  for (const [name, fn] of files) {
    const r = read(name);
    if (r.err) {
      errs.push(r.err);
      continue;
    }
    data[name] = r.v;
    errs.push(...fn(r.v));
  }
  if (errs.length > 0) return { ok: false, errors: errs, data };
  // cross-file checks
  const cells = data["cells.json"].cells;
  const gateCells = new Map(
    cells.filter((c) => c.kind === "matched_cell").map((c) => [c.result.cellKey, c.result]),
  );
  const decisions = [];
  for (const ev of data["evidence.json"].families) {
    const cell = gateCells.get(ev.gate_cell_key) ?? null;
    if (cell === null)
      errs.push(`evidence.json: ${ev.family}.gate_cell_key: no matched_cell with that cellKey`);
    const d = decideFamily({
      family: ev.family,
      nEff: ev.n_eff,
      minNEff: ev.min_neff_trade,
      brierLo90: ev.brier_skill_lo90,
      slopeUb90: ev.slope_ub90,
      cell,
    });
    d.evidence = { ...d.evidence, mde: ev.mde, mde_rows: ev.mde_rows };
    decisions.push({ ev, decision: d });
    for (const m of data["maps.json"].maps.filter((x) => x.family === ev.family)) {
      if (m.params.p_hidden !== d.pHidden) {
        errs.push(
          `maps.json: ${ev.family}.params.p_hidden: disagrees with the slope monitor of evidence.json`,
        );
      }
    }
  }
  return { ok: errs.length === 0, errors: errs, data, decisions };
}

/** True when `dir` lies inside the repository (private artefacts must not). */
export function insideRepo(dir) {
  const rel = path.relative(REPO_ROOT, path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function plan(data, decisions) {
  const market = data["manifest.json"].market;
  const createdAt = data["manifest.json"].created_at;
  const asOf = data["evidence.json"].as_of_d;
  const ins = (table, cols, args, tag) => ({
    tag,
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
    args,
  });
  const stmts = [];
  for (const p of data["passports.json"].passports) {
    stmts.push(
      ins(
        "angle_passport",
        [
          "market",
          "angle_id",
          "version",
          "domain",
          "cluster",
          "orientation",
          "kind",
          "inputs_json",
          "history_fields_json",
          "status",
          "horizon_sessions",
          "evidence_json",
          "measured_json",
          "frozen_at",
        ],
        [
          market,
          p.angle_id,
          p.version,
          p.domain,
          p.cluster,
          p.orientation,
          p.kind,
          canonical(p.inputs),
          canonical(p.history_fields),
          p.status,
          p.horizon_sessions,
          canonical(p.evidence),
          p.measured === null ? null : canonical(p.measured),
          p.frozen_at,
        ],
        "passports",
      ),
    );
  }
  for (const c of data["cells.json"].cells) {
    const resulted = c.result_at !== null && c.result_at !== undefined;
    stmts.push(
      ins(
        "cortex_ledger_cell",
        [
          "cell_id",
          "market",
          "family",
          "angle_id",
          "kind",
          "spec_json",
          "logged_at",
          "result_at",
          "result_json",
          "split",
          "lineage_id",
        ],
        [
          c.cell_id,
          market,
          c.family,
          c.angle_id,
          c.kind,
          canonical(c.spec),
          c.logged_at,
          resulted ? c.result_at : null,
          resulted ? canonical(c.result) : null,
          c.split,
          c.lineage_id,
        ],
        "cells",
      ),
    );
  }
  for (const m of data["maps.json"].maps) {
    stmts.push(
      ins(
        "cortex_map",
        [
          "market",
          "family",
          "rule_version",
          "fitted_at",
          "params_json",
          "active_set_hash",
          "n_eff",
          "pool",
          "fit_split",
        ],
        [
          market,
          m.family,
          m.rule_version,
          m.fitted_at,
          canonical(m.params),
          m.active_set_hash,
          m.n_eff,
          m.pool,
          m.fit_split,
        ],
        "maps",
      ),
    );
  }
  const statuses = [];
  for (const { ev, decision } of decisions) {
    let statementId = null;
    if (decision.allowed) {
      const s = allowedWeakStatement({
        family: ev.family,
        nEffLivePerSession: ev.n_eff_live_per_session,
      });
      statementId = `stmt:${market}:${ev.family}:allowed_weak:${createdAt.slice(0, 10)}`;
      stmts.push(
        ins(
          "cortex_statement",
          [
            "statement_id",
            "market",
            "family",
            "kind",
            "text",
            "numbers_json",
            "n_eff_live",
            "created_at",
          ],
          [statementId, market, ev.family, s.kind, s.text, canonical(s.numbers), 0, createdAt],
          "statements",
        ),
      );
    }
    statuses.push({ family: ev.family, statementId, decision });
  }
  return { market, asOf, stmts, statuses };
}

function counts(stmts, statuses) {
  const c = { passports: 0, cells: 0, maps: 0, statements: 0 };
  for (const s of stmts) c[s.tag] += 1;
  return {
    ...c,
    families_allowed: statuses.filter((s) => s.decision.allowed).length,
    families_shadow: statuses.filter((s) => !s.decision.allowed).length,
  };
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => import("@libsql/client").Client,
 *   out?: (s: string) => void, allowInsideRepo?: boolean }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const dry = argv.includes("--dry-run");
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    out("cortex import: failed (usage: <artefact-folder> [--dry-run])");
    return 1;
  }
  if (!deps.allowInsideRepo && insideRepo(dir)) {
    out(
      "cortex import: failed (the artefact folder must be outside the repository; it is private data)",
    );
    return 1;
  }
  if (!existsSync(dir)) {
    out("cortex import: failed (artefact folder not found)");
    return 1;
  }
  const loaded = loadArtefact(dir);
  if (!loaded.ok) {
    out(`cortex import: rejected (${loaded.errors.length} schema errors; nothing written)`);
    for (const m of loaded.errors) out(`  ${m}`);
    return 1;
  }
  const { market, asOf, stmts, statuses } = plan(loaded.data, loaded.decisions);
  const planned = counts(stmts, statuses);
  if (dry) {
    out(`cortex import dry run (${market}): ${JSON.stringify(planned)}; nothing written`);
    return 0;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  const has = (v) => typeof v === "string" && v.trim() !== "";
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out("cortex import: failed (database not configured)");
    return 1;
  }
  const db = openDb(String(url), token);
  try {
    let schema = 0;
    try {
      const r = await db.execute("SELECT MAX(version) AS v FROM schema_migrations");
      schema = Number(r.rows[0]?.v ?? 0);
    } catch {
      schema = 0;
    }
    if (schema < MIN_SCHEMA) {
      out(`cortex import: refused (database schema ${schema} is below ${MIN_SCHEMA})`);
      return 1;
    }
    // Family status rows: the evaluator's verdict; an Owner kill (suspended) is never overwritten.
    const statusStmts = [];
    for (const s of statuses) {
      const r = await db.execute({
        sql: `SELECT status FROM family_status WHERE market = ? AND family = ? AND since_d =
              (SELECT MAX(since_d) FROM family_status WHERE market = ? AND family = ?)`,
        args: [market, s.family, market, s.family],
      });
      if (String(r.rows[0]?.status ?? "") === "suspended") continue;
      statusStmts.push({
        tag: "family_status",
        sql: `INSERT INTO family_status (market, family, since_d, status, evidence_json, statement_id, set_by)
              VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          market,
          s.family,
          asOf,
          s.decision.status,
          canonical(s.decision.evidence),
          s.statementId,
          s.decision.allowed ? "evaluator" : "import",
        ],
      });
    }
    const all = [...stmts, ...statusStmts];
    const results = await db.batch(
      all.map((x) => ({ sql: x.sql, args: x.args })),
      "write",
    );
    const written = { passports: 0, cells: 0, maps: 0, statements: 0, family_status: 0 };
    results.forEach((r, i) => {
      written[all[i].tag] += r.rowsAffected;
    });
    const skipped = {
      passports: planned.passports - written.passports,
      cells: planned.cells - written.cells,
      maps: planned.maps - written.maps,
      statements: planned.statements - written.statements,
    };
    out(
      `cortex import (${market}): written ${JSON.stringify(written)}; already present ${JSON.stringify(skipped)}; families allowed ${planned.families_allowed}, shadow ${planned.families_shadow}`,
    );
    return 0;
  } catch {
    out("cortex import: failed (the database refused the write; nothing further was written)");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
