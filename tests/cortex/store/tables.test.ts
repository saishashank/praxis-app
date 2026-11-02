// @vitest-environment node
// Cortex store (M15 P1): typed writers and readers over the 0019 tables. Append-only writes,
// insert-or-ignore where the design says, the once-only results, "latest wins" readers. Synthetic ZZ
// data only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import {
  abstainNightsOfBook,
  abstainsForNight,
  angleIdsWithStatus,
  cellsOfKind,
  countFeatureRows,
  currentMap,
  decisionsForNight,
  familyStatusHistory,
  familyStatusMap,
  featureRowsForCode,
  featureRowsForNight,
  getCell,
  getManifest,
  getNight,
  getStatement,
  getValidation,
  insertAbstain,
  insertDecision,
  insertFamilyStatus,
  insertFeatureRows,
  insertLabelWithValidation,
  insertManifest,
  insertMap,
  insertNight,
  insertOpinion,
  insertOutcome,
  insertPassport,
  insertState,
  insertStatement,
  labelsForAnnouncement,
  latestMaps,
  latestPassports,
  latestStatement,
  logCell,
  manifestIdOf,
  missingPassports,
  openCells,
  outcomesForFamily,
  passportHistory,
  recentNights,
  setCellResult,
  settleOpinion,
  stateHistory,
  statesInForce,
  unscoredDecisions,
  unsettledOpinions,
  type DecisionRow,
  type OutcomeRow,
  type PassportRow,
} from "@/lib/cortex/store";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const M = "AU";
const D1 = "2030-03-05";
const D2 = "2030-03-06";
const D3 = "2030-03-07";

const passport = (over: Partial<PassportRow> = {}): PassportRow => ({
  market: M,
  angleId: "A-D1-01",
  version: 1,
  domain: 1,
  cluster: "momentum",
  orientation: 1,
  kind: "score",
  inputs: ["bar_au"],
  historyFields: { years: 20 },
  status: "candidate",
  horizonSessions: 20,
  evidence: { note: "synthetic" },
  measured: null,
  frozenAt: "2030-01-01T00:00:00Z",
  ...over,
});

describe("passports", () => {
  it("a status change is a new version; readers return the newest", async () => {
    const db = await freshDb("main");
    await insertPassport(db, passport());
    await insertPassport(db, passport({ version: 2, status: "active", measured: { ic: 0.01 } }));
    await insertPassport(
      db,
      passport({ angleId: "A-D1-02", cluster: "low_volatility", orientation: -1 }),
    );
    await expect(insertPassport(db, passport())).rejects.toThrow(); // the (angle, version) key is the history

    const latest = await latestPassports(db, M);
    expect(latest.map((p) => [p.angleId, p.version, p.status])).toEqual([
      ["A-D1-01", 2, "active"],
      ["A-D1-02", 1, "candidate"],
    ]);
    expect(latest[0]!.measured).toEqual({ ic: 0.01 });
    expect(latest[1]!.orientation).toBe(-1);
    expect((await passportHistory(db, M, "A-D1-01")).map((p) => p.version)).toEqual([1, 2]);
    expect(await angleIdsWithStatus(db, M, "active")).toEqual(["A-D1-01"]);
    expect(await missingPassports(db, M, ["A-D1-01", "A-D1-02", "A-D2-01"])).toEqual(["A-D2-01"]);
  });
});

describe("features", () => {
  it("one row per code per night, insert-or-ignore, readers by night and by code", async () => {
    const db = await freshDb("main");
    const row = (d: string, code: string, v: number | null) => ({
      market: M,
      d,
      code,
      features: { "A-D1-01": v },
      flags: { "A-D1-01": "at_high" },
      activeSetHash: "h1",
      manifestId: "m1",
    });
    expect(
      await insertFeatureRows(db, [row(D1, "ZZB", 0.2), row(D1, "ZZA", null), row(D2, "ZZA", 0.1)]),
    ).toEqual({
      inserted: 3,
    });
    // a re-run of the night keeps the first rows
    expect(await insertFeatureRows(db, [row(D1, "ZZA", 0.9), row(D1, "ZZC", 0.3)])).toEqual({
      inserted: 1,
    });
    expect(await countFeatureRows(db, M, D1)).toBe(3);
    const night = await featureRowsForNight(db, M, D1);
    expect(night.map((r) => r.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(night[0]!.features).toEqual({ "A-D1-01": null }); // the first write won
    expect((await featureRowsForCode(db, M, "ZZA", D1, D3)).map((r) => r.d)).toEqual([D1, D2]);
    expect(await insertFeatureRows(db, [])).toEqual({ inserted: 0 });
  });
});

describe("maps", () => {
  it("the latest fit per (family, rule_version) wins; currentMap is the newest of the family", async () => {
    const db = await freshDb("main");
    const fit = (family: "F1" | "F2", ruleVersion: string, fittedAt: string, a: number) => ({
      market: M,
      family,
      ruleVersion,
      fittedAt,
      params: { a, b: 1, s_mean: 0, s_sd: 1, K: 3, clusters: ["momentum"] },
      activeSetHash: "h",
      nEff: 250.5,
      pool: "all",
      fitSplit: "development",
    });
    expect(await currentMap(db, M, "F1")).toBeNull();
    await insertMap(db, fit("F1", "v1", "2030-01-01T00:00:00Z", 0.1));
    await insertMap(db, fit("F1", "v1", "2030-02-01T00:00:00Z", 0.2));
    await insertMap(db, fit("F1", "v2", "2030-01-15T00:00:00Z", 0.3));
    await insertMap(db, fit("F2", "v1", "2030-01-01T00:00:00Z", 0.4));
    expect((await latestMaps(db, M)).map((m) => [m.family, m.ruleVersion, m.params.a])).toEqual([
      ["F1", "v1", 0.2],
      ["F1", "v2", 0.3],
      ["F2", "v1", 0.4],
    ]);
    expect((await currentMap(db, M, "F1"))!.params.a).toBe(0.2);
    await expect(insertMap(db, fit("F1", "v1", "2030-02-01T00:00:00Z", 0.9))).rejects.toThrow();
  });
});

describe("nights, manifests, abstains", () => {
  it("night rows are insert-or-ignore, recent nights newest first", async () => {
    const db = await freshDb("main");
    const night = (d: string, status: "ran" | "abstain_all", reason: "late_bar" | null) => ({
      market: M,
      d,
      status,
      reason,
      manifestId: "m1",
      universeN: 10,
      barsN: 9,
      featureRows: 9,
      runtimeMs: 1200,
      activeSetHash: "h",
      mapFittedAt: null,
    });
    expect((await insertNight(db, night(D1, "ran", null))).inserted).toBe(true);
    expect((await insertNight(db, night(D1, "abstain_all", "late_bar"))).inserted).toBe(false);
    await insertNight(db, night(D2, "abstain_all", "late_bar"));
    expect((await getNight(db, M, D1))!.status).toBe("ran");
    expect((await getNight(db, M, D2))!.reason).toBe("late_bar");
    expect(await getNight(db, M, D3)).toBeNull();
    expect((await recentNights(db, M, D3, 5)).map((n) => n.d)).toEqual([D2, D1]);
  });

  it("a manifest id is the hash of its content and the same inputs are written once", async () => {
    const db = await freshDb("main");
    const body = {
      market: M,
      d: D1,
      sources: [{ kind: "bar_au", rows: 9 }],
      schemaSha: "s",
      rowCounts: { bar: 9 },
    };
    const a = await insertManifest(db, body, "2030-03-05T08:00:00Z");
    const b = await insertManifest(db, body, "2030-03-05T09:00:00Z");
    expect(a.manifestId).toBe(b.manifestId);
    expect([a.inserted, b.inserted]).toEqual([true, false]);
    expect(a.manifestId).toBe(manifestIdOf(body));
    expect(manifestIdOf({ ...body, schemaSha: "t" })).not.toBe(a.manifestId);
    expect(manifestIdOf({ ...body, rowCounts: { bar: 9 } })).toBe(a.manifestId); // key order is canonical
    const got = await getManifest(db, a.manifestId);
    expect(got).toMatchObject({ d: D1, schemaSha: "s", createdAt: "2030-03-05T08:00:00Z" });
    expect(await getManifest(db, "nope")).toBeNull();
  });

  it("one abstain per book per night; the streak reader is newest first", async () => {
    const db = await freshDb("main");
    const ab = (d: string, bookId: string, label = "not yet allowed") => ({
      market: M,
      d,
      bookId,
      gateId: "G03_family_status",
      label,
      detail: { n: 1 },
    });
    expect((await insertAbstain(db, ab(D1, "E01"))).inserted).toBe(true);
    expect((await insertAbstain(db, ab(D1, "E01", "other"))).inserted).toBe(false);
    await insertAbstain(db, ab(D1, "E02"));
    await insertAbstain(db, ab(D2, "E01"));
    expect((await abstainsForNight(db, M, D1)).map((a) => [a.bookId, a.label])).toEqual([
      ["E01", "not yet allowed"],
      ["E02", "not yet allowed"],
    ]);
    expect(await abstainNightsOfBook(db, M, "E01", D3, 10)).toEqual([D2, D1]);
    expect(await abstainNightsOfBook(db, M, "E01", D3, 1)).toEqual([D2]);
  });
});

describe("decisions and outcomes", () => {
  const dec = (over: Partial<DecisionRow> = {}): DecisionRow => ({
    market: M,
    d: D1,
    bookId: "E01",
    code: "ZZA",
    arm: "live",
    family: "F1",
    s: 0.42,
    p: 0.55,
    expectedNetMicro: 1_200_000,
    rankKey: "3/50",
    limitMicro: 5_000_000,
    stopMicro: 4_500_000,
    qty: 120,
    gateTrace: [{ gateId: "G01_l0_veto", pass: true }],
    firstFailGate: null,
    signalId: "sig1",
    orderId: "ord1",
    cardId: "card1",
    sectorTilt: null,
    manifestId: "m1",
    ...over,
  });
  const out = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
    market: M,
    d: D1,
    bookId: "E01",
    code: "ZZA",
    arm: "live",
    fillStatus: "filled",
    fillMicro: 5_000_000,
    fillD: D2,
    exitD: D3,
    exitRule: "stop",
    grossMicro: -300_000,
    netMicro: -340_000,
    outcomeClass: "loss",
    scoredAt: "2030-03-08T00:00:00Z",
    ...over,
  });

  it("round-trips a decision, idempotent per key, filtered readers", async () => {
    const db = await freshDb("main");
    expect((await insertDecision(db, dec())).inserted).toBe(true);
    expect((await insertDecision(db, dec({ s: 9 }))).inserted).toBe(false);
    await insertDecision(
      db,
      dec({
        arm: "shadow",
        family: "F7",
        limitMicro: null,
        stopMicro: null,
        qty: null,
        signalId: null,
        orderId: null,
        cardId: null,
        sectorTilt: { sector: "ZZ", tiltPp: 2 },
      }),
    );
    await insertDecision(
      db,
      dec({ code: "ZZB", family: "F2", firstFailGate: "G04_economic", p: null, s: null }),
    );
    const all = await decisionsForNight(db, M, D1);
    expect(all).toHaveLength(3);
    expect(all[0]).toEqual(dec());
    expect(all.find((x) => x.family === "F7")!.sectorTilt).toEqual({ sector: "ZZ", tiltPp: 2 });
    expect(await decisionsForNight(db, M, D1, { arm: "shadow" })).toHaveLength(1);
    expect(await decisionsForNight(db, M, D1, { family: "F2" })).toHaveLength(1);
    expect(await decisionsForNight(db, M, D2)).toEqual([]);
  });

  it("scores each decision once; unscored ones are listed until their outcome exists", async () => {
    const db = await freshDb("main");
    await insertDecision(db, dec());
    await insertDecision(db, dec({ code: "ZZB", family: "F2", arm: "shadow" }));
    expect((await unscoredDecisions(db, M, D2, 10)).map((x) => x.code)).toEqual(["ZZA", "ZZB"]);
    expect((await insertOutcome(db, out())).inserted).toBe(true);
    expect((await insertOutcome(db, out({ netMicro: 1 }))).inserted).toBe(false); // insert-or-ignore
    expect((await unscoredDecisions(db, M, D2, 10)).map((x) => x.code)).toEqual(["ZZB"]);
    expect((await unscoredDecisions(db, M, D2, 10)).length).toBe(1);
    await insertOutcome(
      db,
      out({
        code: "ZZB",
        arm: "shadow",
        fillStatus: "unfilled",
        fillMicro: null,
        fillD: null,
        exitD: null,
        exitRule: null,
        grossMicro: null,
        netMicro: null,
        outcomeClass: null,
      }),
    );
    expect(await unscoredDecisions(db, M, D2, 10)).toEqual([]);

    const f1 = await outcomesForFamily(db, M, "F1", D1, D3);
    expect(f1).toEqual([out()]);
    expect((await outcomesForFamily(db, M, "F2", D1, D3))[0]!.fillStatus).toBe("unfilled");
    expect(await outcomesForFamily(db, M, "F1", D2, D3)).toEqual([]);
  });
});

describe("family status and statements", () => {
  it("a family with no row is shadow; the latest since_d at or before the date wins", async () => {
    const db = await freshDb("main");
    expect(await familyStatusMap(db, M, D1)).toEqual({
      F1: "shadow",
      F2: "shadow",
      F3: "shadow",
      F4: "shadow",
      F5: "shadow",
      F6: "shadow",
      F7: "shadow",
    });
    const row = (
      family: "F1" | "F2" | "F7",
      sinceD: string,
      status: "shadow" | "allowed" | "suspended",
      setBy: "import" | "evaluator" | "owner_kill",
    ) => ({
      market: M,
      family,
      sinceD,
      status,
      evidence: { n_eff: 210 },
      statementId: null,
      setBy,
    });
    await insertFamilyStatus(db, row("F1", D1, "allowed", "import"));
    await insertFamilyStatus(db, row("F1", D3, "suspended", "owner_kill"));
    await insertFamilyStatus(db, row("F7", D1, "shadow", "import"));
    expect((await familyStatusMap(db, M, D1)).F1).toBe("allowed");
    expect((await familyStatusMap(db, M, D2)).F1).toBe("allowed");
    expect((await familyStatusMap(db, M, D3)).F1).toBe("suspended");
    expect((await familyStatusMap(db, M, "2030-02-01")).F1).toBe("shadow"); // before the first row
    expect((await familyStatusMap(db, M, D3)).F2).toBe("shadow");
    expect(
      (await familyStatusHistory(db, M, "F1")).map((s) => [s.sinceD, s.status, s.setBy]),
    ).toEqual([
      [D1, "allowed", "import"],
      [D3, "suspended", "owner_kill"],
    ]);
    await expect(insertFamilyStatus(db, row("F2", D1, "allowed", "owner_kill"))).rejects.toThrow(); // no leaving shadow by hand
    await expect(insertFamilyStatus(db, row("F7", D2, "allowed", "evaluator"))).rejects.toThrow(); // F7 never allowed
  });

  it("statements round-trip and the newest of a family is found", async () => {
    const db = await freshDb("main");
    const st = (
      id: string,
      createdAt: string,
      kind: "allowed_weak" | "live_tested",
      n: number | null,
    ) => ({
      statementId: id,
      market: M,
      family: "F1" as const,
      kind,
      text: `text ${id}`,
      numbers: { x: 1 },
      nEffLive: n,
      createdAt,
    });
    expect(await latestStatement(db, M, "F1")).toBeNull();
    await insertStatement(db, st("s1", "2030-03-01T00:00:00Z", "allowed_weak", null));
    await insertStatement(db, st("s2", "2030-03-02T00:00:00Z", "live_tested", 12.5));
    expect(await getStatement(db, "s1")).toEqual(
      st("s1", "2030-03-01T00:00:00Z", "allowed_weak", null),
    );
    expect((await latestStatement(db, M, "F1"))!.statementId).toBe("s2");
    expect(await getStatement(db, "nope")).toBeNull();
  });
});

describe("states", () => {
  it("a state ends with a 'none' row; statesInForce is the newest non-none row per (code, kind)", async () => {
    const db = await freshDb("main");
    const st = (
      code: string,
      kind: "corp_action" | "halt" | "promotion",
      fromD: string,
      state: string,
    ) => ({
      market: M,
      code,
      kind,
      fromD,
      state,
      basis: { why: "synthetic" },
      sourceRef: null,
    });
    await insertState(db, st("ZZA", "halt", D1, "halt"));
    await insertState(db, st("ZZA", "halt", D3, "none"));
    await insertState(db, st("ZZA", "corp_action", D2, "candidate"));
    await insertState(db, st("ZZB", "promotion", D1, "flagged"));
    expect((await statesInForce(db, M, D1)).map((s) => [s.code, s.kind, s.state])).toEqual([
      ["ZZA", "halt", "halt"],
      ["ZZB", "promotion", "flagged"],
    ]);
    expect((await statesInForce(db, M, D2)).map((s) => [s.code, s.kind])).toEqual([
      ["ZZA", "corp_action"],
      ["ZZA", "halt"],
      ["ZZB", "promotion"],
    ]);
    expect((await statesInForce(db, M, D3)).map((s) => [s.code, s.kind])).toEqual([
      ["ZZA", "corp_action"],
      ["ZZB", "promotion"],
    ]); // the halt closed
    expect((await stateHistory(db, M, "ZZA", "halt")).map((s) => s.state)).toEqual([
      "halt",
      "none",
    ]);
    await expect(insertState(db, st("ZZA", "halt", D1, "halt"))).rejects.toThrow(); // one change per session date
  });
});

describe("labels and opinions", () => {
  const validation = (id: string) => ({
    validationId: id,
    market: M,
    kind: "paraphrase" as const,
    result: { agree: true },
    createdAt: "2030-03-05T00:00:00Z",
  });
  const label = (over: Partial<{ validationId: string; producedAt: string }> = {}) => ({
    market: M,
    announcementId: "a1",
    labelKind: "tone" as const,
    modelId: "mdl",
    producedAt: "2030-03-05T00:00:00Z",
    value: "positive",
    citedSpan: "we raise guidance",
    manifestId: "m1",
    validationId: "v1",
    ...over,
  });

  it("a label and its validation row are written together; a mismatch or a repeat writes nothing", async () => {
    const db = await freshDb("main");
    await expect(
      insertLabelWithValidation(db, label({ validationId: "other" }), validation("v1")),
    ).rejects.toThrow(/does not match/);
    await insertLabelWithValidation(db, label(), validation("v1"));
    expect(await labelsForAnnouncement(db, M, "a1")).toEqual([label()]);
    expect((await getValidation(db, "v1"))!.result).toEqual({ agree: true });
    // a failing second write rolls the whole batch back (the validation id repeats)
    await expect(
      insertLabelWithValidation(
        db,
        label({ producedAt: "2030-03-06T00:00:00Z" }),
        validation("v1"),
      ),
    ).rejects.toThrow();
    expect(await labelsForAnnouncement(db, M, "a1")).toHaveLength(1);
    expect(await getValidation(db, "none")).toBeNull();
  });

  it("an opinion settles once; later settles change nothing", async () => {
    const db = await freshDb("main");
    const op = {
      market: M,
      opinionId: "o1",
      kind: "committee" as const,
      code: "ZZA",
      d: D1,
      value: { vote: 1 },
    };
    expect((await insertOpinion(db, op)).inserted).toBe(true);
    expect((await insertOpinion(db, { ...op, value: { vote: 0 } })).inserted).toBe(false);
    await insertOpinion(db, { ...op, opinionId: "o2", kind: "steelman" });
    expect((await unsettledOpinions(db, M, D3)).map((o) => o.opinionId)).toEqual(["o1", "o2"]);
    expect(await settleOpinion(db, M, "o1", D2, { hit: true })).toBe(true);
    expect(await settleOpinion(db, M, "o1", D3, { hit: false })).toBe(false);
    expect(await settleOpinion(db, M, "missing", D3, {})).toBe(false);
    expect((await unsettledOpinions(db, M, D3)).map((o) => o.opinionId)).toEqual(["o2"]);
  });
});

describe("ledger cells", () => {
  const cell = (id: string, loggedAt = "2030-03-05T00:00:00Z") => ({
    cellId: id,
    market: M,
    family: "F1" as const,
    angleId: "A-D1-01",
    kind: "grid",
    spec: { window: 20 },
    loggedAt,
    split: "development" as const,
    lineageId: "AU:F1",
  });

  it("logs before the result and takes the result once", async () => {
    const db = await freshDb("main");
    await logCell(db, cell("c1"));
    await logCell(db, cell("c2", "2030-03-05T01:00:00Z"));
    await expect(logCell(db, cell("c1"))).rejects.toThrow();
    expect((await openCells(db, M)).map((c) => c.cellId)).toEqual(["c1", "c2"]);

    expect(await setCellResult(db, "c1", "2030-03-06T00:00:00Z", { ic: 0.02 })).toBe(true);
    expect(await setCellResult(db, "c1", "2030-03-07T00:00:00Z", { ic: 0.5 })).toBe(false);
    await expect(setCellResult(db, "c2", "2030-03-05T00:30:00Z", {})).rejects.toThrow(/CHECK/); // before its log
    expect(await setCellResult(db, "missing", "2030-03-06T00:00:00Z", {})).toBe(false);

    const c1 = (await getCell(db, "c1"))!;
    expect(c1.result).toEqual({ ic: 0.02 });
    expect(c1.resultAt).toBe("2030-03-06T00:00:00Z");
    expect((await getCell(db, "c2"))!.result).toBeNull();
    expect((await openCells(db, M)).map((c) => c.cellId)).toEqual(["c2"]);
    expect((await cellsOfKind(db, M, "F1", "grid")).map((c) => c.cellId)).toEqual(["c1", "c2"]);
    expect(await cellsOfKind(db, M, "F2", "grid")).toEqual([]);
    expect(await getCell(db, "nope")).toBeNull();
  });
});
