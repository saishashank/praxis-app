// @vitest-environment node
// loadPackInput and nightSubjects over a synthetic ZZ night (M11-lite WP3; AGT-131, AGT-133; D-499).
import { afterEach, describe, expect, it } from "vitest";
import { buildPack, loadPackInput } from "@/lib/steelman/pack";
import { nightSubjects } from "@/lib/steelman/subjects";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const D = "2026-03-04";
const CUT = "2026-03-04T07:10:00.000Z"; // 18:10 Melbourne (AEDT)
const P = { maxItems: 25, decisionCutoff: "18:10" };
const SHA = "a".repeat(64);

async function seed() {
  const db = await freshDb("main");
  const card = {
    family: "F3",
    rule_version: "v1",
    thesis: "drift",
    regime: "NEUTRAL",
    rules_fired: [{ rule: "volume_surge", value: "2.4", threshold: "2.0", pass: true }],
    evidence: {
      events: [{ category: "contract_win", polarity: "positive", day0: D }],
      insider_flow: "unknown",
      data_quality_flags: ["thin"],
      other_flags: [],
    },
    scenario: {
      insufficient_history: false,
      n: 37,
      p10_ppm: -3,
      p50_ppm: 5,
      p90_ppm: 9,
      split_version: 2,
    },
    sizing: { accepted: true, half_size: false, reasons: [] },
    cost: { available: true, break_even_ppm: 4200 },
  };
  const sig = (id: string, code: string, score: string) =>
    db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', ?, '[]', '{}', 1, 'a', 'r', ?)`,
      args: [id, D, code, score, CUT],
    });
  await sig("s1", "ZZA", "1.5");
  await sig("s2", "ZZB", "9.5");
  await sig("s3", "ZZC", "5.0");
  const dc = (id: string, sid: string, taken: number) =>
    db.execute({
      sql: `INSERT INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, order_id, card_json, card_sha, schema_version, decided_at)
            VALUES (?, ?, 'x', ?, ?, ?, ?, ?, 1, ?)`,
      args: [
        id,
        sid,
        taken,
        taken ? null : "rank",
        taken ? `o-${id}` : null,
        JSON.stringify(card),
        SHA,
        CUT,
      ],
    });
  await dc("c1", "s1", 1);
  await dc("c2", "s2", 1);
  await dc("c3", "s3", 0);
  await db.execute({
    sql: "INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state) VALUES ('AU', ?, 1, 1, 'RISK-ON', 'RISK-ON')",
    args: [D],
  });
  await db.execute({
    sql: "INSERT INTO insider_flow_score (market, code, d, score_q) VALUES ('AU', 'ZZA', ?, 3)",
    args: [D],
  });
  await db.execute({
    sql: "INSERT INTO factor_bucket_stat (market, family, rule_version, split_version, factor, bucket, edges_json, n, median_net_ppm, family_median_ppm) VALUES ('AU','F3','v1',2,'volume_surge',2,'[1.0,3.0]',55,700,100)",
    args: [],
  });
  const ann = (id: string, at: string, title: string) =>
    db.execute({
      sql: "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, title, source) VALUES ('AU','ZZA',?,?,?,?,'t')",
      args: [id, at, at, title],
    });
  await ann("a1", "2026-03-04T02:00:00.000Z", "ZZA contract notice");
  await ann("a2", "2026-03-04T07:10:00.001Z", "ZZA late notice after cut-off");
  return db;
}

describe("loadPackInput", () => {
  it("reads every stored source into stable ids and excludes a headline after the cut-off", async () => {
    const db = await seed();
    const subj = { kind: "order" as const, id: "c1", code: "ZZA", cardId: "c1", rankScore: 1.5 };
    const pack = buildPack(await loadPackInput(db, subj, "AU", D, P));
    const kinds = pack.items.map((i) => i.kind);
    for (const k of [
      "card",
      "rule",
      "regime",
      "event",
      "insider",
      "factor",
      "scenario",
      "liquidity",
      "cost",
      "flag",
      "headline",
    ])
      expect(kinds, k).toContain(k);
    expect(pack.items.find((i) => i.kind === "regime")!.text).toContain("RISK-ON"); // table wins over card
    expect(pack.items.filter((i) => i.kind === "regime")).toHaveLength(1);
    expect(pack.items.find((i) => i.kind === "insider")!.text).toContain("score 3");
    expect(pack.items.find((i) => i.kind === "factor")!.text).toContain("bucket 2 n 55");
    expect(pack.items.find((i) => i.kind === "event")!.text).toContain("positive");
    expect(pack.items.map((i) => i.id)).toEqual(
      pack.items.map((_, n) => `E${String(n + 1).padStart(2, "0")}`),
    );
    const heads = pack.items.filter((i) => i.kind === "headline");
    expect(heads.map((h) => h.text)).toEqual(["ZZA contract notice"]);
    expect(pack.cutoffAt).toBe(CUT);
    // Rebuilding gives the same hash.
    expect(buildPack(await loadPackInput(db, subj, "AU", D, P)).packId).toBe(pack.packId);
  });

  it("a subject without a card still gets regime, insider and headlines", async () => {
    const db = await seed();
    const subj = { kind: "pick" as const, id: "p", code: "ZZA", cardId: null, rankScore: null };
    const kinds = buildPack(await loadPackInput(db, subj, "AU", D, P)).items.map((i) => i.kind);
    expect(kinds).toEqual(["regime", "insider", "headline"]);
  });
});

describe("nightSubjects", () => {
  it("takes orders by rank score descending, not-taken cards excluded, cut at max", async () => {
    const db = await seed();
    const all = await nightSubjects(db, "AU", D, 8);
    expect(all.map((s) => [s.kind, s.cardId, s.code])).toEqual([
      ["order", "c2", "ZZB"],
      ["order", "c1", "ZZA"],
    ]);
    expect((await nightSubjects(db, "AU", D, 1)).map((s) => s.cardId)).toEqual(["c2"]);
    expect(await nightSubjects(db, "AU", D, 0)).toEqual([]);
    expect(await nightSubjects(db, "AU", "2026-03-05", 8)).toEqual([]);
  });
});
