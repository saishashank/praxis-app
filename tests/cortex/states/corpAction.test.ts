// @vitest-environment node
// CTX-015 corporate-action states (M15 C3b): candidate / confirmed / disconfirmed, the two-basis
// stop, the freeze loss limit, the unresolved Owner alert, the re-base before the ratchet (AT-52
// ratchet invariant incl. a confirmed 2-for-1) and the ledger invariant. AT-56 fixtures 3b and 5.
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import {
  candidateGroups,
  CORP_ACTION_NONE,
  corpActionStateAt,
  LedgerInvariantError,
  provenanceOf,
  ratchetStop,
  rebaseStop,
  reconcileExit,
  stepCorpAction,
  twoBasisStop,
  type CorpActionState,
  type CorpActionStep,
} from "@/lib/cortex/states/corpAction";
import type { CandidateSource, CorpActionStatus } from "@/lib/cortex/states/types";
import { makeRational } from "@/lib/money/rational";
import { CENT, noticeAction, path, SESSIONS, statesWorld, type FixtureSpec } from "./zzStates";

const BREAK = 10; // SESSIONS[10] = 2026-02-16
const KNOWN = SESSIONS[9]!; // notice known the session before the break
const EX = SESSIONS[BREAK]!;
const c = (cents: number): bigint => BigInt(Math.round(cents * 100)) * (CENT / 100n);

function walk(spec: FixtureSpec, upTo: number): CorpActionStep[] {
  const view = buildAsOfView(statesWorld([spec]));
  const out: CorpActionStep[] = [];
  let s: CorpActionState | null = null;
  for (let t = 0; t <= upTo; t += 1) {
    const step = stepCorpAction(view, spec.code, t, s);
    out.push(step);
    s = step.next;
  }
  return out;
}

const split21 = (
  code: string,
  sources: readonly CandidateSource[] | null = ["announcement"],
  knownD = KNOWN,
  status: CorpActionStatus = "pending",
) => noticeAction(code, "split", EX, { new: 2, old: 1 }, knownD, sources, status);

describe("fixture 3b: a 2-for-1 candidate whose price does not follow the ratio is disconfirmed", () => {
  // The chapter's literal numbers (-50 % on the break, then -8 %, -8 %) cannot disconfirm under its
  // own rule: -50 % IS the stated ratio and confirms by notice + price on the break (OWNER: flagged
  // for review). Here raw -30 % on the break (observed 1.43 against a stated 2: not confirmed; the
  // break session itself is not a deviation test, D-322), then -8 % on each of the next two
  // sessions: the explained-move test fails on D+1 (28.8 % off) and D+2 (18.5 % off): disconfirmed
  // on D+2, the raw stop runs from the next open.
  const spec: FixtureSpec = {
    code: "ZZD",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.3, -0.08, -0.08]) },
    corpActions: [split21("ZZD")],
  };
  const steps = walk(spec, BREAK + 4);

  it("enters the candidate state when the notice is known, with no entries", () => {
    expect(steps[8]!.next.state).toBe("none");
    expect(steps[8]!.row).toBeNull();
    const s9 = steps[9]!;
    expect(s9.next.state).toBe("candidate");
    expect(s9.label).toBe("a corporate action with a stated ratio is not yet confirmed");
    expect(s9.row).toMatchObject({
      kind: "corp_action",
      code: "ZZD",
      fromD: KNOWN,
      state: "candidate",
    });
    expect(s9.effects.entriesBlocked).toBe(true);
    expect(s9.effects.stopBasis).toBe("raw"); // the ratio is never applied before the break
  });

  it("runs the two-basis freeze from the break and disconfirms on the second failing post-break session", () => {
    const brk = steps[BREAK]!;
    expect(brk.next).toMatchObject({ state: "candidate", deviationRun: 0, priceTested: true });
    expect(brk.effects.stopBasis).toBe("two_basis");
    expect(brk.effects.priceFactor).toEqual(makeRational(2n, 1n));
    expect(brk.reason).toBe("candidate_frozen");
    const d1 = steps[BREAK + 1]!;
    expect(d1.next).toMatchObject({ state: "candidate", deviationRun: 1 });
    expect(d1.effects.stopBasis).toBe("two_basis");
    const d2 = steps[BREAK + 2]!;
    expect(d2.next.state).toBe("disconfirmed");
    expect(d2.label).toBe(
      "the price did not move as the announced ratio said: the action is disconfirmed",
    );
    expect(d2.row).toMatchObject({
      state: "disconfirmed",
      fromD: SESSIONS[BREAK + 2],
      sourceRef: split21("ZZD").id,
      basis: { run: 2 },
    });
    expect(d2.effects.stopBasis).toBe("raw");
    expect(d2.effects.reverseBookings).toBe(true);
    expect(d2.effects.entriesBlocked).toBe(false);
  });

  it("closes the state with a 'none' row the next session (append-only)", () => {
    const d3 = steps[BREAK + 3]!;
    expect(d3.next.state).toBe("none");
    expect(d3.row).toMatchObject({ state: "none", basis: { after: "disconfirmed" } });
    expect(steps[BREAK + 4]!.row).toBeNull();
  });

  it("one deviating session followed by a recovery does not disconfirm (D-322: two consecutive)", () => {
    const bounce: FixtureSpec = {
      ...spec,
      code: "ZZD2",
      bars: { closesCents: path(1000, BREAK, [-0.3, -0.08, -0.22]) },
      corpActions: [split21("ZZD2")],
    };
    const s = walk(bounce, BREAK + 2);
    expect(s[BREAK + 1]!.next).toMatchObject({ state: "candidate", deviationRun: 1 });
    expect(s[BREAK + 2]!.next).toMatchObject({ state: "candidate", deviationRun: 0 });
  });
});

describe("fixture 5: an unconfirmed split on a held code", () => {
  // Raw -47.37 % on the break (observed ratio 1.9 against a stated 2: outside 1 %, inside 10 %),
  // then flat: the candidate stays unresolved and the Owner is alerted on session 5 of the freeze.
  const spec: FixtureSpec = {
    code: "ZZE",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.4737]) },
    corpActions: [split21("ZZE")],
  };
  const steps = walk(spec, BREAK + 6);
  const stop = c(900); // pre-break stop

  it("reads the stop on both bases: raw breaches, adjusted does not, so no exit", () => {
    const brk = steps[BREAK]!;
    expect(brk.next.state).toBe("candidate");
    expect(brk.effects.stopBasis).toBe("two_basis");
    const raw = c(526.3); // 1000 x (1 - 0.4737)
    const r = twoBasisStop({
      rawCloseMicro: raw,
      stopMicro: stop,
      priceFactor: brk.effects.priceFactor,
    });
    expect(r).toEqual({ rawBreach: true, adjBreach: false, exit: false });
    expect(brk.effects.freezeExit).toBe(false);
    expect(brk.effects.entriesBlocked).toBe(true);
  });

  it("a real crash breaches both bases and exits", () => {
    const r = twoBasisStop({
      rawCloseMicro: c(400),
      stopMicro: stop,
      priceFactor: makeRational(2n),
    });
    expect(r).toEqual({ rawBreach: true, adjBreach: true, exit: true });
    // before the break the factor is null: raw only
    expect(twoBasisStop({ rawCloseMicro: c(850), stopMicro: stop, priceFactor: null }).exit).toBe(
      true,
    );
  });

  it("raises the Owner alert on session 5 of the freeze with its own row and label", () => {
    for (let t = BREAK + 1; t <= BREAK + 3; t += 1) {
      expect(steps[t]!.next.state).toBe("candidate");
      expect(steps[t]!.effects.ownerAlert).toBe(false);
      expect(steps[t]!.row).toBeNull();
    }
    const s5 = steps[BREAK + 4]!; // freeze session 5 (break = 1)
    expect(s5.next).toMatchObject({ state: "candidate", freezeSessions: 5, ownerAlert: true });
    expect(s5.effects.ownerAlert).toBe(true);
    expect(s5.reason).toBe("owner_alert");
    expect(s5.label).toBe(
      "Owner alert: a corporate action is unresolved and the prices do not agree with the notice",
    );
    expect(s5.row).toMatchObject({ state: "candidate_owner_alert", fromD: SESSIONS[BREAK + 4] });
    // the alert is raised once; the freeze goes on
    const s6 = steps[BREAK + 5]!;
    expect(s6.effects.ownerAlert).toBe(false);
    expect(s6.row).toBeNull();
    expect(s6.next.state).toBe("candidate");
    expect(s6.effects.entriesBlocked).toBe(true);
  });

  it("the freeze loss limit (25 % on adjusted prices from the last clean close) exits regardless", () => {
    // -47.37 % on the break then -30 %: adjusted 2 x 368.4 = 736.8 < 750 (a 26.3 % loss)
    const fall: FixtureSpec = {
      ...spec,
      code: "ZZF",
      bars: { closesCents: path(1000, BREAK, [-0.4737, -0.3]) },
      corpActions: [split21("ZZF")],
    };
    const s = walk(fall, BREAK + 1);
    const d1 = s[BREAK + 1]!;
    expect(d1.next.state).toBe("candidate"); // one deviating session only: not disconfirmed
    expect(d1.effects.freezeExit).toBe(true);
    expect(d1.reason).toBe("freeze_loss_exit");
    expect(d1.label).toBe(
      "the loss during the unconfirmed corporate action passed the freeze limit",
    );
    expect(d1.effects.stopBasis).toBe("two_basis"); // the exit is booked on the adjusted basis
    expect(
      reconcileExit({ heldQty: 100n, qtyRatio: d1.effects.qtyRatio, rawCloseMicro: c(368.4) }),
    ).toEqual({
      shares: 200n,
      priceMicro: c(368.4),
      proceedsMicro: 200n * c(368.4),
    });
  });

  it("a confirmed 2-for-1 (break price agrees) re-bases the stop before the ratchet and does not exit", () => {
    const ok: FixtureSpec = {
      ...spec,
      code: "ZZG",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [split21("ZZG")],
    };
    const s = walk(ok, BREAK + 2);
    const brk = s[BREAK]!;
    expect(brk.next).toMatchObject({ state: "confirmed", by: "notice_price", rebased: true });
    expect(brk.label).toBe("a confirmed corporate action re-based the stop today");
    expect(brk.row).toMatchObject({
      state: "confirmed",
      fromD: EX,
      basis: { by: "notice_price", priceFactor: "2/1" },
    });
    expect(brk.effects.rebase).toEqual({
      priceFactor: makeRational(2n),
      qtyRatio: makeRational(2n),
    });
    expect(brk.effects.entriesBlocked).toBe(false);
    const rebased = ratchetStop(stop, c(430), brk.effects.rebase!.priceFactor);
    expect(rebased).toBe(c(450)); // 900 / 2, and the lower proposal does not win
    expect(
      twoBasisStop({ rawCloseMicro: c(500), stopMicro: rebased, priceFactor: null }).exit,
    ).toBe(false);
    expect(s[BREAK + 1]!.next.state).toBe("none");
    expect(s[BREAK + 1]!.row).toMatchObject({ state: "none", basis: { after: "confirmed" } });
  });
});

describe("other confirmation paths and non-candidates", () => {
  it("notice + vendor agreeing before the break confirms early; the re-base waits for the break", () => {
    const spec: FixtureSpec = {
      code: "ZZH",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [
        split21("ZZH", ["announcement"], SESSIONS[8]!),
        split21("ZZH", ["vendor"], KNOWN),
      ],
    };
    const s = walk(spec, BREAK + 1);
    expect(s[8]!.next.state).toBe("candidate");
    expect(s[9]!.next).toMatchObject({ state: "confirmed", by: "notice_vendor", rebased: false });
    expect(s[9]!.label).toBe("a confirmed corporate action takes effect at its break session");
    expect(s[9]!.effects.rebase).toBeNull();
    expect(s[9]!.effects.entriesBlocked).toBe(false);
    expect(s[BREAK]!.effects.rebase?.priceFactor).toEqual(makeRational(2n));
    expect(s[BREAK]!.row).toBeNull();
    expect(s[BREAK + 1]!.next.state).toBe("none");
  });

  it("a vendor-only ratio is never a candidate", () => {
    const spec: FixtureSpec = {
      code: "ZZI",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [split21("ZZI", ["vendor"])],
    };
    const view = buildAsOfView(statesWorld([spec]));
    expect(candidateGroups(view, "ZZI", BREAK)).toEqual([]);
    const s = walk(spec, BREAK);
    expect(s[9]!.next.state).toBe("none");
    // -50 % with no candidate is a jump: entries blocked two sessions, stop runs raw on day 1
    expect(s[BREAK]!.next).toMatchObject({ state: "jump_block", sessionsLeft: 2 });
    expect(s[BREAK]!.effects).toMatchObject({
      entriesBlocked: true,
      stopBasis: "raw",
      volumeTestNeeded: true,
    });
  });

  it("D-321: a notice-sourced row the data layer confirmed enters as confirmed and re-bases at the break", () => {
    const spec: FixtureSpec = {
      code: "ZZJ",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [split21("ZZJ", ["announcement", "vendor"], KNOWN, "confirmed")],
    };
    const s = walk(spec, BREAK + 1);
    expect(s[9]!.next).toMatchObject({ state: "confirmed", by: "notice_data_layer" });
    expect(s[9]!.row).toMatchObject({ state: "confirmed", basis: { by: "notice_data_layer" } });
    expect(s[BREAK]!.effects.rebase?.qtyRatio).toEqual(makeRational(2n));
    expect(s[BREAK + 1]!.row).toMatchObject({ state: "none" });
  });

  it("D-321: a vendor-only row the data layer auto-confirmed never re-bases a Cortex stop", () => {
    const spec: FixtureSpec = {
      code: "ZZJ2",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [split21("ZZJ2", ["vendor", "price"], KNOWN, "confirmed")],
    };
    const view = buildAsOfView(statesWorld([spec]));
    expect(candidateGroups(view, "ZZJ2", BREAK)).toEqual([]);
    const s = walk(spec, BREAK + 1);
    expect(s[9]!.next.state).toBe("none");
    expect(s[9]!.row).toBeNull();
    // the -50 % break is an unexplained jump for the Cortex: block, raw stop, no re-base
    expect(s[BREAK]!.next.state).toBe("jump_block");
    expect(s[BREAK]!.effects.rebase).toBeNull();
    expect(s[BREAK]!.effects.stopBasis).toBe("raw");
    const stop = c(900);
    expect(ratchetStop(stop, c(430), s[BREAK]!.effects.rebase?.priceFactor ?? null)).toBe(stop);
  });

  it("D-321: a row with no provenance fails closed: one unknown_provenance row, Owner alert, no re-base", () => {
    const spec: FixtureSpec = {
      code: "ZZJ3",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, []) },
      corpActions: [split21("ZZJ3", null, KNOWN)],
    };
    const s = walk(spec, BREAK + 2);
    const k = s[9]!;
    expect(k.next).toEqual({ state: "none", seen: [`${EX}|quantity`] });
    expect(k.reason).toBe("unknown_provenance");
    expect(k.label).toBe(
      "Owner alert: a corporate action has no recorded source; entries are blocked today",
    );
    expect(k.row).toMatchObject({
      state: "unknown_provenance",
      fromD: KNOWN,
      basis: { exD: EX, actionIds: [split21("ZZJ3", null).id], types: ["split"] },
      sourceRef: split21("ZZJ3", null).id,
    });
    expect(k.effects).toMatchObject({ entriesBlocked: true, ownerAlert: true, rebase: null });
    for (let t = BREAK; t <= BREAK + 2; t += 1) {
      expect(s[t]!.next.state).toBe("none");
      expect(s[t]!.row).toBeNull();
      expect(s[t]!.effects.rebase).toBeNull();
    }
  });

  it("D-321: provenance may come as a map by action id instead of on the record", () => {
    const rec = split21("ZZJ4", null, KNOWN);
    const spec: FixtureSpec = {
      code: "ZZJ4",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5]) },
      corpActions: [rec],
    };
    const view = buildAsOfView(statesWorld([spec]));
    const prov = new Map([
      [rec.id, { sources: ["announcement" as const], status: "pending" as const }],
    ]);
    expect(stepCorpAction(view, "ZZJ4", 9, null, undefined, prov).next.state).toBe("candidate");
    expect(corpActionStateAt(view, "ZZJ4", BREAK, undefined, prov).next).toMatchObject({
      state: "confirmed",
      by: "notice_price",
    });
    expect(provenanceOf(rec)).toBeNull();
    expect(provenanceOf(rec, prov)).toEqual({ sources: ["announcement"], status: "pending" });
  });

  it("SF-3: a TERP offer the data layer confirmed waits as a candidate and confirms at the break", () => {
    // cum close 1000c, TERP 800c -> factor 5/4; the offer does not change the share count
    const rights = noticeAction(
      "ZZT",
      "rights_renounceable",
      EX,
      { rights: { new: 1, old: 4 }, terp_micro: c(800).toString() },
      KNOWN,
      ["announcement"],
      "confirmed",
    );
    const spec: FixtureSpec = {
      code: "ZZT",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.2]) },
      corpActions: [rights],
    };
    const s = walk(spec, BREAK + 1);
    expect(s[9]!.next).toMatchObject({ state: "candidate", terpMicro: c(800), noticeFactor: null });
    expect(s[9]!.reason).toBe("candidate_terp_pending");
    expect(s[9]!.row).toMatchObject({
      state: "candidate",
      basis: { terpMicro: c(800).toString() },
    });
    const brk = s[BREAK]!;
    expect(brk.next).toMatchObject({
      state: "confirmed",
      by: "notice_data_layer",
      priceFactor: makeRational(5n, 4n),
      qtyRatio: makeRational(1n),
      rebased: true,
    });
    expect(brk.effects.rebase).toEqual({
      priceFactor: makeRational(5n, 4n),
      qtyRatio: makeRational(1n),
    });
    expect(rebaseStop(c(900), brk.effects.rebase!.priceFactor)).toBe(c(720));
    expect(s[BREAK + 1]!.row).toMatchObject({ state: "none", basis: { after: "confirmed" } });
  });

  it("SF-5: a notice first known after the break is tested against the break-day close", () => {
    const late = split21("ZZL2", ["announcement"], SESSIONS[BREAK + 2]!);
    const agree: FixtureSpec = {
      code: "ZZL2",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.5, 0.03, 0.03]) },
      corpActions: [late],
    };
    const s = walk(agree, BREAK + 3);
    expect(s[BREAK]!.next.state).toBe("jump_block"); // nothing known yet: the -50 % is a jump
    const k = s[BREAK + 2]!;
    expect(k.next).toMatchObject({ state: "confirmed", by: "notice_price", rebased: true });
    expect(k.effects.rebase?.priceFactor).toEqual(makeRational(2n));
    expect(k.row).toMatchObject({ state: "confirmed", fromD: SESSIONS[BREAK + 2] });
    // the same late notice against a break that did not follow the ratio: a candidate whose freeze
    // count already runs from the break (break = 1, so session 3 on arrival), today's close tested
    const off: FixtureSpec = {
      ...agree,
      code: "ZZL3",
      bars: { closesCents: path(1000, BREAK, [-0.4737, 0, 0]) },
      corpActions: [split21("ZZL3", ["announcement"], SESSIONS[BREAK + 2]!)],
    };
    const o = walk(off, BREAK + 4);
    expect(o[BREAK + 2]!.next).toMatchObject({
      state: "candidate",
      freezeSessions: 3,
      priceTested: true,
      deviationRun: 0,
    });
    expect(o[BREAK + 2]!.effects.stopBasis).toBe("two_basis");
    expect(o[BREAK + 4]!.next).toMatchObject({
      state: "candidate",
      freezeSessions: 5,
      ownerAlert: true,
    });
  });

  it("a 15 % jump with no candidate blocks entries for two sessions and then ends with a 'none' row", () => {
    const spec: FixtureSpec = {
      code: "ZZK",
      tier: "U1",
      bars: { closesCents: path(1000, 5, [0.2]) },
    };
    const s = walk(spec, 8);
    expect(s[4]!.next.state).toBe("none");
    expect(s[5]!.next).toMatchObject({ state: "jump_block", sessionsLeft: 2, fromD: SESSIONS[5] });
    expect(s[5]!.label).toBe("a large unexplained price jump blocks entries for now");
    expect(s[5]!.row).toMatchObject({ state: "jump_block", basis: { move: "1/5", sessions: 2 } });
    expect(s[6]!.next).toMatchObject({ state: "jump_block", sessionsLeft: 1 });
    expect(s[6]!.effects.entriesBlocked).toBe(true);
    expect(s[7]!.next.state).toBe("none");
    expect(s[7]!.row).toMatchObject({ state: "none", basis: { after: "jump_block" } });
    expect(s[7]!.effects.entriesBlocked).toBe(false);
    expect(s[8]!.row).toBeNull();
  });

  it("a dividend is never a candidate", () => {
    const div = noticeAction(
      "ZZL",
      "cash_dividend",
      EX,
      { dps: "0.10", pay_date: "2026-03-20" },
      KNOWN,
    );
    const spec: FixtureSpec = {
      code: "ZZL",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, []) },
      corpActions: [div],
    };
    const s = walk(spec, BREAK + 1);
    expect(s.every((x) => x.next.state === "none" && x.row === null)).toBe(true);
  });

  it("corpActionStateAt folds from the first session and equals the walk", () => {
    const spec: FixtureSpec = {
      code: "ZZE",
      tier: "U1",
      bars: { closesCents: path(1000, BREAK, [-0.4737]) },
      corpActions: [split21("ZZE")],
    };
    const view = buildAsOfView(statesWorld([spec]));
    const folded = corpActionStateAt(view, "ZZE", BREAK + 4);
    expect(folded.next).toEqual(walk(spec, BREAK + 4)[BREAK + 4]!.next);
    expect(stepCorpAction(view, "ZZE", 0, null).next).toEqual(CORP_ACTION_NONE);
  });
});

describe("AT-52 ratchet invariant: no stop lowered except a confirmed re-base", () => {
  it("ratchetStop keeps the higher stop", () => {
    expect(ratchetStop(c(900), c(850))).toBe(c(900));
    expect(ratchetStop(c(900), c(950))).toBe(c(950));
    expect(ratchetStop(c(900), c(900))).toBe(c(900));
  });

  it("rebaseStop halves for a 2-for-1 and multiplies by 10 for a 1-for-10 consolidation", () => {
    expect(rebaseStop(c(900), makeRational(2n))).toBe(c(450));
    expect(rebaseStop(c(90), makeRational(1n, 10n))).toBe(c(900));
    expect(rebaseStop(1n, makeRational(2n))).toBe(1n); // half away from zero, once
    expect(() => rebaseStop(c(900), makeRational(0n))).toThrow(RangeError);
  });

  it("a confirmed 2-for-1 re-base is the only way down, and the ratchet then runs on the new basis", () => {
    const after = ratchetStop(c(900), c(440), makeRational(2n));
    expect(after).toBe(c(450));
    expect(ratchetStop(c(900), c(470), makeRational(2n))).toBe(c(470));
  });

  it("the ledger invariant refuses an exit the ratio cannot reconcile to whole shares", () => {
    expect(() =>
      reconcileExit({ heldQty: 5n, qtyRatio: makeRational(1n, 10n), rawCloseMicro: c(100) }),
    ).toThrow(LedgerInvariantError);
    expect(
      reconcileExit({ heldQty: 100n, qtyRatio: makeRational(1n, 10n), rawCloseMicro: c(1000) }),
    ).toEqual({
      shares: 10n,
      priceMicro: c(1000),
      proceedsMicro: 10n * c(1000),
    });
    expect(reconcileExit({ heldQty: 7n, qtyRatio: null, rawCloseMicro: c(10) }).shares).toBe(7n);
    expect(() => reconcileExit({ heldQty: 0n, qtyRatio: null, rawCloseMicro: c(10) })).toThrow(
      LedgerInvariantError,
    );
  });
});
