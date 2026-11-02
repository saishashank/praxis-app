// @vitest-environment node
// AT-54 (M15 P6; CTX-053, CTX-072, CTX-082, D-277, D-305, D-358): statement rows for the allowed
// families F1 and F4 marked "live-tested pending (n_eff_live = 0)" and shown by the page loader; the
// CTX-082 template; plain words; the luck figure; the evaluator as the only writer of `allowed`.
// Synthetic ZZ data only (SEC-110).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  allowedWeakRow,
  LIVE_PENDING_LABEL,
  liveTestedRow,
  luckChance,
  luckFigure,
  luckFigureFromLedger,
  statementProblems,
} from "@/lib/cortex/statements";
import { capAngleStatus, decideFamily, recordFamilyStatus } from "@/lib/cortex/status";
import { familyStatusHistory, getStatement, latestStatement } from "@/lib/cortex/store";
import { loadCortex } from "@/lib/ui/loaders/cortex";
import { run } from "../../../scripts/cortex/import.mjs";
import { cleanupTempDbs } from "../../db/helpers";
import { emptyWorld, NOW } from "../../loaders/world";
import { artefactFiles, writeArtefact } from "./zzP6";

afterAll(cleanupTempDbs);

async function importedWorld() {
  const w = await emptyWorld();
  const a = writeArtefact();
  const code = await run(
    [a.dir],
    { TURSO_MAIN_URL: "file:zz", TURSO_MAIN_TOKEN: "x" },
    {
      out: () => undefined,
      openDb: () => ({
        execute: (s: never) => w.main.execute(s),
        batch: (s: never, m: never) => w.main.batch(s, m),
        close: () => undefined,
      }),
    },
  );
  a.cleanup();
  expect(code).toBe(0);
  return w;
}

describe("AT-54 allowed-to-trade statements for F1 and F4", () => {
  it("each carries n_eff_live = 0, the pending label and the projected time to 100 and 150", async () => {
    const w = await importedWorld();
    for (const f of ["F1", "F4"] as const) {
      const s = await latestStatement(w.main, "AU", f);
      expect(s).not.toBeNull();
      expect(s!.kind).toBe("allowed_weak");
      expect(s!.nEffLive).toBe(0);
      expect(s!.text).toContain("allowed to trade (weak test)");
      expect(s!.text).toContain(LIVE_PENDING_LABEL);
      // 2 live cases a session: 50 sessions to 100, 75 to 150.
      expect(s!.text).toContain("about 50 sessions");
      expect(s!.text).toContain("about 75 sessions");
      expect(statementProblems(s!.text)).toEqual([]);
      expect(s!.numbers).toMatchObject({ n_eff_live: 0, sessions_to_100: 50, sessions_to_150: 75 });
    }
    expect(await latestStatement(w.main, "AU", "F2")).toBeNull();
    expect(await latestStatement(w.main, "AU", "F7")).toBeNull();
  });

  it("the page loader shows the statement, the status and n_eff for the allowed families only", async () => {
    const w = await importedWorld();
    const view = await loadCortex({
      mainDb: w.main,
      authDb: w.auth,
      user: { id: w.ids.owner, role: "owner" },
      now: NOW,
    });
    const fams = view.data.families;
    const f1 = fams.find((f) => f.name.startsWith("F1"))!;
    const f4 = fams.find((f) => f.name.startsWith("F4"))!;
    const f2 = fams.find((f) => f.name.startsWith("F2"))!;
    for (const f of [f1, f4]) {
      expect(f.status).toBe("allowed");
      expect(f.statement).toContain(LIVE_PENDING_LABEL);
      expect(f.nEff).not.toBeNull();
      expect(f.mde).not.toBeNull();
    }
    expect(f2.status).toBe("shadow");
    expect(f2.statement).toBeNull();
    // the placebo and NAV-at-risk cells of the import reach the page (D-357)
    expect(view.data.placebo?.passed).toBe(true);
    expect(view.data.navAtRisk).not.toBeNull();
  });
});

describe("AT-54 CTX-082 live-tested template", () => {
  const ci = (point: number, lo: number, hi: number) => ({ point, lo, hi });
  const input = (over: Record<string, unknown> = {}) => ({
    market: "AU",
    createdAt: "2031-06-01T00:00:00Z",
    family: "F1",
    fromD: "2030-02-01",
    nCases: 210,
    nEffLive: 160,
    ece: ci(0.03, 0.01, 0.05),
    slope: ci(0.95, 0.7, 1.2),
    intercept: ci(0.01, -0.1, 0.1),
    skill: ci(0.04, 0.01, 0.07),
    excess: ci(0.012, 0.002, 0.022),
    survivorship: "a stated haircut of 1.5 percentage points",
    ...over,
  });

  it("is not publishable below n_eff_live 150, whatever the other numbers say", () => {
    const r = liveTestedRow(input({ nEffLive: 149 }));
    expect(r.publishable).toBe(false);
    expect(r.draft.criteria.n_eff_live).toBe(false);
  });

  it("is publishable at 150 when every criterion holds, in plain words, with ECE reported but not a criterion", () => {
    const r = liveTestedRow(input({ nEffLive: 150 }));
    expect(r.publishable).toBe(true);
    if (!r.publishable) return;
    expect(r.row.kind).toBe("live_tested");
    expect(r.row.text).toContain("On the live paper period from 2030-02-01 (210 comparable cases)");
    expect(r.row.text).toContain("do not predict any single trade");
    expect(statementProblems(r.row.text)).toEqual([]);
    expect(Object.keys(r.draft.criteria).some((k) => /ece/i.test(k))).toBe(false);
  });

  it("each criterion blocks it: skill bound, slope CI around 1, intercept CI around 0, net-excess bound", () => {
    expect(liveTestedRow(input({ skill: ci(0.04, -0.01, 0.07) })).publishable).toBe(false);
    expect(liveTestedRow(input({ slope: ci(0.6, 0.4, 0.9) })).publishable).toBe(false);
    expect(liveTestedRow(input({ intercept: ci(0.2, 0.1, 0.3) })).publishable).toBe(false);
    expect(liveTestedRow(input({ excess: ci(0.01, -0.002, 0.02) })).publishable).toBe(false);
  });
});

describe("AT-54 plain words and the luck figure", () => {
  it("the banned terms are caught, the template is clean", () => {
    expect(statementProblems("this is certain and will work")).not.toEqual([]);
    expect(statementProblems("the lower bound of n_eff")).not.toEqual([]);
    const row = allowedWeakRow({
      market: "AU",
      family: "F1",
      createdAt: "2030-02-01T00:00:00Z",
      nEffLivePerSession: null,
    });
    expect(statementProblems(row.text)).toEqual([]);
    expect(row.text).toContain("pace of live cases has not been measured");
  });

  it("the chance that at least one of seven lineages is allowed by luck is about 52 % (weak) and 30 % (strict)", () => {
    expect(luckChance(7, 0.1)).toBeCloseTo(0.5217, 4);
    expect(luckChance(7, 0.05)).toBeCloseTo(0.3017, 4);
    const row = allowedWeakRow({
      market: "AU",
      family: "F1",
      createdAt: "2030-02-01T00:00:00Z",
      nEffLivePerSession: 2,
    });
    expect(row.text).toContain("about 52%");
  });

  it("ideas tried x ledger_fdr_q, counted from the ledger with the Owner key edits", async () => {
    expect(luckFigure(40, 5, 0.1)).toMatchObject({
      trials: 45,
      text: "Of 45 ideas tried, about 4.5 would look good by luck alone.",
    });
    expect(luckFigure(300, 0, 0.1).text).toBe(
      "Of 300 ideas tried, about 30 would look good by luck alone.",
    );
    const w = await importedWorld();
    await w.main.execute(
      `INSERT INTO cortex_ledger_cell (cell_id, market, family, kind, spec_json, logged_at, split)
       VALUES ('ke1','AU','all','key_edit','{}','2030-03-01T00:00:00Z','development')`,
    );
    const f = await luckFigureFromLedger(w.main, "AU", 0.1);
    expect(f.trials).toBe(9); // 8 imported cells + 1 key edit
    expect(f.text).toBe("Of 9 ideas tried, about 0.9 would look good by luck alone.");
  });
});

describe("AT-54 only the evaluator moves a family to allowed (CTX-072, D-305)", () => {
  const cell = {
    n: 120,
    blocks: 24,
    nEff: 150,
    lower90: 0.01,
    byRegime: { A: { n: 60, meanNet: 0.02 } },
  };
  const verdict = (family: string, over = {}) =>
    decideFamily({ family, nEff: 250, brierLo90: 0.02, slopeUb90: 1.3, cell, ...over });

  it("recordFamilyStatus writes the row and the statement; the same date is not written twice; a kill is kept", async () => {
    const w = await emptyWorld();
    const first = await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F1",
      sinceD: "2030-02-01",
      decision: verdict("F1"),
      createdAt: "2030-02-01T00:00:00Z",
      nEffLivePerSession: 2,
    });
    expect(first).toMatchObject({ written: true, status: "allowed" });
    const hist = await familyStatusHistory(w.main, "AU", "F1");
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ status: "allowed", setBy: "evaluator" });
    expect((hist[0]!.evidence as { n_eff: number }).n_eff).toBe(250);
    expect(await getStatement(w.main, hist[0]!.statementId!)).not.toBeNull();
    const again = await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F1",
      sinceD: "2030-02-01",
      decision: verdict("F1"),
      createdAt: "2030-02-01T00:00:00Z",
      nEffLivePerSession: 2,
    });
    expect(again).toEqual({ written: false, reason: "exists" });
    const same = await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F1",
      sinceD: "2030-02-02",
      decision: verdict("F1"),
      createdAt: "2030-02-02T00:00:00Z",
      nEffLivePerSession: 2,
    });
    expect(same).toEqual({ written: false, reason: "unchanged" });
    await w.main.execute(
      `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
       VALUES ('AU','F1','2030-02-03','suspended','{}','owner_kill')`,
    );
    const afterKill = await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F1",
      sinceD: "2030-02-04",
      decision: verdict("F1", { brierLo90: -1 }),
      createdAt: "2030-02-04T00:00:00Z",
      nEffLivePerSession: 2,
    });
    expect(afterKill).toEqual({ written: false, reason: "suspended" });
  });

  it("a family that fails the rules is recorded as shadow after having been allowed", async () => {
    const w = await emptyWorld();
    await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F4",
      sinceD: "2030-02-01",
      decision: verdict("F4"),
      createdAt: "2030-02-01T00:00:00Z",
      nEffLivePerSession: null,
    });
    const r = await recordFamilyStatus(w.main, {
      market: "AU",
      family: "F4",
      sinceD: "2030-03-01",
      decision: verdict("F4", { brierLo90: -0.01 }),
      createdAt: "2030-03-01T00:00:00Z",
      nEffLivePerSession: null,
    });
    expect(r).toMatchObject({ written: true, status: "shadow", statementId: null });
  });

  it("F7 is never allowed, and the 0019 CHECK agrees", async () => {
    expect(verdict("F7").status).toBe("shadow");
    const w = await emptyWorld();
    await expect(
      w.main.execute(
        `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
         VALUES ('AU','F7','2030-02-01','allowed','{}','evaluator')`,
      ),
    ).rejects.toThrow();
  });

  it("A-D5-08 is measured at most until 60 live sessions (D-305)", () => {
    expect(capAngleStatus("A-D5-08", "active", 0)).toBe("measured");
    expect(capAngleStatus("A-D5-08", "active", 59)).toBe("measured");
    expect(capAngleStatus("A-D5-08", "active", 60)).toBe("active");
    expect(capAngleStatus("A-D5-08", "candidate", 0)).toBe("candidate");
    expect(capAngleStatus("A-D1-01", "active", 0)).toBe("active");
  });

  it("static: the only source file that writes a family status is the evaluator (and the import script)", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    const writers = walk("src")
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
      .filter((f) =>
        /insertFamilyStatus|INSERT INTO family_status/.test(
          readFileSync(path.join(root, f), "utf8"),
        ),
      )
      .map((f) => f.replaceAll("\\", "/"));
    expect(writers.sort()).toEqual(["src/lib/cortex/status.ts", "src/lib/cortex/store/status.ts"]);
    expect(
      artefactFiles()["evidence.json"].families.some((f: Record<string, unknown>) => "status" in f),
    ).toBe(false);
  });
});
