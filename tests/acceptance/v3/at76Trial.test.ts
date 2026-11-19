// @vitest-environment node
// AT-76 / AT-36 (M22 C2; VAL-111, UXN-290; D-1420…D-1423): the Committee trial on a recorded-day CI fixture with the switch on.
//   (i)   random labels: not significant, never a PASS;
//   (ii)  correlated labels: PASS, and the Committee switches itself off with the one look on file;
//   (iii) a second pre-registration version after the first rated night: INVALID, an alert, no look;
//   (iv)  a judge change whose segment of at least 50 settled signals reverses the sign: no PASS (and the same data without
//         the reversal does PASS);
//   plus: a past date and a replay are refused (the step, the command line and the engine), the verdict is looked at once,
//   and no rating reaches a card, a pick, an e-mail template or a review (static scan and rendered models).
// Synthetic ZZ data over the real migrations.
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { committeeNight } from "@/lib/committee/night";
import { frozenText, shaOf } from "@/lib/committee/prereg";
import { trialNight } from "@/lib/committee/trial";
import { trialMain } from "@/lib/committee/trialCli";
import { getConfig } from "@/lib/config/store";
import { roundTripThresholdPpm } from "@/lib/stats/committeeCost";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";
import { loadCardPage } from "@/lib/ui/loaders/cards";
import { loadIdeas } from "@/lib/ui/loaders/ideas";
import { cleanupTempDbs } from "../../db/helpers";
import {
  committeeLlm,
  committeeProvider,
  nightOptions,
  seedNight,
  D,
} from "../../committee/harness";
import { build, dayOf, FROZEN, NOW, switchOn, TRIAL, type Spec } from "../../committee/trialWorld";
import {
  CARD_UP,
  deps as loaderDeps,
  emptyDbs,
  OWNER,
  seedPopulated,
  SIG_UP,
} from "../../loaders/seed";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
afterEach(cleanupTempDbs);

const NIGHTS = 40;
const FIXTURE = {
  trial_sessions: NIGHTS,
  min_settled: 100,
  permutations: 2000,
  cost_threshold_ppm: roundTripThresholdPpm(),
};
const at = (night: number) => ({ market: "AU", d: dayOf(night), today: dayOf(night), now: NOW });

/** `nights` nights of one approve, one neutral and one reject, labels in a seeded random order. */
function synthetic(
  scope: string,
  nights: number,
  outcome: (label: "approve" | "neutral" | "reject", noise: number, night: number) => number,
  judge: (night: number) => string = () => "zz-judge",
  randomLabels = false,
): Spec[] {
  const rng = scopedPrng(`at36:${scope}`);
  const noise = (): number => Math.round((uniform01(rng) - 0.5) * 40_000); // ppm, +-2 %
  const out: Spec[] = [];
  for (let n = 0; n < nights; n++) {
    const labels: ("approve" | "neutral" | "reject")[] = ["approve", "neutral", "reject"];
    const outs = labels.map((l) => outcome(l, noise(), n));
    if (randomLabels)
      for (let i = labels.length - 1; i > 0; i--) {
        const j = Math.floor(uniform01(rng) * (i + 1));
        [labels[i], labels[j]] = [labels[j]!, labels[i]!];
      }
    labels.forEach((rating, i) => out.push({ night: n, rating, net: outs[i]!, judge: judge(n) }));
  }
  return out;
}

const finalRow = async (db: Client) =>
  (await db.execute("SELECT verdict, stats_json FROM committee_trial_result WHERE kind = 'final'"))
    .rows[0];
const stats = (r: Record<string, unknown> | undefined) =>
  JSON.parse(String(r?.stats_json ?? "{}")) as Record<string, unknown>;

describe("AT-36 (i): random labels are not significant", () => {
  it("outcomes unrelated to the labels give no PASS and a p above 0.05", async () => {
    const specs = synthetic("random", NIGHTS, (_l, noise) => noise, undefined, true);
    const db = await build(specs, { frozen: FIXTURE });
    await switchOn(db);
    const r = await trialNight(db, at(NIGHTS));
    expect(r).toMatchObject({ status: "final", verdict: "FAIL" });
    const s = stats(await finalRow(db));
    expect(s.reason).toBe("not_significant");
    expect(s.p as number).toBeGreaterThanOrEqual(0.05);
    expect(s.settled).toBe(NIGHTS * 3);
  });
});

describe("AT-36 (ii): correlated labels pass", () => {
  it("approved signals that beat rejected ones by 6 % pass, the look is written once and the Committee goes off", async () => {
    const specs = synthetic(
      "correlated",
      NIGHTS,
      (l, noise) => (l === "approve" ? 30_000 : l === "reject" ? -30_000 : 0) + noise,
    );
    const db = await build(specs, { frozen: FIXTURE });
    await switchOn(db);
    expect(await getConfig(db, "committee_enabled")).toBe("on");
    const r = await trialNight(db, at(NIGHTS));
    expect(r).toEqual({ status: "final", trialId: TRIAL, verdict: "PASS" });
    const s = stats(await finalRow(db));
    expect(s).toMatchObject({ reason: "passed", reversal: false, nights: NIGHTS });
    expect(s.p as number).toBeLessThan(0.05);
    expect(s.d_ppm as number).toBeGreaterThan(FIXTURE.cost_threshold_ppm);
    expect((await db.execute("SELECT lineage, verdict FROM holdout_look")).rows).toEqual([
      { lineage: "committee_trial", verdict: "PASS" },
    ]);
    expect(await getConfig(db, "committee_enabled")).toBe("off");
    // the engine rates nothing once the final verdict is on file
    const world = await seedNight(db);
    const res = await committeeNight(
      world,
      nightOptions(committeeLlm([committeeProvider("alpha"), committeeProvider("beta")])),
    );
    expect(res.status).toBe("trial_done");
    // the one look is never repeated
    expect(await trialNight(db, at(NIGHTS + 1))).toEqual({ status: "finished" });
    expect((await db.execute("SELECT COUNT(*) n FROM holdout_look")).rows[0]!.n).toBe(1);
    expect(
      (await db.execute("SELECT COUNT(*) n FROM committee_trial_result WHERE kind = 'final'"))
        .rows[0]!.n,
    ).toBe(1);
  });

  it("nights before the end write interim rows only, each labelled interim, not a result", async () => {
    const specs = synthetic(
      "correlated",
      12,
      (l, noise) => (l === "approve" ? 30_000 : l === "reject" ? -30_000 : 0) + noise,
    );
    const db = await build(specs, { frozen: FIXTURE });
    await switchOn(db);
    for (const n of [3, 6, 11]) expect((await trialNight(db, at(n))).status).toBe("running");
    const rows = (
      await db.execute("SELECT d, kind, verdict, stats_json FROM committee_trial_result ORDER BY d")
    ).rows;
    expect(rows.map((r) => [r.kind, r.verdict])).toEqual([
      ["interim", "running"],
      ["interim", "running"],
      ["interim", "running"],
    ]);
    for (const r of rows) expect(stats(r).note).toBe("interim, not a result");
    expect(await getConfig(db, "committee_enabled")).toBe("on");
  });
});

describe("AT-36 (iii): an edited pre-registration is INVALID", () => {
  it("a second version after the first rated night ends the trial with an alert, no look and the switch off", async () => {
    const db = await build(
      synthetic("edit", 5, (l, noise) => (l === "approve" ? 30_000 : 0) + noise),
      { frozen: FIXTURE },
    );
    await switchOn(db);
    expect((await trialNight(db, at(2))).status).toBe("running");
    const text = frozenText({ ...FROZEN, ...FIXTURE, min_settled: 20 }); // the hypothesis was loosened
    await db.execute({
      sql: "INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES (?, 2, 'AU', ?, ?, ?)",
      args: [TRIAL, text, shaOf(text), NOW],
    });
    expect(await trialNight(db, at(5))).toEqual({
      status: "final",
      trialId: TRIAL,
      verdict: "INVALID",
    });
    expect((await finalRow(db))!.verdict).toBe("INVALID");
    const alert = (
      await db.execute(
        "SELECT level, source, message FROM app_log WHERE source = 'committee-trial'",
      )
    ).rows;
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ level: "warn" });
    expect(String(alert[0]!.message)).toMatch(
      /is invalid.*edited after the trial started.*switched off/,
    );
    expect((await db.execute("SELECT COUNT(*) n FROM holdout_look")).rows[0]!.n).toBe(0);
    expect(await getConfig(db, "committee_enabled")).toBe("off");
  });
});

describe("AT-36 (iv): a judge change with a sign flip on a segment of 50 or more is never a PASS", () => {
  const SESSIONS = 60;
  const frozen = { ...FIXTURE, trial_sessions: SESSIONS };
  const judge = (n: number) => (n < 36 ? "judge-a" : "judge-b");
  const world = (sign: number) =>
    synthetic(
      `judge${sign}`,
      SESSIONS,
      (l, noise, n) => {
        const edge = n < 36 ? 50_000 : sign * 4_000; // judge-b: a small gap, the wrong way round when sign is -1
        return (l === "approve" ? edge : l === "reject" ? -edge : 0) + Math.round(noise / 4);
      },
      judge,
    );

  it("the data with the reversed segment is not a PASS, and says why", async () => {
    const db = await build(world(-1), { frozen });
    await switchOn(db);
    const r = await trialNight(db, at(SESSIONS));
    expect(r).toMatchObject({ status: "final", verdict: "FAIL" });
    const s = stats(await finalRow(db));
    expect(s.reason).toBe("reversal");
    expect(s.reversal).toBe(true);
    expect(s.p as number).toBeLessThan(0.05); // significant overall, yet not a PASS
    expect(s.d_ppm as number).toBeGreaterThan(FIXTURE.cost_threshold_ppm);
    const seg = s.segments as { model: string; n: number; d_ppm: number }[];
    expect(seg.map((x) => [x.model, x.n])).toEqual([
      ["judge-a", 108],
      ["judge-b", 72],
    ]);
    expect(seg.find((x) => x.model === "judge-b")!.d_ppm).toBeLessThan(0);
  });

  it("the same data without the sign flip passes (the check is not vacuous)", async () => {
    const db = await build(world(1), { frozen });
    await switchOn(db);
    expect(await trialNight(db, at(SESSIONS))).toMatchObject({ status: "final", verdict: "PASS" });
  });
});

describe("AT-36: forward only", () => {
  it("a past date, a future date and a replay are refused by the step, the command line and the engine", async () => {
    const db = await build(
      synthetic("fwd", 4, (_l, n) => n),
      { frozen: FIXTURE },
    );
    await switchOn(db);
    expect(await trialNight(db, { ...at(4), today: dayOf(9) })).toEqual({ status: "refused" });
    expect(await trialNight(db, { ...at(9), today: dayOf(4) })).toEqual({ status: "refused" });
    expect(await trialNight(db, { ...at(4), replay: true })).toEqual({ status: "refused" });
    const lines: string[] = [];
    const proxy = new Proxy(db, {
      get: (t, k) =>
        k === "close"
          ? () => undefined
          : typeof Reflect.get(t, k) === "function"
            ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t)
            : Reflect.get(t, k),
    });
    await trialMain(
      ["result", "--date", "2026-01-01"],
      { TURSO_MAIN_URL: "x" },
      {
        openDb: () => proxy,
        nowMs: () => Date.parse("2026-06-30T01:00:00Z"),
        out: (l) => lines.push(l),
      },
    );
    expect(lines[0]).toMatch(/refused \(not the current session/);
    expect((await db.execute("SELECT COUNT(*) n FROM committee_trial_result")).rows[0]!.n).toBe(0);
    const night = await seedNight();
    await build([], { db: night });
    const llm = committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]);
    expect(
      (await committeeNight(night, { ...nightOptions(llm), today: "2026-03-05" })).status,
    ).toBe("refused_date");
    expect((await committeeNight(night, { ...nightOptions(llm), replay: true })).status).toBe(
      "refused_replay",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// UXN-290 / D-1423: a rating is never shown on a card, a pick, an e-mail or a review

const ROOT = path.resolve(import.meta.dirname, "../../..");
const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(path.join(ROOT, dir))) return out;
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
};
const code = (f: string): string =>
  fs
    .readFileSync(path.join(ROOT, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("ratings are absent from cards, picks, e-mails and reviews (D-1423)", () => {
  const SURFACES = [
    ...walk("src/lib/email"),
    ...walk("src/lib/email/templates"),
    ...walk("src/lib/picks"),
    ...walk("src/app/(app)/cards"),
    ...walk("src/app/(app)/picks"),
    ...walk("src/app/(app)/reviews"),
    "src/lib/ui/loaders/cards.ts",
    "src/lib/ui/loaders/cardParts.ts",
    "src/lib/ui/loaders/picks.ts",
    "src/lib/ui/loaders/pickAlerts.ts",
    "src/lib/ui/loaders/reviews.ts",
    "src/lib/ui/loaders/ideas.ts",
    "src/lib/ui/loaders/home.ts",
    "src/lib/review/sections.ts",
    "src/lib/view/cards.ts",
    "src/lib/agents/cards.ts",
  ].filter((f, i, a) => a.indexOf(f) === i && fs.existsSync(path.join(ROOT, f)));

  it("the scan covers the card, pick, e-mail template and review sources", () => {
    expect(SURFACES.length).toBeGreaterThan(30);
    for (const must of [
      "src/lib/email/templates/core.ts",
      "src/lib/ui/loaders/cards.ts",
      "src/lib/ui/loaders/picks.ts",
      "src/lib/email/pickMail.ts",
    ])
      expect(SURFACES, must).toContain(must);
  });

  it("none of them names a Committee table, imports the Committee, or reads a rating", () => {
    const bad = SURFACES.filter((f) =>
      /committee_(rating|call|prereg|trial_result)|@\/lib\/committee|loaders\/committee|health\/committee/i.test(
        code(f),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("only the trial page loader and the trial page read a rating", () => {
    const readers = [...walk("src/lib/ui"), ...walk("src/app")].filter((f) =>
      /committee_rating/.test(code(f)),
    );
    expect(readers).toEqual(["src/lib/ui/loaders/committee.ts"]);
  });

  it("rendered: a card and the all-signals page carry no rating while the trial holds ratings for the same signals", async () => {
    const db = await emptyDbs();
    await seedPopulated(db);
    const marker = "ZZ-COMMITTEE-MARKER";
    await db.main.execute({
      sql: `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES ('zz-r', 1, 'AU', '{}', ?, ?)`,
      args: ["c".repeat(64), "2026-10-01T00:00:00.000Z"],
    });
    await db.main.execute({
      sql: `INSERT INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json, bull_model, bear_model,
              risk_model, judge_model, same_family, timings_json, created_at)
            VALUES ('AU', '2026-10-19', ?, 'zz-r', 'p1', 'reject', ?, 'm1', 'm2', 'm1', 'm3', 0, '{}', '2026-10-19T08:00:00.000Z')`,
      args: [SIG_UP, JSON.stringify([{ text: marker, citations: ["E01"] }])],
    });
    const card = JSON.stringify(await loadCardPage(loaderDeps(db, OWNER), CARD_UP));
    const ideas = JSON.stringify(await loadIdeas(loaderDeps(db, OWNER)));
    for (const page of [card, ideas]) {
      expect(page.length).toBeGreaterThan(500); // the pages are real, not empty
      expect(page).not.toContain(marker);
      expect(page).not.toMatch(/committee/i);
      expect(page).not.toContain('"reject"');
    }
  });
});

describe("the D constants line up with the pre-registration text", () => {
  it("the fixture's cost bar is the one a new trial would freeze", () => {
    expect(FIXTURE.cost_threshold_ppm).toBe(roundTripThresholdPpm());
    expect(D).toBe("2026-03-04"); // the harness night used for the engine checks
  });
});
