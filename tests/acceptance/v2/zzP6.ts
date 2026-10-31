// Synthetic ZZ artefact folder for the P6 tests (import, AT-53, AT-54). No real data (SEC-110): the
// numbers are invented so that F1 and F4 pass CTX-053 and everything else does not.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export type ArtefactFiles = {
  "manifest.json": Json;
  "passports.json": Json;
  "cells.json": Json;
  "maps.json": Json;
  "evidence.json": Json;
};

const T0 = "2030-01-01T00:00:00Z";
const T1 = "2030-01-02T00:00:00Z";

const cellStat = (key: string, lower90: number, over: Record<string, unknown> = {}) => ({
  cellKey: key,
  n: 120,
  blocks: 24,
  nEff: 150,
  meanNet: 0.03,
  lower90,
  lReal: 0.05,
  gap95: 0.04,
  excludedUnfilledShare: 0.1,
  byRegime: { RISK_ON: { n: 80, meanNet: 0.04 }, RISK_OFF: { n: 40, meanNet: 0.01 } },
  ...over,
});

const matched = (id: string, family: string, key: string, lower90: number, over = {}) => ({
  cell_id: id,
  family,
  angle_id: null,
  kind: "matched_cell",
  spec: { key },
  logged_at: T0,
  result_at: T1,
  result: cellStat(key, lower90, over),
  split: "development",
  lineage_id: null,
});

const map = (family: string, pHidden: boolean) => ({
  family,
  rule_version: `${family}.zz.1`,
  fitted_at: T1,
  active_set_hash: "h-zz",
  n_eff: 250,
  pool: family === "F1" || family === "F4" ? "F1+F4" : family,
  fit_split: "development",
  params: {
    a: 0.9,
    b: -0.2,
    s_mean: 0,
    s_sd: 0.5,
    K: 3,
    clusters: ["momentum", "liquidity", "event"],
    top3_min_s: 0.4,
    family_mean_net: 0.01,
    tiers: ["U1", "U2"],
    p_hidden: pHidden,
    gain: 0.1,
    loss: 0.06,
    slots: 1,
  },
});

const mdeRows = [
  { n_eff: 100, mde: 0.06 },
  { n_eff: 150, mde: 0.05 },
  { n_eff: 300, mde: 0.035 },
];

const ev = (family: string, over: Record<string, unknown> = {}) => ({
  family,
  n_eff: 260,
  brier_skill_lo90: 0.02,
  slope_ub90: 1.3,
  gate_cell_key: `${family}|top3|v2|U1`,
  mde: 0.04,
  mde_rows: mdeRows,
  n_eff_live_per_session: 2,
  ...over,
});

const passport = (angle: string, status: string, v = 1) => ({
  angle_id: angle,
  version: v,
  domain: 1,
  cluster: "momentum",
  orientation: 1,
  kind: "score",
  inputs: ["bar_au"],
  history_fields: {},
  status,
  horizon_sessions: 20,
  evidence: {},
  measured: null,
  frozen_at: T0,
});

/** F1 and F4 pass; F2 is untestable (n_eff 120); F3 has a non-positive bound; F7 would pass but is never allowed. */
export function artefactFiles(): ArtefactFiles {
  return {
    "manifest.json": {
      format: "praxis-cortex-artefact/1",
      market: "AU",
      created_at: "2030-02-01T00:00:00Z",
    },
    "passports.json": {
      passports: [
        passport("A-D1-01", "active"),
        passport("A-D1-02", "measured"),
        passport("A-D5-08", "measured"),
      ],
    },
    "cells.json": {
      cells: [
        matched("c-f1", "F1", "F1|top3|v2|U1", 0.01),
        matched("c-f2", "F2", "F2|top3|v2|U1", 0.01),
        matched("c-f3", "F3", "F3|top3|v2|U1", -0.01),
        matched("c-f4", "F4", "F4|top3|v2|U1", 0.012),
        matched("c-f7", "F7", "F7|top3|v2|U1", 0.01),
        {
          cell_id: "c-grid-1",
          family: "F1",
          angle_id: "A-D1-01",
          kind: "angle_ic",
          spec: {},
          logged_at: T0,
          result_at: T1,
          result: { p: 0.01 },
          split: "development",
          lineage_id: null,
        },
        {
          cell_id: "c-placebo",
          family: "all",
          angle_id: null,
          kind: "placebo",
          spec: {},
          logged_at: T0,
          result_at: T1,
          result: { passed: true, null_pass_rate: 0.04 },
          split: "development",
          lineage_id: null,
        },
        {
          cell_id: "c-nav",
          family: "all",
          angle_id: null,
          kind: "nav_at_risk",
          spec: {},
          logged_at: T0,
          result_at: T1,
          result: { loss_95_pct: 4.2, loss_worst_pct: 9.1 },
          split: "development",
          lineage_id: null,
        },
      ],
    },
    "maps.json": {
      maps: [
        map("F1", true),
        map("F2", false),
        map("F3", false),
        map("F4", false),
        map("F7", false),
      ],
    },
    "evidence.json": {
      as_of_d: "2030-02-01",
      families: [
        ev("F1", { slope_ub90: 0.9 }),
        ev("F2", { n_eff: 120 }),
        ev("F3", { brier_skill_lo90: 0.01 }),
        ev("F4", { n_eff: 230 }),
        ev("F7", { n_eff: 500 }),
      ],
    },
  };
}

export function writeArtefact(files: ArtefactFiles = artefactFiles()): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-art-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
