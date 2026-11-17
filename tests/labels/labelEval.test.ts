// @vitest-environment node
// The automatic label evaluation (M23 M3; CXA-008, D-1636, D-1722; hand-off from T2): the plan file and the code agree, the golden
// floor counts before any outcome is read (499 reads nothing, 500 takes the look), the look is taken once per label, a sample that
// is too short writes nothing and waits for the first session of a month, the agreement test is the second condition, and the
// `ann_labels` look that waited for coverage is taken here only when the panel is wired and coverage is enough.
// Synthetic ZZ data only (SEC-110).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGREEMENT_THRESHOLD, type AgreementResult } from "@/lib/labels/agreement";
import {
  ANN_LABELS_LINEAGE,
  ANN_LABEL_KEYS,
  ANN_METER_LINEAGE,
  ANN_PLAN_PATH,
  ANN_SESSION_FLOOR,
} from "@/lib/research/lineages/annAngles";
import {
  LABEL_HORIZON,
  LABEL_KINDS,
  LABEL_STRATUM_FLOOR,
  LABEL_VALUE,
  LABELS_PLAN_PATH,
  evaluateLabel,
  labelLineage,
  labelVerdict,
  type LabelObs,
} from "@/lib/research/lineages/labels";
import {
  firstSessionOfMonth,
  runAnnLabelsLate,
  runLabels,
  type LabelReader,
} from "@/lib/research/meters/labels";
import { preregister, sha256Hex } from "@/lib/research/registry";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const ROOT = join(__dirname, "../..");
const planText = readFileSync(join(ROOT, LABELS_PLAN_PATH), "utf8").replace(/\r\n/g, "\n");
const plan = JSON.parse(planText) as Record<string, unknown>;
const io = { read: (p: string) => (p === LABELS_PLAN_PATH ? planText : null) };
const M = "ZZ";
const noise = (i: number): number => (((i * 7) % 11) - 5) / 10;

function weekdays(n: number, start: string): string[] {
  const out: string[] = [];
  const t = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}
const DAYS = weekdays(60, "2031-01-27"); // Mon 27 Jan ... through March
const FEB1 = DAYS.find((d) => d.startsWith("2031-02"))!;
const MAR1 = DAYS.find((d) => d.startsWith("2031-03"))!;
const at = (d: string) => ({ market: M, d, now: `${d}T12:00:00Z` });

async function setup(golden: number): Promise<Client> {
  const db = await freshDb("main");
  await allowMarket(db, M);
  await db.batch(
    DAYS.map((d) => ({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, 'session', NULL, 1, 'test')",
      args: [M, d],
    })),
    "write",
  );
  const rows = Array.from({ length: golden }, (_, i) => ({
    sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone)
          VALUES (?, 'test', ?, '2031-01-02T00:00:00Z', 'owner', 'labelled', 'up', 'confirmed', 'positive')`,
    args: [M, `g${i}`],
  }));
  for (let i = 0; i < rows.length; i += 250) await db.batch(rows.slice(i, i + 250), "write");
  return db;
}

/** Announcements whose label value and 20-session outcome rise together (or fall together with a negative sign). */
function planted(sign: 1 | -1, count: number): LabelObs[] {
  return Array.from({ length: count }, (_, i) => {
    const label = [-1, 0, 1][i % 3]!;
    return {
      session: DAYS[i % 40]!,
      label,
      outcome: Math.round((sign * label * 0.02 + noise(i) * 0.01) * 1e6),
      ar: i % 2 === 0 ? 5000 : -5000,
    };
  });
}

const clears = (ok: boolean) => async (): Promise<AgreementResult> => ({
  market: M,
  items: 500,
  required: 500,
  threshold: AGREEMENT_THRESHOLD,
  byLabel: LABEL_KINDS.map((kind) => ({
    kind,
    n: 500,
    agree: ok ? 480 : 100,
    missing: 0,
    rate: ok ? 0.96 : 0.2,
    lower: ok ? 0.94 : 0.18,
    clears: ok,
  })),
});

const count = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("the plan file and the code agree", () => {
  it("floor, stratum floor, horizon, level, replicates, agreement threshold, coding and lineages", () => {
    expect(plan.floor_golden_items).toBe(500);
    expect(plan.stratum_floor).toBe(LABEL_STRATUM_FLOOR);
    expect(plan.horizon_sessions).toBe(LABEL_HORIZON);
    expect(plan.replicates).toBe(2000);
    expect(plan.level).toBe(0.1);
    expect(plan.agreement_threshold).toBe(AGREEMENT_THRESHOLD);
    expect(plan.lineages).toEqual(LABEL_KINDS.map(labelLineage));
    expect(LABEL_VALUE.guidance).toEqual({ down: -1, same: 0, up: 1 });
    expect(LABEL_VALUE.event_confirm).toEqual({ contradicted: -1, confirmed: 1 });
    expect(LABEL_VALUE.tone).toEqual({ negative: -1, neutral: 0, positive: 1 });
  });
});

describe("evaluateLabel (pure)", () => {
  it("a stratum under the floor is left out; with none left nothing is computed", () => {
    const few = planted(1, 2 * LABEL_STRATUM_FLOOR - 2); // 29 in each sign
    expect(evaluateLabel("tone", few)).toEqual({
      status: "below_sample",
      reason: "no sign of the abnormal return has enough announcements",
    });
  });

  it("a planted rank relation passes, its reverse and noise do not, a constant label is INCONCLUSIVE", () => {
    const up = evaluateLabel("tone", planted(1, 300), { replicates: 400 });
    const down = evaluateLabel("tone", planted(-1, 300), { replicates: 400 });
    if (up.status !== "looked" || down.status !== "looked") throw new Error("expected looks");
    expect(up.verdict).toBe("PASS");
    expect(up.strata).toBe(2);
    expect(up.meanIc!).toBeGreaterThan(0.5);
    expect(down.verdict).toBe("NULL");
    const flat = planted(1, 300).map((o) => ({ ...o, label: 1 }));
    const c = evaluateLabel("tone", flat, { replicates: 400 });
    if (c.status !== "looked") throw new Error("expected a look");
    expect(c.verdict).toBe("INCONCLUSIVE");
    expect(c.lowerIc).toBeNull();
  });

  it("is deterministic; the agreement test is the second condition", () => {
    const a = evaluateLabel("guidance", planted(1, 200), { replicates: 300 });
    const b = evaluateLabel("guidance", planted(1, 200), { replicates: 300 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(labelVerdict("PASS", true)).toBe("PASS");
    expect(labelVerdict("PASS", false)).toBe("NULL");
    expect(labelVerdict("NULL", true)).toBe("NULL");
    expect(labelVerdict("INCONCLUSIVE", true)).toBe("INCONCLUSIVE");
  });
});

describe("runLabels on a database", () => {
  it("499 golden items: the plan is frozen, three meters read collecting, no outcome is read, no look", async () => {
    const db = await setup(499);
    const reader = vi.fn<LabelReader>(async () => planted(1, 300));
    const out = await runLabels(db, at(FEB1), { io, reader, agreementOf: clears(true) });
    expect(out.map((x) => x.status)).toEqual(["collecting", "collecting", "collecting"]);
    expect(out.every((x) => x.n === 499)).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    const shas = (await db.execute("SELECT DISTINCT sha FROM research_prereg")).rows;
    expect(shas.map((r) => String(r.sha))).toEqual([sha256Hex(planText)]);
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg WHERE item = 'CXA-008'")).toBe(
      3,
    );
  });

  it("500 golden items: one look per label through the registry, PASS with the agreement, and none again", async () => {
    const db = await setup(500);
    const reader = vi.fn<LabelReader>(async () => planted(1, 300));
    const out = await runLabels(db, at(FEB1), { io, reader, agreementOf: clears(true) });
    expect(out.map((x) => [x.status, x.looked])).toEqual([
      ["looked", true],
      ["looked", true],
      ["looked", true],
    ]);
    expect(reader).toHaveBeenCalledTimes(3);
    const looks = (await db.execute("SELECT lineage, verdict FROM holdout_look ORDER BY lineage"))
      .rows;
    expect(looks.map((r) => `${r.lineage}:${r.verdict}`)).toEqual([
      "text_label_event_confirm:PASS",
      "text_label_guidance:PASS",
      "text_label_tone:PASS",
    ]);
    const stats = JSON.parse(
      String(
        (
          await db.execute(
            "SELECT stats_json FROM research_result WHERE lineage = 'text_label_tone'",
          )
        ).rows[0]!.stats_json,
      ),
    );
    expect(stats).toMatchObject({
      label: "tone",
      n: 300,
      strata: 2,
      agreementClears: 1,
      goldenItems: 500,
    });
    await runLabels(db, at(MAR1), { io, reader, agreementOf: clears(true) });
    expect(reader).toHaveBeenCalledTimes(3);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(3);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("a PASS statistic with agreement below the threshold is a NULL", async () => {
    const db = await setup(500);
    const reader: LabelReader = async () => planted(1, 300);
    await runLabels(db, at(FEB1), { io, reader, agreementOf: clears(false) });
    const v = (await db.execute("SELECT DISTINCT verdict FROM holdout_look")).rows;
    expect(v.map((r) => String(r.verdict))).toEqual(["NULL"]);
  });

  it("with the real agreement and no machine labels every item counts as a disagreement: NULL", async () => {
    const db = await setup(500);
    const reader: LabelReader = async () => planted(1, 300);
    await runLabels(db, at(FEB1), { io, reader });
    const v = (await db.execute("SELECT DISTINCT verdict FROM holdout_look")).rows;
    expect(v.map((r) => String(r.verdict))).toEqual(["NULL"]);
    const s = JSON.parse(
      String(
        (await db.execute("SELECT stats_json FROM research_result LIMIT 1")).rows[0]!.stats_json,
      ),
    );
    expect(s).toMatchObject({ agreementN: 500, agreementClears: 0 });
  });

  it("a sample that is too short writes nothing and is tried again on the first session of a month, not on other nights", async () => {
    const db = await setup(500);
    const reader = vi.fn<LabelReader>(async () => planted(1, 10));
    await runLabels(db, at(FEB1), { io, reader, agreementOf: clears(true) });
    expect(reader).toHaveBeenCalledTimes(3);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) n FROM research_result")).toBe(0);
    const next = DAYS[DAYS.indexOf(FEB1) + 1]!;
    await runLabels(db, at(next), { io, reader, agreementOf: clears(true) });
    expect(reader).toHaveBeenCalledTimes(3);
    // the first session of March: the sample is long enough now
    reader.mockImplementation(async () => planted(1, 300));
    await runLabels(db, at(MAR1), { io, reader, agreementOf: clears(true) });
    expect(reader).toHaveBeenCalledTimes(6);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(3);
  });

  it("a plan that cannot be read blocks the meters and takes no look", async () => {
    const db = await setup(500);
    const reader = vi.fn<LabelReader>(async () => planted(1, 300));
    const out = await runLabels(db, at(FEB1), { io: { read: () => null }, reader });
    expect(out.every((x) => x.status === "blocked")).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(0);
  });

  it("the first session of a month by the calendar", async () => {
    const db = await setup(0);
    expect(await firstSessionOfMonth(db, M, FEB1)).toBe(true);
    expect(await firstSessionOfMonth(db, M, DAYS[DAYS.indexOf(FEB1) + 1]!)).toBe(false);
  });
});

describe("the ann_labels look that waited for coverage (T2 hand-off)", () => {
  async function wire(db: Client, withMeter = true): Promise<void> {
    const annPlan = readFileSync(join(ROOT, ANN_PLAN_PATH), "utf8").replace(/\r\n/g, "\n");
    await preregister(db, {
      lineage: ANN_LABELS_LINEAGE,
      market: M,
      item: "CXA-004",
      frozen: annPlan,
      now: "2031-01-02T00:00:00Z",
    });
    const sessions = weekdays(ANN_SESSION_FLOOR, "2030-01-01");
    const rows = sessions.map((d, i) => ({
      sql: `INSERT INTO announcement_archive (market, code, source, ann_id, published_at, known_at, session_d, timing, type, price_sensitive, title)
            VALUES (?, 'ZA', 'test', ?, ?, ?, ?, 'intraday', NULL, 0, 'x')`,
      args: [M, `a${i}`, `${d}T01:00:00Z`, `${d}T02:00:00Z`, d],
    }));
    for (let i = 0; i < rows.length; i += 250) await db.batch(rows.slice(i, i + 250), "write");
    if (withMeter)
      await db.execute({
        sql: `INSERT INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at)
            VALUES (?, ?, '2031-01-30', ?, ?, NULL, 'met', '2031-01-30T00:00:00Z')`,
        args: [M, ANN_METER_LINEAGE, ANN_SESSION_FLOOR, ANN_SESSION_FLOOR],
      });
  }

  it("without a panel source nothing is read or taken", async () => {
    const db = await setup(0);
    await wire(db);
    expect(await runAnnLabelsLate(db, at(FEB1), {})).toBe("skipped");
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
  });

  it("short coverage: no look, the panel is not read, the plan stays frozen", async () => {
    const db = await setup(0);
    await wire(db);
    const panel = vi.fn();
    const labelCoverage = vi.fn(async () => ({ labelled: 69, items: 100 }));
    expect(await runAnnLabelsLate(db, at(FEB1), { panel, labelCoverage })).toBe("below_sample");
    expect(panel).not.toHaveBeenCalled();
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(1);
  });

  it("coverage of 70 % on the first session of a month takes the one look; later nights and months do not", async () => {
    const db = await setup(0);
    await wire(db);
    const reader = () => null;
    const panel = vi.fn(
      async (_db: Client, _m: string, _s: readonly string[], keys: readonly string[]) => {
        expect(keys).toEqual(ANN_LABEL_KEYS);
        return reader;
      },
    );
    const labelCoverage = vi.fn(async () => ({ labelled: 70, items: 100 }));
    // not the first session of the month: nothing
    const second = DAYS[DAYS.indexOf(FEB1) + 1]!;
    expect(await runAnnLabelsLate(db, at(second), { panel, labelCoverage })).toBe("skipped");
    expect(await runAnnLabelsLate(db, at(FEB1), { panel, labelCoverage })).toBe("looked");
    expect(panel).toHaveBeenCalledTimes(1);
    const look = (await db.execute("SELECT lineage, verdict FROM holdout_look")).rows;
    expect(look.map((r) => String(r.lineage))).toEqual([ANN_LABELS_LINEAGE]);
    expect(await runAnnLabelsLate(db, at(MAR1), { panel, labelCoverage })).toBe("skipped");
    expect(panel).toHaveBeenCalledTimes(1);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("the archive meter below its floor: nothing", async () => {
    const db = await setup(0);
    await wire(db, false);
    const panel = vi.fn();
    const out = await runAnnLabelsLate(db, at(FEB1), {
      panel,
      labelCoverage: async () => ({ labelled: 100, items: 100 }),
    });
    expect(out).toBe("skipped");
    expect(panel).not.toHaveBeenCalled();
  });
});

describe("the default reader (AU on far-future dates)", () => {
  it("reads the newest machine label, the announcement-day abnormal return and the 20-session outcome by hand; skips unmatured, unmapped and unpriced", async () => {
    const { staticProfile } = await import("@/lib/market/staticProfile.mjs");
    const { dbLabelReader } = await import("@/lib/research/meters/labels");
    const db = await freshDb("main");
    const A = "AU";
    const days = weekdays(60, "2045-01-02");
    await db.batch(
      days.map((d) => ({
        sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, 'session', NULL, 1, 'test')",
        args: [A, d],
      })),
      "write",
    );
    const ix = staticProfile(A).benchmarkIndex as string;
    const idxAt: Record<number, number> = { 4: 1000, 5: 1010, 25: 1111 };
    for (const [k, v] of Object.entries(idxAt))
      await db.execute({
        sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
        args: [
          A,
          ix,
          days[Number(k)]!,
          v,
          v,
          v,
          v,
          `${days[Number(k)]}T08:00:00Z`,
          `${days[Number(k)]}T08:00:00Z`,
        ],
      });
    const bar = (code: string, k: number, c: number) =>
      db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
        args: [A, code, days[k]!, c, c, c, c, `${days[k]}T08:00:00Z`, `${days[k]}T08:00:00Z`],
      });
    await bar("P1", 4, 100);
    await bar("P1", 5, 102);
    for (let k = 6; k <= 25; k += 1) await bar("P1", k, k === 25 ? 110.5 : 103);
    const ann = (id: string, code: string, k: number) =>
      db.execute({
        sql: `INSERT INTO announcement_archive (market, code, source, ann_id, published_at, known_at, session_d, timing, type, price_sensitive, title)
              VALUES (?, ?, 'src', ?, ?, ?, ?, 'intraday', NULL, 0, 'x')`,
        args: [A, code, id, `${days[k]}T01:00:00Z`, `${days[k]}T02:00:00Z`, days[k]!],
      });
    await ann("m1", "P1", 5); // matured, labelled, priced
    await ann("m2", "P1", 5); // label value outside the coding
    await ann("m3", "P1", 40); // not matured on the night
    await ann("m4", "NOBAR", 5); // no bars
    await db.execute({
      sql: "INSERT INTO label_validation (validation_id, market, kind, result_json, created_at) VALUES ('v1', ?, 'golden', '{}', '2045-01-01T00:00:00Z')",
      args: [A],
    });
    const lab = (id: string, value: string, at: string) =>
      db.execute({
        sql: `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value, manifest_id, validation_id)
              VALUES (?, ?, 'tone', 'm', ?, ?, 'mf', 'v1')`,
        args: [A, `src|${id}`, at, value],
      });
    await lab("m1", "negative", "2045-01-03T00:00:00Z"); // older
    await lab("m1", "positive", "2045-01-04T00:00:00Z"); // newest wins: +1
    await lab("m2", "none", "2045-01-04T00:00:00Z");
    await lab("m3", "positive", "2045-01-04T00:00:00Z");
    await lab("m4", "positive", "2045-01-04T00:00:00Z");
    const obs = await dbLabelReader(db, A, "tone", days[30]!);
    // AR = (102/100 - 1) - (1010/1000 - 1) = 0.01; outcome = (110.5/102 - 1) - (1111/1010 - 1) = -0.016667
    expect(obs).toEqual([{ session: days[5], label: 1, outcome: -16667, ar: 10000 }]);
  });
});
