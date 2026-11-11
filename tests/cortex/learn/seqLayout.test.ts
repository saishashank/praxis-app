// @vitest-environment node
// D-970: the cortex_learn_event seq layout of one night. A Friday can carry every kind at once: the
// scorecard (0), the nightly learner's duel and checkpoint (1..99), the weekly reweight and its placebo
// twin (100, 101), the probe step (200..249) and the base step (250..299). Events are insert-or-ignore
// on (market, d, seq), so a clash would silently drop one: this test writes them all on one Friday on a
// real migrated file and checks that every one is stored. Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_SEQ0,
  PROBE_SEQ0,
  baseWeekly,
  openProbe,
  probeNight,
} from "@/lib/cortex/learn/baseStage";
import { HOOK_SEQ_BASE } from "@/lib/cortex/learn/hooks";
import { LEARNER_SEQ } from "@/lib/cortex/learn/nightLearner";
import { SCORECARD_SEQ } from "@/lib/cortex/learn/stage";
import { eventsSince, logEvent } from "@/lib/cortex/learn/store";
import { PLACEBO_SEQ, WEEKLY_SEQ } from "@/lib/cortex/learn/weekly";
import { insertMap, type MapRow } from "@/lib/cortex/store/maps";
import { insertPassport } from "@/lib/cortex/store/passports";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { weekdays } from "./zzLearn";

afterEach(cleanupTempDbs);

const FRI = "2026-11-13";
const at = (d: string): string => `${d}T20:00:00.000Z`;

const FIXED: MapRow = {
  market: "AU",
  family: "F1",
  ruleVersion: "F1.zz-seq",
  fittedAt: "2025-12-01T00:00:00.000Z",
  params: {
    a: 1,
    b: 0,
    s_mean: 0,
    s_sd: 1,
    K: 1,
    clusters: ["momentum"],
    angles: ["A-D1-11"],
    tiers: ["U1"],
  } as unknown as MapRow["params"],
  activeSetHash: "zzseq",
  nEff: 300,
  pool: "F1",
  fitSplit: "development",
};

async function setup(): Promise<Client> {
  const db = await freshDb("main");
  await insertMap(db, FIXED);
  await insertPassport(db, {
    market: "AU",
    angleId: "A-D1-11",
    version: 1,
    domain: 1,
    cluster: "momentum",
    orientation: 1,
    kind: "score",
    inputs: ["bar_au"],
    historyFields: [],
    status: "active",
    horizonSessions: 120,
    evidence: {},
    measured: null,
    frozenAt: "2025-12-01T00:00:00.000Z",
  });
  return db;
}

describe("D-970 one night's event seqs", () => {
  it("the reserved ranges are disjoint and the hooks start at HOOK_SEQ_BASE", () => {
    expect(SCORECARD_SEQ).toBe(0);
    expect(LEARNER_SEQ).toBe(1);
    expect(WEEKLY_SEQ).toBe(100);
    expect(PLACEBO_SEQ).toBe(101);
    expect(PROBE_SEQ0).toBe(HOOK_SEQ_BASE);
    expect(BASE_SEQ0).toBe(HOOK_SEQ_BASE + 50);
    expect(PLACEBO_SEQ).toBeLessThan(PROBE_SEQ0);
  });

  it("a Friday with scorecard, checkpoint, reweight, placebo, probe and base events stores every one", async () => {
    const db = await setup();
    // base version 1, and a probe of a measure the base already has (the base step will close it)
    await baseWeekly(db, { market: "AU", d: "2026-10-01", calendar: [], now: at("2026-10-01") });
    await openProbe(db, {
      market: "AU",
      family: "F1",
      angleId: "A-D1-11",
      d: "2026-10-02",
      now: at("2026-10-02"),
      seq: PROBE_SEQ0,
      words: "Started trying a candidate measure.",
    });
    // four weeks of daily movers: heavy trading without news and unexplained moves recur
    for (const d of weekdays("2026-10-16", "2026-11-12")) {
      await db.execute({
        sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, ?)",
        args: [
          d,
          JSON.stringify({
            movers: [
              { code: "ZZ001", side: "gainer", cause: "volume_no_news" },
              { code: "ZZ002", side: "gainer", cause: "stock_specific" },
            ],
          }),
          at(d),
        ],
      });
    }
    // the stages' own events of the Friday
    const own = [
      [SCORECARD_SEQ, "scorecard"],
      [LEARNER_SEQ, "checkpoint"],
      [LEARNER_SEQ + 1, "checkpoint"],
      [WEEKLY_SEQ, "reweight"],
      [PLACEBO_SEQ, "placebo"],
    ] as const;
    for (const [seq, kind] of own) {
      const ok = await logEvent(db, {
        market: "AU",
        d: FRI,
        seq,
        kind,
        family: kind === "scorecard" ? null : "F1",
        evidence: {},
        words: "w",
        createdAt: at(FRI),
      });
      expect(ok.inserted).toBe(true);
    }
    // then the hooks of the same Friday
    const p = (await probeNight(db, {
      market: "AU",
      d: FRI,
      calendar: [],
      movers: [{ code: "ZZ001", side: "gainer", cause: "volume_no_news" }],
      now: at(FRI),
    }))!;
    expect(p.opened).toEqual([{ family: "F1", angleId: "A-D2-07" }]);
    expect(p.escalated).toEqual(["stock_specific"]);
    const b = (await baseWeekly(db, { market: "AU", d: FRI, calendar: [], now: at(FRI) }))!;
    expect(b.closed).toContainEqual({ family: "F1", angleId: "A-D1-11", reason: "base_has_it" });

    const ev = await eventsSince(db, "AU", FRI, FRI);
    const seqs = ev.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(ev.filter((e) => e.seq < PROBE_SEQ0).map((e) => [e.seq, e.kind])).toEqual(
      own.map(([s, k]) => [s, k]),
    );
    const probes = ev.filter((e) => e.seq >= PROBE_SEQ0 && e.seq < BASE_SEQ0);
    expect(probes.map((e) => e.kind)).toEqual(["probe_open", "escalate"]);
    const base = ev.filter((e) => e.seq >= BASE_SEQ0);
    expect(base.length).toBe(b.closed.length);
    for (const e of base) expect(e.seq).toBeLessThan(BASE_SEQ0 + 50);
    expect(ev).toHaveLength(own.length + probes.length + base.length);
    db.close();
  });
});
