// @vitest-environment node
// Learning-loop config (cortex_learning_architecture C.9) and the numeric-threshold guard for the new
// src/lib/cortex/learn module (same scanner rule as tests/agents/noMagicThresholds.test.ts: a numeric
// literal other than 0, 1, -1, 2 needs `// threshold-ok: <reason>` on its line).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEARN_CONFIG, LEARN_CONFIG_SPEC, learnConfig } from "@/lib/cortex/learn/config";

const C9: Record<string, [number, number, number]> = {
  learn_window_sessions: [60, 40, 120],
  learn_null_sessions: [120, 60, 250],
  learn_shrink_n0: [60, 20, 200],
  learn_dev_haircut: [0.5, 0.3, 1.0],
  learn_max_step: [0.25, 0.1, 0.5],
  learn_weight_floor: [0.25, 0, 0.5],
  learn_band_pp: [2, 0, 5],
  learn_fdr_q: [0.1, 0.05, 0.2],
  learn_probe_q: [0.05, 0.01, 0.1],
  learn_ph_delta: [0.005, 0.001, 0.02],
  learn_ph_fa_pct: [99, 95, 99.9],
  learn_cap_sessions: [10, 5, 20],
  learn_actions_week_max: [3, 1, 6],
  learn_switch_alpha: [0.05, 0.01, 0.1],
  learn_fallback_alpha: [0.1, 0.05, 0.25],
  learn_switch_min_nights: [40, 20, 100],
  learn_cooldown_sessions: [20, 10, 60],
  learn_psi_break: [0.25, 0.1, 0.5],
  learner_off: [0, 0, 1],
};

describe("learn config", () => {
  it("reproduces every C.9 row (default and bounds)", () => {
    const rows = Object.values(LEARN_CONFIG_SPEC).filter((s) => s.source === "C.9");
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(C9).sort());
    for (const r of rows) expect([r.default, r.min, r.max], r.key).toEqual(C9[r.key]);
    for (const [k, s] of Object.entries(LEARN_CONFIG_SPEC)) {
      expect(LEARN_CONFIG[k as keyof typeof LEARN_CONFIG]).toBe(s.default);
      expect(s.default).toBeGreaterThanOrEqual(s.min);
      expect(s.default).toBeLessThanOrEqual(s.max);
    }
    expect(LEARN_CONFIG.clusterWeightMax).toBe(0.35);
    expect(Object.isFrozen(LEARN_CONFIG)).toBe(true);
  });

  it("overrides inside the bounds are taken; outside, non-integer or inconsistent ones are refused", () => {
    expect(learnConfig({ windowSessions: 120, maxStep: 0.1 }).windowSessions).toBe(120);
    expect(learnConfig({ windowSessions: undefined }).windowSessions).toBe(60);
    expect(() => learnConfig({ windowSessions: 30 })).toThrow(/learn_window_sessions/);
    expect(() => learnConfig({ maxStep: Number.NaN })).toThrow(RangeError);
    expect(() => learnConfig({ capSessions: 7.5 })).toThrow(/integer/);
    expect(() => learnConfig({ formK: 10, formN: 8 })).toThrow(/learn_form_k/);
    expect(() => learnConfig({ nope: 1 } as never)).toThrow(/unknown/);
    expect(() => learnConfig({ replicates: 10 })).toThrow(RangeError);
    expect(learnConfig({ replicates: 10 }, { relaxed: true }).replicates).toBe(10);
  });
});

// ---- numeric-threshold guard for src/lib/cortex/learn -------------------------------------------------
const ROOT = path.resolve(__dirname, "../../..");
const DIR = path.join(ROOT, "src/lib/cortex/learn");
const ALLOWED = new Set(["0", "1", "-1", "2"]);
const MARKER = /\/\/\s*threshold-ok:\s*\S/;

function numericLiterals(line: string): string[] {
  const code = line
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const out: string[] = [];
  const re = /(?<![\w$.])(-?)(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-f]+)(n?)(?![\w$])/gi;
  for (const m of code.matchAll(re)) {
    const text = m[2]!.replace(/_/g, "");
    const before = code.slice(0, m.index).trimEnd();
    const negative = m[1] === "-" && (before === "" || /[(,=:?<>!&|+*/%[-]$/.test(before));
    out.push(negative ? `-${text}` : text);
  }
  return out;
}

describe("every numeric threshold in src/lib/cortex/learn is a config key or marked", () => {
  it("the scanner works", () => {
    expect(numericLiterals("if (n >= 40) x();")).toEqual(["40"]);
    expect(numericLiterals('const s = "40"; // 7')).toEqual([]);
  });
  it("no unmarked literal", () => {
    const found: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".ts"))) {
      let inBlock = false;
      readFileSync(path.join(DIR, f), "utf8")
        .split(/\r?\n/)
        .forEach((raw, i) => {
          let line = raw;
          if (inBlock) {
            const end = line.indexOf("*/");
            if (end < 0) return;
            inBlock = false;
            line = line.slice(end + 2);
          }
          const open = line.indexOf("/*");
          if (open >= 0 && line.indexOf("*/", open) < 0) {
            inBlock = true;
            line = line.slice(0, open);
          }
          if (MARKER.test(raw)) return;
          const bad = numericLiterals(line).filter((n) => !ALLOWED.has(n));
          if (bad.length > 0) found.push(`${f}:${i + 1}: ${bad.join(", ")}`);
        });
    }
    expect(found).toEqual([]);
  });
});
