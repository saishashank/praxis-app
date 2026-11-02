// @vitest-environment node
// Challenger lifecycle (M6 T9; KB-040..043, ARN-005, ARN-065, ARN-085; D-110 #47, D-111): creation,
// limits, the state machine against the real migration 0010 triggers, shakedown, review.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  ChallengerError,
  challengerSlots,
  createChallenger,
  familyFrozen,
  incumbentOf,
  isAllowedEdge,
  isoWeekBounds,
  isStopOrSizingKey,
  changesStopOrSizing,
  quarterBounds,
  VARIANT_QUARTER_CAP,
  loadChallenger,
  promotionCapacity,
  reviewChallenger,
  reviewVerdict,
  shakedownCount,
  shakedownSessionOk,
  syncShakedown,
  transitionChallenger,
  type CriticState,
} from "@/lib/learning/challengerLifecycle";
import { CHALLENGER_EDGES, CHALLENGER_STATES, type ChallengerState } from "@/lib/learning/schema";
import { cleanupTempDbs } from "../db/helpers";
import {
  BASE,
  D0,
  LEARNING,
  MARKET,
  f1With,
  ownerChallenger,
  rows,
  world,
} from "./challengerFixtures";

afterEach(cleanupTempDbs);

const created = async (db: Client, i = 0, d = D0): Promise<string> => {
  const r = await ownerChallenger(db, i, d);
  if (r.status !== "created") throw new Error(`not created: ${JSON.stringify(r)}`);
  return r.id;
};

describe("ISO week (Melbourne dates)", () => {
  it("runs Monday to Sunday", () => {
    expect(isoWeekBounds("2026-10-20")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(isoWeekBounds("2026-10-19")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(isoWeekBounds("2026-10-25")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(isoWeekBounds("2026-10-26").start).toBe("2026-10-26");
    expect(isoWeekBounds("2026-01-01")).toEqual({ start: "2025-12-29", end: "2026-01-04" });
  });
  it("rejects a non-date", () => {
    expect(() => isoWeekBounds("nope")).toThrow(ChallengerError);
  });
});

describe("creation writes the version, the trial row, the challenger and its first event", () => {
  it("one transaction: rule_version (parent = incumbent), registered status, challenger trial, proposed", async () => {
    const { db } = await world();
    const r = await ownerChallenger(db, 0);
    expect(r).toEqual({ status: "created", id: "C-AU-F1-2", ruleVersionId: "F1.v2" });
    const v = (await rows(db, "SELECT * FROM rule_version WHERE id = 'F1.v2'"))[0]!;
    expect(v).toMatchObject({ parent: "F1.v1", origin: "owner", n: 2, registered_d: D0 });
    expect(
      await rows(db, "SELECT status FROM rule_version_status WHERE rule_version_id = 'F1.v2'"),
    ).toEqual([{ status: "registered" }]);
    const t = await rows(db, "SELECT * FROM trial_ledger WHERE kind = 'challenger'");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      lineage_id: "AU:F1",
      rule_version: "F1.v2",
      split_version: 1,
      d: D0,
    });
    const c = (await loadChallenger(db, "C-AU-F1-2"))!;
    expect(c).toMatchObject({
      state: "proposed",
      state_d: D0,
      trial_id: t[0]!.id,
      incumbent_version_id: "F1.v1",
      shakedown_ok_sessions: 0,
      ready: 0,
    });
    expect(await rows(db, "SELECT * FROM challenger_event")).toMatchObject([
      { seq: 1, from_state: null, to_state: "proposed", actor: "u-owner" },
    ]);
  });

  it("is idempotent: the same parameters return the existing challenger and charge nothing", async () => {
    const { db } = await world();
    await created(db, 0);
    const again = await ownerChallenger(db, 0, "2026-10-06");
    expect(again).toEqual({ status: "exists", id: "C-AU-F1-2", ruleVersionId: "F1.v2" });
    expect(await rows(db, "SELECT id FROM rule_version")).toHaveLength(7); // 6 seeds + 1
    expect(await rows(db, "SELECT id FROM trial_ledger")).toHaveLength(1);
    expect(await rows(db, "SELECT seq FROM challenger_event")).toHaveLength(1);
  });

  it("refuses parameters equal to the incumbent's, outside the bounds, or with unknown keys", async () => {
    const { db } = await world();
    const inc = await f1With(db, {});
    const make = (params: Record<string, unknown>) =>
      createChallenger(db, {
        market: MARKET,
        family: "F1",
        origin: "owner",
        params,
        lessonIds: [],
        d: D0,
        actor: "u",
        learning: LEARNING,
        stats: BASE.stats,
      });
    expect(await make(inc)).toMatchObject({ status: "refused", reason: "no_change" });
    expect(await make({ ...inc, f1_trail_atr: 4.5 })).toMatchObject({
      status: "refused",
      reason: "invalid_params",
    });
    expect(await make({ ...inc, f1_nonsense: 1 })).toMatchObject({
      status: "refused",
      reason: "invalid_params",
    });
    expect(await rows(db, "SELECT id FROM trial_ledger")).toHaveLength(0);
  });

  it("refuses a lineage without a split and a family without a live version", async () => {
    const { db } = await world();
    const f2 = await f1With(db, {});
    const rs = await createChallenger(db, {
      market: MARKET,
      family: "F2",
      origin: "owner",
      params: {
        ...(JSON.parse(
          String(
            (await rows(db, "SELECT params_json FROM rule_version WHERE id='F2.v1'"))[0]!
              .params_json,
          ),
        ) as object),
        f2_stop_atr: 2.6,
      },
      lessonIds: [],
      d: D0,
      actor: "u",
      learning: LEARNING,
      stats: BASE.stats,
    });
    expect(rs).toMatchObject({ status: "refused", reason: "no_split" });
    expect(f2).toBeTruthy();
    const none = await createChallenger(db, {
      market: "IN",
      family: "F1",
      origin: "owner",
      params: await f1With(db, { f1_trail_atr: 3.5 }),
      lessonIds: [],
      d: D0,
      actor: "u",
      learning: LEARNING,
      stats: BASE.stats,
    });
    expect(none).toMatchObject({ status: "refused", reason: "no_incumbent" });
  });

  it("stores the lesson ids sorted and de-duplicated", async () => {
    const { db } = await world();
    const r = await ownerChallenger(db, 0, D0, { lessonIds: ["L-9", "L-2", "L-9"] });
    expect(r.status).toBe("created");
    expect((await loadChallenger(db, "C-AU-F1-2"))!.lesson_ids_json).toBe('["L-2","L-9"]');
  });
});

describe("limits (KB-042, ARN-005, ARN-065, ARN-085, KB-043)", () => {
  it("at most max_challengers (8) in proposed..approved; a decided challenger frees its slot", async () => {
    const { db } = await world();
    expect(LEARNING.maxChallengers).toBe(8);
    // volume-ratio variants: the O-46 cap counts stop, trail and sizing variants only
    const vol = async (i: number) =>
      ownerChallenger(db, i, D0, {
        params: await f1With(db, { f1_volume_ratio_min: Number((1.55 + 0.05 * i).toFixed(2)) }),
      });
    const ids: string[] = [];
    for (let i = 0; i < LEARNING.maxChallengers; i += 1) {
      const r = await vol(i);
      if (r.status !== "created") throw new Error(JSON.stringify(r));
      ids.push(r.id);
    }
    expect(await challengerSlots(db, MARKET, LEARNING)).toEqual({ used: 8, max: 8, free: false });
    expect(await vol(8)).toMatchObject({ status: "refused", reason: "max_challengers" });
    await transitionChallenger(
      db,
      { id: ids[0]!, to: "rejected", d: D0, actor: "A6", reason: "x" },
      LEARNING,
    );
    expect((await challengerSlots(db, MARKET, LEARNING)).free).toBe(true);
    expect(await vol(8)).toMatchObject({ status: "created" });
  });

  it("O-46: at most 3 stop, trail or sizing variants per family per calendar quarter (variant_quarter_cap)", async () => {
    const { db } = await world();
    for (let i = 0; i < VARIANT_QUARTER_CAP; i += 1) await created(db, i);
    expect(await ownerChallenger(db, 3)).toMatchObject({
      status: "refused",
      reason: "variant_quarter_cap",
    });
    // a structural or entry change is not counted
    const other = await ownerChallenger(db, 0, D0, {
      params: await f1With(db, { f1_volume_ratio_min: 1.4 }),
    });
    expect(other).toMatchObject({ status: "created" });
    // the next quarter starts a new count
    expect(await ownerChallenger(db, 3, "2027-01-04")).toMatchObject({ status: "created" });
  });

  it("quarter bounds, stop-key test and the diff", () => {
    expect(quarterBounds("2026-10-05")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(quarterBounds("2026-02-28")).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(quarterBounds("2026-06-30")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterBounds("2026-09-01")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(() => quarterBounds("nope")).toThrow(ChallengerError);
    for (const k of [
      "f1_trail_atr",
      "f1_initial_stop_atr",
      "f5_stop_cap_pct",
      "f3_trail_after_pct",
    ])
      expect(isStopOrSizingKey(k)).toBe(true);
    for (const k of ["f1_time_stop", "f3_time_exit", "f1_volume_ratio_min", "f4_rank_variant"])
      expect(isStopOrSizingKey(k)).toBe(false);
    expect(changesStopOrSizing({ f1_trail_atr: 3 }, { f1_trail_atr: 3.5 })).toBe(true);
    expect(changesStopOrSizing({ f1_trail_atr: 3 }, { f1_trail_atr: 3 })).toBe(false);
  });

  it("KB-081 optional structural keys are accepted; a bad value or an unknown key is refused", async () => {
    const { db } = await world();
    const base = await f1With(db, {});
    const ok = await ownerChallenger(db, 0, D0, {
      params: { ...base, f1_rank_variant: "composite3", f1_return_window_sessions: 252 },
    });
    expect(ok).toMatchObject({ status: "created" });
    expect(
      await ownerChallenger(db, 0, D0, { params: { ...base, f1_rank_variant: "nope" } }),
    ).toMatchObject({ status: "refused", reason: "invalid_params" });
    expect(
      await ownerChallenger(db, 0, D0, { params: { ...base, f1_return_window_sessions: 300 } }),
    ).toMatchObject({ status: "refused", reason: "invalid_params" });
    // a key of another family is not an optional key of F1
    expect(
      await ownerChallenger(db, 0, D0, { params: { ...base, f4_rank_variant: "vol_scaled" } }),
    ).toMatchObject({ status: "refused", reason: "invalid_params" });
  });

  it("the cap follows the key, not a constant", async () => {
    const { db } = await world();
    const small = { ...LEARNING, maxChallengers: 2 };
    await ownerChallenger(db, 0, D0, { learning: small });
    await ownerChallenger(db, 1, D0, { learning: small });
    expect(await ownerChallenger(db, 2, D0, { learning: small })).toMatchObject({
      reason: "max_challengers",
    });
  });

  it("a lineage whose trial budget is exhausted gets no new challenger (every trial kind counts)", async () => {
    const { db } = await world();
    const stats = { ...BASE.stats, trialBudgetPerLineage: 3 };
    await ownerChallenger(db, 0, D0, { stats });
    await db.execute(
      `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
       VALUES ('t-pattern', 'AU', 'AU:F1', 1, 'pattern_test', NULL, NULL, 'r', '${D0}'),
              ('t-val', 'AU', 'AU:F1', 1, 'validation_access', 'F1.v1', 'p', 'r', '${D0}')`,
    );
    const r = await ownerChallenger(db, 1, D0, { stats });
    expect(r).toMatchObject({ status: "refused", reason: "budget_exhausted" });
    // a rolled budget (a new total) opens it again
    expect(await ownerChallenger(db, 1, D0, { stats, budgetTotal: 5 })).toMatchObject({
      status: "created",
    });
  });

  it("the generator is capped per lineage and ISO week; the Owner route is not", async () => {
    const { db } = await world();
    const gen = (i: number, d: string) =>
      ownerChallenger(db, i, d, { origin: "generator", actor: "A6" });
    expect(await gen(0, "2026-10-05")).toMatchObject({ status: "created" });
    expect(await gen(1, "2026-10-09")).toMatchObject({ reason: "weekly_generator_cap" });
    expect(await ownerChallenger(db, 2, "2026-10-09")).toMatchObject({ status: "created" });
    expect(await gen(1, "2026-10-12")).toMatchObject({ status: "created" }); // next ISO week
  });

  it("a family with a killed arena_control row is frozen for the generator (not for the Owner)", async () => {
    const { db } = await world();
    const ctl = (scope: string, key: string, state: string) =>
      db.execute({
        sql: "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES (?, ?, ?, '2026-10-05T00:00:00.000Z', 'k')",
        args: [scope, key, state],
      });
    await ctl("family", "F1", "paused");
    expect(await familyFrozen(db, MARKET, "F1")).toBe(false);
    await ctl("family", "F1", "killed");
    expect(await familyFrozen(db, MARKET, "F1")).toBe(true);
    expect(await familyFrozen(db, MARKET, "F2")).toBe(false);
    expect(await ownerChallenger(db, 0, D0, { origin: "generator" })).toMatchObject({
      reason: "family_frozen",
    });
    expect(await ownerChallenger(db, 0)).toMatchObject({ status: "created" });
    await ctl("family", "F1", "paused"); // paused does not lift a kill
    expect(await familyFrozen(db, MARKET, "F1")).toBe(true);
    await ctl("family", "F1", "enabled");
    expect(await familyFrozen(db, MARKET, "F1")).toBe(false);
    await ctl("market", MARKET, "killed");
    expect(await familyFrozen(db, MARKET, "F3")).toBe(true);
  });

  it("promotions: at most max_promotions_per_week (3) APPLIED per market per Melbourne ISO week; force-apply and rollback do not count", async () => {
    const { db } = await world();
    const promo = async (id: string, kind: string, applied: string | null, market = MARKET) => {
      await db.execute({
        sql: `INSERT INTO promotion (id, market, family, kind, from_version, to_version, challenger_id,
                approved_at, approved_by, status, applied_d, group_id)
              VALUES (?, ?, 'F1', ?, 'F1.v1', ?, ?, '2026-10-05T00:00:00.000Z', 'u', 'pending', NULL, 'TW-F1')`,
        args: [id, market, kind, `F1.v-${id}`, kind === "promotion" ? "C-AU-F1-2" : null],
      });
      if (applied !== null) {
        await db.execute({
          sql: "UPDATE promotion SET status = 'applied', applied_d = ? WHERE id = ?",
          args: [applied, id],
        });
      }
    };
    const cap = (d: string) => promotionCapacity(db, MARKET, "F1", d, LEARNING);
    expect(await cap("2026-10-07")).toMatchObject({ allowed: true, applied: 0, max: 3 });
    await promo("p1", "promotion", "2026-10-05");
    await promo("p2", "promotion", "2026-10-09");
    await promo("pf", "force_apply", "2026-10-06");
    await promo("pr", "rollback", "2026-10-06");
    await promo("pp", "promotion", null); // pending does not count
    await promo("px", "promotion", "2026-10-06", "US"); // another market
    expect(await cap("2026-10-11")).toMatchObject({ allowed: true, applied: 2 });
    await promo("p3", "promotion", "2026-10-11"); // Sunday of the same ISO week
    expect(await cap("2026-10-07")).toMatchObject({ allowed: false, reason: "cap", applied: 3 });
    expect(await cap("2026-10-12")).toMatchObject({ allowed: true, applied: 0 }); // next week
    expect(await cap("2026-10-04")).toMatchObject({ allowed: true, applied: 0 }); // the Sunday before
    expect(
      await promotionCapacity(db, MARKET, "F1", "2026-10-12", { maxPromotionsPerWeek: 0 }),
    ).toMatchObject({ allowed: false, reason: "cap" });
  });

  it("a frozen family cannot promote", async () => {
    const { db } = await world();
    await db.execute(
      "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('family','F1','killed','2026-10-05T00:00:00.000Z','k')",
    );
    expect(await promotionCapacity(db, MARKET, "F1", D0, LEARNING)).toMatchObject({
      allowed: false,
      reason: "frozen",
    });
    expect((await promotionCapacity(db, MARKET, "F2", D0, LEARNING)).allowed).toBe(true);
  });

  it("the incumbent is the latest live version, highest n", async () => {
    const { db } = await world();
    expect(await incumbentOf(db, MARKET, "F1")).toBe("F1.v1");
    expect(await incumbentOf(db, MARKET, "F9" as never)).toBeNull();
  });
});

// ---- the state machine against migration 0010 ---------------------------------------------------------------

const PATH: Record<ChallengerState, ChallengerState[]> = {
  proposed: [],
  replay: ["replay"],
  shakedown: ["replay", "shakedown"],
  review: ["replay", "shakedown", "review"],
  approved: ["replay", "shakedown", "review", "approved"],
  promoted: ["replay", "shakedown", "review", "approved", "promoted"],
  rejected: ["rejected"],
  retired: ["retired"],
};

let seq = 0;
/** A challenger row inserted raw and walked to `state` along legal edges (the trigger checks each). */
async function rawAt(db: Client, state: ChallengerState, extra = ""): Promise<string> {
  seq += 1;
  const id = `C-AU-F1-${100 + seq}`;
  await db.execute({
    sql: `INSERT INTO challenger (id, lineage_id, rule_version_id, incumbent_version_id, origin, state_d, trial_id)
          VALUES (?, 'AU:F1', ?, 'F1.v1', 'owner', '2026-10-05', 't')`,
    args: [id, `F1.v${100 + seq}`],
  });
  for (const s of PATH[state]) {
    await db.execute({ sql: "UPDATE challenger SET state = ? WHERE id = ?", args: [s, id] });
  }
  if (extra !== "")
    await db.execute({ sql: `UPDATE challenger SET ${extra} WHERE id = ?`, args: [id] });
  return id;
}

describe("state machine: the edge table equals the trigger and the event CHECK, pair by pair", () => {
  it("the schema edge table is the KB-040 list", () => {
    const edges = CHALLENGER_STATES.flatMap((f) => CHALLENGER_EDGES[f].map((t) => `${f}>${t}`));
    expect(edges.sort()).toEqual(
      [
        "proposed>replay",
        "proposed>rejected",
        "proposed>retired",
        "replay>shakedown",
        "replay>rejected",
        "replay>retired",
        "shakedown>review",
        "shakedown>rejected",
        "shakedown>retired",
        "review>approved",
        "review>rejected",
        "review>retired",
        "approved>promoted",
        "approved>rejected",
        "approved>retired",
      ].sort(),
    );
    for (const t of TERMINAL_STATES) expect(CHALLENGER_EDGES[t]).toEqual([]);
    expect(ACTIVE_STATES).toEqual(["proposed", "replay", "shakedown", "review", "approved"]);
  });

  it("all 64 pairs: trigger and event CHECK accept exactly the allowed edges", async () => {
    const { db } = await world();
    for (const from of CHALLENGER_STATES) {
      for (const to of CHALLENGER_STATES) {
        const id = await rawAt(db, from);
        const attempt = db.execute({
          sql: "UPDATE challenger SET state = ? WHERE id = ?",
          args: [to, id],
        });
        if (from === to || isAllowedEdge(from, to))
          await expect(attempt, `${from}>${to}`).resolves.toBeDefined();
        else await expect(attempt, `${from}>${to}`).rejects.toThrow(/KB-040 edges/);
        const ev = db.execute({
          sql: `INSERT INTO challenger_event (challenger_id, seq, from_state, to_state, d, actor, reason)
                VALUES (?, 1, ?, ?, '2026-10-05', 'A6', 'x')`,
          args: [id, from, to],
        });
        if (isAllowedEdge(from, to)) await expect(ev, `event ${from}>${to}`).resolves.toBeDefined();
        else await expect(ev, `event ${from}>${to}`).rejects.toThrow(/CHECK/);
      }
    }
  });

  it("the writer takes exactly the allowed edges and nothing else (all 64 pairs)", async () => {
    const { db } = await world();
    for (const from of CHALLENGER_STATES) {
      for (const to of CHALLENGER_STATES) {
        // the guards of the rules (counter at review, ready at approval) are met so only the edge decides
        const extra = from === "shakedown" ? "shakedown_ok_sessions = 10" : "";
        const id = await rawAt(db, from, extra);
        if (from === "review" && to === "approved") {
          await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [id] });
        }
        const run = () =>
          transitionChallenger(db, { id, to, d: "2026-10-06", actor: "A6", reason: "t" }, LEARNING);
        if (from === to) {
          expect(await run(), `${from}>${to}`).toMatchObject({ changed: false });
        } else if (isAllowedEdge(from, to)) {
          expect(await run(), `${from}>${to}`).toMatchObject({ changed: true, from, to });
          expect((await loadChallenger(db, id))!.state).toBe(to);
          expect(
            await rows(db, "SELECT to_state FROM challenger_event WHERE challenger_id = ?", [id]),
          ).toEqual([{ to_state: to }]);
        } else {
          await expect(run(), `${from}>${to}`).rejects.toThrow(/not a KB-040 edge/);
          expect((await loadChallenger(db, id))!.state).toBe(from);
        }
      }
    }
  });

  it("ready only holds in review..promoted; it flips only while in review", async () => {
    const { db } = await world();
    const p = await rawAt(db, "proposed");
    await expect(
      db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [p] }),
    ).rejects.toThrow();
    const r = await rawAt(db, "review");
    await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [r] });
    await db.execute({ sql: "UPDATE challenger SET ready = 0 WHERE id = ?", args: [r] });
    await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [r] });
    await db.execute({ sql: "UPDATE challenger SET state = 'approved' WHERE id = ?", args: [r] });
    await expect(
      db.execute({ sql: "UPDATE challenger SET ready = 0 WHERE id = ?", args: [r] }),
    ).rejects.toThrow(/KB-040 edges/);
  });

  it("an approved challenger with ready = 1 can be rejected or retired; ready is cleared (0010 rule)", async () => {
    const { db } = await world();
    for (const to of ["rejected", "retired"] as const) {
      const id = await rawAt(db, "review", "ready = 1");
      await db.execute({
        sql: "UPDATE challenger SET state = 'approved' WHERE id = ?",
        args: [id],
      });
      // keeping ready = 1 on a terminal state is still refused by the CHECK
      await expect(
        db.execute({ sql: `UPDATE challenger SET state = '${to}' WHERE id = ?`, args: [id] }),
      ).rejects.toThrow();
      // the writer moves it and clears ready in the same update
      await transitionChallenger(db, { id, to, d: D0, actor: "A6", reason: "x" }, LEARNING);
      expect(await loadChallenger(db, id)).toMatchObject({ state: to, ready: 0 });
    }
  });
});

describe("transitions: guards, events, idempotence", () => {
  it("walks the whole lifecycle with one event per move, in order", async () => {
    const { db } = await world();
    const id = await created(db);
    const go = (to: ChallengerState, d: string) =>
      transitionChallenger(
        db,
        { id, to, d, actor: "A6", reason: `to ${to}`, ref: { n: 1 } },
        LEARNING,
      );
    await go("replay", "2026-10-10");
    await go("shakedown", "2026-10-17");
    await expect(go("review", "2026-10-31")).rejects.toThrow(/0 of 10 shakedown sessions/);
    await db.execute({
      sql: "UPDATE challenger SET shakedown_ok_sessions = 10 WHERE id = ?",
      args: [id],
    });
    await go("review", "2026-10-31");
    await expect(go("approved", "2026-11-01")).rejects.toThrow(/not ready/);
    await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [id] });
    await go("approved", "2026-11-01");
    await go("promoted", "2026-11-02");
    const ev = await rows(
      db,
      "SELECT seq, from_state, to_state, d FROM challenger_event ORDER BY seq",
    );
    expect(ev.map((e) => `${e.from_state ?? "-"}>${e.to_state}`)).toEqual([
      "->proposed",
      "proposed>replay",
      "replay>shakedown",
      "shakedown>review",
      "review>approved",
      "approved>promoted",
    ]);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await loadChallenger(db, id)).toMatchObject({
      state: "promoted",
      state_d: "2026-11-02",
      ready: 1,
    });
    // terminal: nothing leaves it
    await expect(go("rejected", "2026-11-03")).rejects.toThrow(/not a KB-040 edge/);
  });

  it("the review threshold is the shakedown_sessions key", async () => {
    const { db } = await world();
    const id = await created(db);
    await transitionChallenger(db, { id, to: "replay", d: D0, actor: "A6", reason: "r" }, LEARNING);
    await transitionChallenger(
      db,
      { id, to: "shakedown", d: D0, actor: "A6", reason: "r" },
      LEARNING,
    );
    await db.execute({
      sql: "UPDATE challenger SET shakedown_ok_sessions = 5 WHERE id = ?",
      args: [id],
    });
    const five = { shakedownSessions: 5 };
    expect(
      await transitionChallenger(db, { id, to: "review", d: D0, actor: "A6", reason: "r" }, five),
    ).toMatchObject({ changed: true });
  });

  it("a repeat of the same transition is a no-op: no second event", async () => {
    const { db } = await world();
    const id = await created(db);
    const t = { id, to: "replay" as const, d: D0, actor: "A6", reason: "r" };
    expect(await transitionChallenger(db, t, LEARNING)).toMatchObject({ changed: true });
    expect(await transitionChallenger(db, t, LEARNING)).toMatchObject({ changed: false });
    expect(await rows(db, "SELECT seq FROM challenger_event")).toHaveLength(2);
  });

  it("refuses an earlier date and an unknown challenger", async () => {
    const { db } = await world();
    const id = await created(db, 0, "2026-10-10");
    await expect(
      transitionChallenger(
        db,
        { id, to: "replay", d: "2026-10-09", actor: "A6", reason: "r" },
        LEARNING,
      ),
    ).rejects.toThrow(/before/);
    await expect(
      transitionChallenger(
        db,
        { id: "C-AU-F1-99", to: "replay", d: D0, actor: "A6", reason: "r" },
        LEARNING,
      ),
    ).rejects.toThrow(/unknown challenger/);
  });

  it("rejecting from review clears ready; the trial and the version stay (slot used, not re-tested)", async () => {
    const { db } = await world();
    const id = await rawAt(db, "review", "ready = 1");
    await transitionChallenger(
      db,
      { id, to: "rejected", d: D0, actor: "A6", reason: "x" },
      LEARNING,
    );
    expect(await loadChallenger(db, id)).toMatchObject({ state: "rejected", ready: 0 });
    const fresh = await created(db, 3);
    await transitionChallenger(
      db,
      { id: fresh, to: "rejected", d: D0, actor: "A6", reason: "x" },
      LEARNING,
    );
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind = 'challenger'")).toHaveLength(1);
    expect(await rows(db, "SELECT id FROM rule_version WHERE id = 'F1.v2'")).toHaveLength(1);
  });
});

describe("shakedown counter (sessions, not evidence; D-111)", () => {
  const ok = (d: string) => ({ d, ok: true });
  const bad = (d: string) => ({ d, ok: false });
  const dates = (n: number, from = 6) =>
    Array.from({ length: n }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);

  it("a session is ok only when 2b and 3 succeeded with no rule-load or ledger error", () => {
    const all = { batch2b: true, batch3: true, ruleLoadError: false, ledgerError: false };
    expect(shakedownSessionOk(all)).toBe(true);
    for (const k of Object.keys(all) as (keyof typeof all)[]) {
      expect(shakedownSessionOk({ ...all, [k]: !all[k] })).toBe(false);
    }
  });

  it("counts later sessions only, in date order, one verdict per date, an error resets to zero", () => {
    const d = dates(6);
    expect(shakedownCount("2026-10-05", d.map(ok))).toBe(6);
    expect(shakedownCount("2026-10-08", d.map(ok))).toBe(3); // 06..08 do not count
    expect(shakedownCount("2026-10-05", [ok(d[2]!), ok(d[0]!), bad(d[1]!), ok(d[3]!)])).toBe(2); // 06 ok, 07 bad, 08 ok, 09 ok
    expect(shakedownCount("2026-10-05", [ok(d[0]!), bad(d[0]!), ok(d[1]!)])).toBe(1); // any failed record fails the date
    expect(shakedownCount("2026-10-05", [ok(d[0]!), bad(d[1]!)])).toBe(0);
    expect(shakedownCount("2026-10-05", [])).toBe(0);
  });

  async function inShakedown(db: Client): Promise<string> {
    const id = await created(db);
    await transitionChallenger(
      db,
      { id, to: "replay", d: "2026-10-05", actor: "A6", reason: "r" },
      LEARNING,
    );
    await transitionChallenger(
      db,
      { id, to: "shakedown", d: "2026-10-05", actor: "A6", reason: "r" },
      LEARNING,
    );
    return id;
  }

  it("sync is an absolute set from the history: idempotent, increases, resets 4 -> 0 -> 2", async () => {
    const { db } = await world();
    const id = await inShakedown(db);
    const d = dates(12);
    const sync = (s: { d: string; ok: boolean }[], at = "2026-10-20") =>
      syncShakedown(db, { id, d: at, sessions: s, learning: LEARNING });
    expect(await sync(d.slice(0, 4).map(ok))).toEqual({ count: 4, changed: true, moved: false });
    expect(await sync(d.slice(0, 4).map(ok))).toEqual({ count: 4, changed: false, moved: false });
    expect((await loadChallenger(db, id))!.shakedown_ok_sessions).toBe(4);
    // the fifth session had an operational error, then two ok: the counter went to 0 and counts again
    expect(await sync([...d.slice(0, 4).map(ok), bad(d[4]!), ok(d[5]!), ok(d[6]!)])).toEqual({
      count: 2,
      changed: true,
      moved: false,
    });
    expect((await loadChallenger(db, id))!.shakedown_ok_sessions).toBe(2);
    // an error as the last session leaves 0
    expect((await sync([...d.slice(0, 7).map(ok), bad(d[7]!)])).count).toBe(0);
    expect((await loadChallenger(db, id))!.state).toBe("shakedown");
  });

  it("the tenth ok session moves it to review once, with the count in the event", async () => {
    const { db } = await world();
    const id = await inShakedown(db);
    const d = dates(12);
    const nine = await syncShakedown(db, {
      id,
      d: "2026-10-16",
      sessions: d.slice(0, 9).map(ok),
      learning: LEARNING,
    });
    expect(nine).toMatchObject({ count: 9, moved: false });
    const ten = await syncShakedown(db, {
      id,
      d: "2026-10-17",
      sessions: d.slice(0, 10).map(ok),
      learning: LEARNING,
    });
    expect(ten).toMatchObject({ count: 10, moved: true });
    expect(await loadChallenger(db, id)).toMatchObject({
      state: "review",
      state_d: "2026-10-17",
      ready: 0,
    });
    const ev = await rows(
      db,
      "SELECT reason, ref_json FROM challenger_event WHERE to_state = 'review'",
    );
    expect(ev).toHaveLength(1);
    expect(JSON.parse(String(ev[0]!.ref_json))).toEqual({ shakedown_ok_sessions: 10 });
    // a repeat sync after the move is refused (not in shakedown) rather than counting again
    await expect(
      syncShakedown(db, { id, d: "2026-10-18", sessions: d.map(ok), learning: LEARNING }),
    ).rejects.toThrow(/not shakedown/);
  });

  it("the length follows shakedown_sessions (5..20), and an old counter above it still moves", async () => {
    const { db } = await world();
    const id = await inShakedown(db);
    const d = dates(7);
    const r = await syncShakedown(db, {
      id,
      d: "2026-10-14",
      sessions: d.slice(0, 5).map(ok),
      learning: { shakedownSessions: 5 },
    });
    expect(r).toMatchObject({ count: 5, moved: true });
  });

  it("the trigger lets the counter fall only to 0 and only in shakedown", async () => {
    const { db } = await world();
    const id = await inShakedown(db);
    await db.execute({
      sql: "UPDATE challenger SET shakedown_ok_sessions = 6 WHERE id = ?",
      args: [id],
    });
    await expect(
      db.execute({
        sql: "UPDATE challenger SET shakedown_ok_sessions = 3 WHERE id = ?",
        args: [id],
      }),
    ).rejects.toThrow(/KB-040 edges/);
    await db.execute({
      sql: "UPDATE challenger SET shakedown_ok_sessions = 0 WHERE id = ?",
      args: [id],
    });
    const other = await rawAt(db, "review", "shakedown_ok_sessions = 10");
    await expect(
      db.execute({
        sql: "UPDATE challenger SET shakedown_ok_sessions = 0 WHERE id = ?",
        args: [other],
      }),
    ).rejects.toThrow(/KB-040 edges/);
  });
});

describe("review: the Critic checks 1-6 decide the ready mark (AGT-041/042)", () => {
  const P: CriticState = "pass";
  it("ready only when all six pass; a fail or an open check is not ready", () => {
    expect(reviewVerdict([P, P, P, P, P, P])).toEqual({ ready: true, failed: [], open: [] });
    expect(reviewVerdict([P, "fail", P, "fail", P, P])).toEqual({
      ready: false,
      failed: [2, 4],
      open: [],
    });
    expect(reviewVerdict([P, P, "pending", P, "not_assessable", P])).toEqual({
      ready: false,
      failed: [],
      open: [3, 5],
    });
    expect(() => reviewVerdict([P, P, P])).toThrow(/needs 6 checks/);
  });

  async function inReview(db: Client): Promise<string> {
    return rawAt(db, "review");
  }

  it("sets ready, clears it when a re-check (4 or 6) fails, and is idempotent; the state stays review", async () => {
    const { db } = await world();
    const id = await inReview(db);
    expect(await reviewChallenger(db, id, [P, P, P, P, P, P])).toMatchObject({ changed: true });
    expect(await loadChallenger(db, id)).toMatchObject({ state: "review", ready: 1 });
    expect(await reviewChallenger(db, id, [P, P, P, P, P, P])).toMatchObject({ changed: false });
    const bad = await reviewChallenger(db, id, [P, P, P, "fail", P, P]);
    expect(bad).toMatchObject({ changed: true, verdict: { ready: false, failed: [4] } });
    expect(await loadChallenger(db, id)).toMatchObject({ state: "review", ready: 0 });
    // a failed check blocks the approval edge
    await expect(
      transitionChallenger(db, { id, to: "approved", d: D0, actor: "u", reason: "x" }, LEARNING),
    ).rejects.toThrow(/not ready/);
    // the Owner may still reject it
    await transitionChallenger(
      db,
      { id, to: "rejected", d: D0, actor: "u", reason: "x" },
      LEARNING,
    );
  });

  it("refuses a challenger outside review", async () => {
    const { db } = await world();
    const id = await created(db);
    await expect(reviewChallenger(db, id, [P, P, P, P, P, P])).rejects.toThrow(/not review/);
    await expect(reviewChallenger(db, "C-AU-F1-77", [P, P, P, P, P, P])).rejects.toThrow(/unknown/);
  });

  it("a ready challenger is approved by the writer and stays ready into approved", async () => {
    const { db } = await world();
    const id = await inReview(db);
    await reviewChallenger(db, id, [P, P, P, P, P, P]);
    await transitionChallenger(
      db,
      { id, to: "approved", d: D0, actor: "u-owner", reason: "ROL-102" },
      LEARNING,
    );
    expect(await loadChallenger(db, id)).toMatchObject({ state: "approved", ready: 1 });
  });
});
