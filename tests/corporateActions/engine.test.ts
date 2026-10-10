// @vitest-environment node
// Corporate action engine against a real local libSQL file (M2 T8): capture, auto-confirm, the
// Owner queue, the 5-session rule, factors, reversal, append-only, quality re-evaluation.
// DAT-220..223, DAT-126, DAT-003, AT-08. Synthetic ZZ* codes only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { adjustedBars } from "@/lib/data/adjusted";
import {
  BEST_EVIDENCE_CHECK,
  BLOCK_CHECK,
  corporateActionsHook,
  loadActions,
  readCaConfig,
  resolveAction,
  runCorporateActions,
  settle,
} from "@/lib/data/corporateActions/engine.mjs";
import { runQuality } from "@/lib/data/quality/engine.mjs";
import { entriesAllowed } from "@/lib/data/quality/gate";
import { RULES } from "@/lib/data/quality/rules.mjs";
import { cleanupTempDbs } from "../db/helpers";
import {
  announced,
  caDb,
  CODES20,
  count,
  D0,
  D1,
  D2,
  D3,
  D4,
  D5,
  D6,
  factors,
  io,
  nowOf,
  openFlags,
  putBar,
  rows,
  statuses,
  vendor,
} from "./helpers";

afterEach(cleanupTempDbs);

const split21 = { new: 2, old: 1 };
const run = (db: Awaited<ReturnType<typeof caDb>>, d: string, o: Record<string, unknown> = {}) =>
  runCorporateActions({ db, market: "AU", d, io: io(), now: nowOf(d), ...o });
const owner = (
  db: Awaited<ReturnType<typeof caDb>>,
  id: number,
  decision: "confirm" | "reject" | "reverse",
  d = D1,
) =>
  resolveAction(db, {
    market: "AU",
    actionId: id,
    decision,
    by: "owner:1",
    now: nowOf(d),
    d,
    io: io(),
  });

/** ZZA closes 10.00 then 5.10 (ex-date D1); ZZB flat. */
async function splitDb() {
  const db = await caDb();
  await putBar(db, "ZZA", D0, 10);
  await putBar(db, "ZZA", D1, 5.1);
  return db;
}

describe("capture and auto-confirm (DAT-221)", () => {
  it("a structured announcement that the price agrees with is auto-confirmed, with a factor", async () => {
    const db = await splitDb();
    const r = await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(r).toMatchObject({
      captured: 1,
      auto_confirmed: 1,
      queued_owner: 0,
      factors_written: 1,
    });
    expect(await statuses(db, 1)).toEqual(["queued", "auto_confirmed"]);
    expect(await factors(db)).toEqual([[1, 0.5]]);
    expect(await count(db, "data_quality_flag")).toBe(0); // nothing blocks
    const [a] = await loadActions(db, io(), "AU");
    expect(a).toMatchObject({
      code: "ZZA",
      type: "split",
      state: "confirmed",
      sources: ["announcement"],
    });
  });

  it("is idempotent: the same input again adds no rows (DAT-003)", async () => {
    const db = await splitDb();
    const c = { candidates: [announced("ZZA", "split", D1, split21)] };
    await run(db, D1, c);
    const before = [
      await count(db, "corporate_action"),
      await count(db, "corporate_action_event"),
      await count(db, "adjustment_factor"),
    ];
    const again = await run(db, D1, { ...c, now: "2026-10-13T09:00:00.000Z" });
    expect(again).toMatchObject({ captured: 0, auto_confirmed: 0, factors_written: 0 });
    expect([
      await count(db, "corporate_action"),
      await count(db, "corporate_action_event"),
      await count(db, "adjustment_factor"),
    ]).toEqual(before);
  });

  it("a payload with the same terms in another key order is the same action", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { new: 2, old: 1 })] });
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { old: 1, new: 2 })] });
    expect(await count(db, "corporate_action")).toBe(1);
  });

  it("an announcement before the ex-date waits (pending, not blocking) and is confirmed on the ex-date", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    const early = await run(db, D0, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(early).toMatchObject({ captured: 1, auto_confirmed: 0, pending: 1 });
    expect(await openFlags(db)).toEqual([]);
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("pending");
    await putBar(db, "ZZA", D1, 5.2);
    const exDay = await run(db, D1);
    expect(exDay).toMatchObject({ auto_confirmed: 1, factors_written: 1, pending: 0 });
    expect(await factors(db)).toEqual([[1, 0.5]]);
  });

  it("a vendor field for a known pending action adds its source instead of a second action", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await run(db, D0, { candidates: [announced("ZZA", "split", D1, split21)] });
    const r = await run(db, D0, { candidates: [vendor("ZZA", "split", D1, split21)] });
    expect(r).toMatchObject({ captured: 0, source_added: 1 });
    expect(await count(db, "corporate_action")).toBe(1);
    const [a] = await loadActions(db, io(), "AU");
    expect(a.sources.sort()).toEqual(["announcement", "vendor"]);
    await run(db, D0, { candidates: [vendor("ZZA", "split", D1, split21)] });
    expect(await count(db, "corporate_action_event")).toBe(2); // not repeated
  });

  it("cash dividends need no price check: confirmed at once, factor 1", async () => {
    const db = await caDb();
    const r = await run(db, D0, {
      candidates: [announced("ZZA", "cash_dividend", D2, { amount: "0.25", franking_pct: 100 })],
    });
    expect(r).toMatchObject({ captured: 1, auto_confirmed: 1, factors_written: 1 });
    expect(await factors(db)).toEqual([[1, 1]]);
  });

  it("counts invalid candidates and writes nothing for them", async () => {
    const db = await caDb();
    const r = await run(db, D0, {
      candidates: [
        { code: "bad", type: "split", ex_date: D1, payload: split21, source: "vendor" },
        { code: "ZZA", type: "split", ex_date: D1, payload: { new: 1, old: 2 }, source: "vendor" },
      ],
    });
    expect(r.invalid).toBe(2);
    expect(await count(db, "corporate_action")).toBe(0);
  });

  it("the Batch 1 hook is the same engine", async () => {
    const db = await splitDb();
    const r = await corporateActionsHook({
      db,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D1),
      candidates: [announced("ZZA", "split", D1, split21)],
    });
    expect(r.auto_confirmed).toBe(1);
  });
});

describe("conflicts go to the Owner queue and block entries (DAT-221, DAT-222)", () => {
  it("announcement and vendor disagree: both queued, entries blocked, 5 sessions apply the best", async () => {
    const db = await caDb(CODES20, [D0, D1]);
    for (const [i, code] of CODES20.entries()) {
      await putBar(db, code, D0, 10 + i / 100);
      await putBar(db, code, D1, code === "ZZA" ? 5 : 10 + i / 100);
    }
    const cands = [
      announced("ZZA", "split", D1, split21),
      vendor("ZZA", "split", D1, { new: 3, old: 1 }),
    ];
    const r = await run(db, D1, { candidates: cands });
    expect(r).toMatchObject({ captured: 2, queued_owner: 2, auto_confirmed: 0, flags_raised: 2 });
    expect(await openFlags(db, BLOCK_CHECK)).toHaveLength(2);
    expect(await factors(db)).toEqual([]); // nothing applies while unresolved

    await runQuality({ db, market: "AU", d: D1, io: io(), now: nowOf(D1) });
    expect(await entriesAllowed(db, "ZZA", D1)).toEqual({ allowed: false, reason: "code_blocked" });
    expect((await entriesAllowed(db, "ZZB", D1)).allowed).toBe(true);

    // sessions after D1: D2, D3, D4, D5 = 4 -> not due; D6 = 5 -> due
    await run(db, D2);
    await run(db, D5);
    expect((await loadActions(db, io(), "AU")).map((a) => a.state)).toEqual(["owner", "owner"]);
    const due = await run(db, D6);
    expect(due).toMatchObject({ applied_best_evidence: 1, superseded: 1 });
    const acts = await loadActions(db, io(), "AU");
    expect(acts.map((a) => a.state)).toEqual(["confirmed", "rejected"]); // 2:1 matches the price
    expect(acts[0].events.map((e) => e.status)).toEqual([
      "queued",
      "queued",
      "applied_best_evidence",
    ]);
    expect(await factors(db)).toEqual([[1, 0.5]]);
    expect(await openFlags(db, BLOCK_CHECK)).toEqual([]);
    expect(await openFlags(db, BEST_EVIDENCE_CHECK)).toMatchObject([
      { code: "ZZA", blocks_entries: 0 },
    ]);
  });

  it("the boundary: 4 sessions leave the item queued; the 5th applies it", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { new: 4, old: 1 })] }); // price says 2:1
    expect((await loadActions(db, io(), "AU"))[0].note.reasons).toEqual(["price_mismatch"]);
    for (const d of [D2, D3, D4, D5]) {
      expect((await run(db, d)).applied_best_evidence).toBe(0);
    }
    expect((await run(db, D6)).applied_best_evidence).toBe(1);
    expect(await factors(db)).toEqual([[1, 0.25]]); // the announcement's reading, flagged
  });

  it("the number of sessions is a setting (corporate_action_auto_apply_sessions)", async () => {
    const db = await splitDb();
    await setConfig(db, {
      key: "corporate_action_auto_apply_sessions",
      value: 2,
      userId: null,
      now: nowOf(D1),
    });
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { new: 4, old: 1 })] });
    expect((await run(db, D2)).applied_best_evidence).toBe(0);
    expect((await run(db, D3)).applied_best_evidence).toBe(1);
  });

  it("a holiday is not a session (calendar rows are read)", async () => {
    const db = await caDb();
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('AU', '2028-03-08', 'holiday', NULL, 1, 't')",
    );
    await putBar(db, "ZZA", "2028-03-03", 10);
    await putBar(db, "ZZA", "2028-03-06", 10);
    await run(db, "2028-03-06", { candidates: [announced("ZZA", "split", "2028-03-06", split21)] });
    // sessions after Mon 6th: Tue 7, (Wed 8 holiday), Thu 9, Fri 10, Mon 13 = 4; Tue 14 = 5
    expect((await run(db, "2028-03-13")).applied_best_evidence).toBe(0);
    expect((await run(db, "2028-03-14")).applied_best_evidence).toBe(1);
  });

  it("a single source whose price does not match is queued with the reason", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 10.1);
    const r = await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(r.queued_owner).toBe(1);
    const [a] = await loadActions(db, io(), "AU");
    expect(a.note).toMatchObject({ queue: "owner", reasons: ["price_mismatch"], d: D1 });
  });

  it("conflicts on codes that are neither held nor candidates are blocked only (no Owner card)", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 10);
    const r = await run(db, D1, {
      candidates: [announced("ZZA", "split", D1, split21)],
      relevant: () => false,
    });
    expect(r).toMatchObject({ queued_blocked: 1, queued_owner: 0, flags_raised: 1 });
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("blocked");
    // no auto-apply for a blocked-only item, however long it waits
    await run(db, D6, { relevant: () => false });
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("blocked");
    expect(await factors(db)).toEqual([]);
  });

  it("(s13) a blocked item moves to the Owner queue when the code becomes relevant; the timer restarts", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 10);
    await run(db, D1, {
      candidates: [announced("ZZA", "split", D1, split21)],
      relevant: () => false,
    });
    const p = await run(db, D4, { relevant: (c: string) => c === "ZZA" });
    expect(p.promoted).toBe(1);
    const [a] = await loadActions(db, io(), "AU");
    expect(a).toMatchObject({ state: "owner", stateSince: D4 });
    // the original queue date (D1) would be due on D6; the restarted timer is not
    expect((await run(db, D6, { relevant: () => true })).applied_best_evidence).toBe(0);
    // D4 + 5 sessions: D5, D6, 10-21, 10-22, 10-23
    expect((await run(db, "2026-10-23")).applied_best_evidence).toBe(1);
  });

  it("a re-detected, already rejected or applied action is never re-opened", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { new: 4, old: 1 })] });
    expect((await owner(db, 1, "reject")).ok).toBe(true);
    await settle(db, {
      market: "AU",
      now: nowOf(D1),
      io: io(),
      today: D1,
      changed: [{ ex_date: D1 }],
    });
    const again = await run(db, D2, {
      candidates: [announced("ZZA", "split", D1, { new: 4, old: 1 })],
    });
    expect(again).toMatchObject({ captured: 0, queued_owner: 0 });
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("rejected");
  });
});

describe("the unexplained-jump check (DAT-221)", () => {
  it("a 50% drop with no announcement becomes a price-only candidate for the Owner", async () => {
    const db = await splitDb();
    const r = await run(db, D1);
    expect(r).toMatchObject({ captured: 1, queued_owner: 1, auto_confirmed: 0 });
    const [a] = await loadActions(db, io(), "AU");
    expect(a).toMatchObject({ type: "split", payload: { new: 2, old: 1 }, sources: ["price"] });
    expect(a.note.reasons).toEqual(["unexplained_jump"]);
    expect(a.note.observed).toBeCloseTo(0.51, 10);
    expect(await run(db, D1)).toMatchObject({ captured: 0 }); // nightly re-run: no duplicate
    expect(await count(db, "corporate_action")).toBe(1);
  });

  it("counts a jump that matches no clean ratio but creates nothing (the quality flag remains)", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 4); // 0.4 is not a clean 1/n
    const r = await run(db, D1);
    expect(r).toMatchObject({ captured: 0, jumps_without_ratio: 1 });
    expect(await count(db, "corporate_action")).toBe(0);
  });

  it("a move below the suspect-move threshold is not looked at", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 7);
    expect(await run(db, D1)).toMatchObject({ captured: 0, jumps_without_ratio: 0 });
  });

  it("no previous bar means nothing to compare", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D1, 5);
    expect((await run(db, D1)).captured).toBe(0);
  });

  it("an announced action for the date suppresses the price-only duplicate", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(await count(db, "corporate_action")).toBe(1);
  });

  it("the Owner confirming it clears the suspect-move flag and the block; entries reopen", async () => {
    const db = await caDb(CODES20, [D0, D1]);
    for (const [i, code] of CODES20.entries()) {
      await putBar(db, code, D0, 10 + i / 100);
      await putBar(db, code, D1, code === "ZZA" ? 5 : 10 + i / 100);
    }
    await runQuality({ db, market: "AU", d: D1, io: io(), now: nowOf(D1) });
    expect(await openFlags(db, RULES.suspect_move.id)).toHaveLength(1);

    await run(db, D1); // captured, queued: it does NOT explain the move yet
    expect(await openFlags(db, RULES.suspect_move.id)).toHaveLength(1);
    expect(await openFlags(db, BLOCK_CHECK)).toHaveLength(1);

    const res = await owner(db, 1, "confirm");
    expect(res).toMatchObject({ ok: true, code: "ZZA", ex_date: D1 });
    const s = await settle(db, {
      market: "AU",
      now: "2026-10-13T09:00:00.000Z",
      io: io(),
      today: D1,
      changed: [{ ex_date: D1 }],
    });
    expect(s).toMatchObject({ factors: 1, flags_cleared: 1, reevaluated: [D1] });
    expect(await openFlags(db)).toEqual([]);
    expect(await factors(db)).toEqual([[1, 0.5]]);
    expect(await statuses(db, 1)).toEqual(["queued", "queued", "resolved"]);
    const g = await entriesAllowed(db, "ZZA", D1);
    expect(g).toEqual({ allowed: true, reason: "ok" });
  });

  it("the Owner rejecting it keeps the suspect-move flag, adds no factor, and the item stays closed", async () => {
    const db = await caDb(CODES20, [D0, D1]);
    for (const [i, code] of CODES20.entries()) {
      await putBar(db, code, D0, 10 + i / 100);
      await putBar(db, code, D1, code === "ZZA" ? 5 : 10 + i / 100);
    }
    await runQuality({ db, market: "AU", d: D1, io: io(), now: nowOf(D1) });
    await run(db, D1);
    expect((await owner(db, 1, "reject")).ok).toBe(true);
    await settle(db, {
      market: "AU",
      now: nowOf(D2),
      io: io(),
      today: D2,
      changed: [{ ex_date: D1 }],
    });
    expect(await factors(db)).toEqual([]);
    expect(await openFlags(db, BLOCK_CHECK)).toEqual([]);
    expect(await openFlags(db, RULES.suspect_move.id)).toHaveLength(1); // still suspect
    expect(await run(db, D2)).toMatchObject({ captured: 0 }); // a re-run does not re-queue it
  });
});

describe("Owner decisions and reversal (DAT-126 reading: new rows, never edits)", () => {
  it("only an open item can be decided, once; unknown ids are not found", async () => {
    const db = await splitDb();
    await run(db, D1);
    expect(await owner(db, 99, "confirm")).toEqual({ ok: false, error: "not_found" });
    expect((await owner(db, 1, "confirm")).ok).toBe(true);
    expect(await owner(db, 1, "confirm")).toEqual({ ok: false, error: "not_open" });
    expect(await owner(db, 1, "reject")).toEqual({ ok: false, error: "not_open" });
    expect(await statuses(db, 1)).toEqual(["queued", "queued", "resolved"]);
  });

  it("confirming one reading supersedes the other open reading of the same event", async () => {
    const db = await splitDb();
    await run(db, D1, {
      candidates: [
        announced("ZZA", "split", D1, split21),
        vendor("ZZA", "split", D1, { new: 3, old: 1 }),
      ],
    });
    expect((await owner(db, 1, "confirm")).ok).toBe(true);
    expect((await loadActions(db, io(), "AU")).map((a) => a.state)).toEqual([
      "confirmed",
      "rejected",
    ]);
    expect(await statuses(db, 2)).toEqual(["queued", "queued", "resolved"]);
  });

  it("a reading cannot be confirmed while another reading of the event is already confirmed", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] }); // auto-confirmed
    await run(db, D1, { candidates: [vendor("ZZA", "split", D1, { new: 3, old: 1 })] });
    const [a, b] = await loadActions(db, io(), "AU");
    expect([a.state, b.state]).toEqual(["confirmed", "owner"]);
    expect(b.note.reasons).toEqual(["conflicts_with_confirmed", "price_mismatch"]);
    expect(await owner(db, b.id, "confirm")).toEqual({
      ok: false,
      error: "conflicts_with_confirmed",
    });
    expect((await owner(db, b.id, "reject")).ok).toBe(true);
  });

  it("a reversal is a new event and a neutral factor row; nothing is edited", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(await owner(db, 1, "reverse")).toMatchObject({ ok: true, code: "ZZA" });
    const eventsBefore = await rows(db, "SELECT * FROM corporate_action_event ORDER BY id");
    const s = await settle(db, {
      market: "AU",
      now: nowOf(D1),
      io: io(),
      today: D1,
      changed: [{ ex_date: D1 }],
    });
    expect(s.factors).toBe(1);
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("reversed");
    expect(await statuses(db, 1)).toEqual(["queued", "auto_confirmed", "resolved"]);
    // the old factor row is still there; a newer neutral row supersedes it
    expect(await factors(db)).toEqual([
      [1, 0.5],
      [1, 1],
    ]);
    expect(await rows(db, "SELECT * FROM corporate_action_event ORDER BY id")).toEqual(
      eventsBefore,
    );
    // the same computed_at never collides: even a same-instant recompute gets a later key
    const t = await rows(db, "SELECT computed_at FROM adjustment_factor ORDER BY computed_at");
    expect(String(t[1].computed_at) > String(t[0].computed_at)).toBe(true);
    // the reader no longer adjusts
    const bars = await adjustedBars(db, "ZZA", D0, D1);
    expect(bars.map((b) => b.c)).toEqual([10, 5.1]);
  });

  it("reversing an item that is not confirmed is refused", async () => {
    const db = await splitDb();
    await run(db, D1);
    expect(await owner(db, 1, "reverse")).toEqual({ ok: false, error: "not_confirmed" });
  });

  it("a reversed action no longer explains a move, so the suspect flag returns on re-evaluation", async () => {
    const db = await caDb(CODES20, [D0, D1]);
    for (const [i, code] of CODES20.entries()) {
      await putBar(db, code, D0, 10 + i / 100);
      await putBar(db, code, D1, code === "ZZA" ? 5 : 10 + i / 100);
    }
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    await runQuality({ db, market: "AU", d: D1, io: io(), now: nowOf(D1) });
    expect(await openFlags(db, RULES.suspect_move.id)).toEqual([]); // explained by the action
    await owner(db, 1, "reverse");
    await settle(db, {
      market: "AU",
      now: nowOf(D2),
      io: io(),
      today: D2,
      changed: [{ ex_date: D1 }],
    });
    expect(await openFlags(db, RULES.suspect_move.id)).toHaveLength(1);
  });
});

describe("factors: recompute adds rows, never updates (DAT-222)", () => {
  it("syncing again with nothing changed writes nothing", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    const s = await settle(db, { market: "AU", now: nowOf(D2), io: io(), today: D2 });
    expect(s).toMatchObject({ factors: 0, flags_raised: 0, flags_cleared: 0 });
  });

  it("an applied action whose factor is unknown (spin-off without terms) gets factor 1", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await run(db, D0, { candidates: [announced("ZZA", "spin_off", D0, {})] });
    for (const d of [D1, D2, D3, D4, D5]) await run(db, d);
    expect((await loadActions(db, io(), "AU"))[0].state).toBe("confirmed");
    expect(await factors(db)).toEqual([[1, 1]]);
  });

  it("append-only triggers refuse any UPDATE or DELETE on the three tables", async () => {
    const db = await splitDb();
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    for (const [t, col] of [
      ["corporate_action", "code"],
      ["corporate_action_event", "status"],
      ["adjustment_factor", "factor"],
    ]) {
      await expect(db.execute(`UPDATE ${t} SET ${col} = ${col}`)).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`)).rejects.toThrow(/append-only/);
    }
  });
});

describe("quality re-evaluation is narrow", () => {
  it("only suspect-move flags can be cleared: a reject-derived flag on an older date survives", async () => {
    const db = await caDb(CODES20, [D0, D1]);
    for (const [i, code] of CODES20.entries()) {
      await putBar(db, code, D0, 10 + i / 100);
      await putBar(db, code, D1, code === "ZZA" ? 5 : 10 + i / 100);
    }
    await runQuality({ db, market: "AU", d: D1, io: io(), now: nowOf(D1) });
    // a flag the re-run could not re-derive (it needs the pipeline's reject list)
    await db.execute({
      sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, detail_json, raised_at, blocks_entries)
            VALUES ('AU', 'ZZC', ?, ?, 'error', '{}', ?, 1)`,
      args: [D1, RULES.ohlc_inconsistent.id, nowOf(D1)],
    });
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    await runQuality({
      db,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D2),
      clearOnly: [RULES.suspect_move.id],
    });
    const open = await openFlags(db);
    expect(open.map((f) => f.check_id)).toEqual([RULES.ohlc_inconsistent.id]);
  });

  it("does not re-run the date being processed (the pipeline's own stage 8 does)", async () => {
    const db = await splitDb();
    const r = await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(r.reevaluated).toEqual([]);
    expect(await count(db, "quality_score")).toBe(0);
  });

  it("an earlier ex-date confirmed tonight is re-evaluated (ex-date and the next stored bar)", async () => {
    const db = await caDb(["ZZA", "ZZB"], [D0, D1, D2]);
    for (const code of ["ZZA", "ZZB"]) {
      await putBar(db, code, D0, 10);
      await putBar(db, code, D1, code === "ZZA" ? 5.1 : 10);
      await putBar(db, code, D2, code === "ZZA" ? 5.2 : 10);
    }
    await run(db, D1, { candidates: [announced("ZZA", "split", D1, { new: 4, old: 1 })] }); // mismatch -> queued
    const r = await run(db, D2, { candidates: [] });
    expect(r.reevaluated).toEqual([]); // still queued
    await owner(db, 1, "confirm", D2);
    const s = await settle(db, {
      market: "AU",
      now: nowOf(D2),
      io: io(),
      today: D2,
      changed: [{ ex_date: D1 }],
    });
    expect(s.reevaluated).toEqual([D1, D2]);
    expect(await count(db, "quality_score", `d = '${D1}'`)).toBe(3);
  });
});

describe("configuration", () => {
  it("defaults, valid stored values and the fall-back for bad ones", async () => {
    const db = await caDb();
    expect(await readCaConfig(db)).toEqual({
      autoApplySessions: 5,
      priceTolerancePct: 10,
      suspectMovePct: 40,
    });
    await setConfig(db, {
      key: "corporate_action_price_tolerance",
      value: 20,
      userId: null,
      now: nowOf(D0),
    });
    await setConfig(db, {
      key: "corporate_action_auto_apply_sessions",
      value: 3,
      userId: null,
      now: nowOf(D0),
    });
    expect(await readCaConfig(db)).toMatchObject({ autoApplySessions: 3, priceTolerancePct: 20 });
    // values written outside setConfig (bad JSON, out of range) fall back to the defaults
    const raw = (key: string, value: string) =>
      db.execute({
        sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?, 'global', ?, ?)",
        args: [key, value, nowOf(D1)],
      });
    await raw("corporate_action_price_tolerance", "not json");
    await raw("corporate_action_auto_apply_sessions", "99");
    expect(await readCaConfig(db)).toMatchObject({ autoApplySessions: 5, priceTolerancePct: 10 });
    await raw("corporate_action_auto_apply_sessions", "2.5");
    await raw("corporate_action_price_tolerance", "0.5");
    expect(await readCaConfig(db)).toMatchObject({ autoApplySessions: 5, priceTolerancePct: 10 });
  });

  it("the price tolerance changes what counts as agreement", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5.8); // 0.58 vs 0.5: 16% off
    await setConfig(db, {
      key: "corporate_action_price_tolerance",
      value: 20,
      userId: null,
      now: nowOf(D1),
    });
    const r = await run(db, D1, { candidates: [announced("ZZA", "split", D1, split21)] });
    expect(r.auto_confirmed).toBe(1);
  });
});
