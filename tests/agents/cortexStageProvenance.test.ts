// @vitest-environment node
// The D-321 provenance producer and the pure stage builders (M15 P2). A vendor-only confirmed row
// reaches the Cortex state machine as sources ["vendor"] and never re-bases or becomes a candidate;
// a pending announcement is a candidate; the known time is the first event for a pending row and
// `known_at` for a confirmed one.
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { candidateGroups, stepCorpAction } from "@/lib/cortex/states/corpAction";
import {
  corpActionsWithProvenance,
  DEFAULT_FAMILY_TIERS,
  ruleFromMap,
  type ActionEventRow,
  type ActionRow,
} from "@/lib/cortex/stage";
import { path, SESSIONS, statesWorld, type FixtureSpec } from "../cortex/states/zzStates";

const BREAK = 10;
const EX = SESSIONS[BREAK]!;
const KNOWN_AT = `${SESSIONS[9]!}T05:00:00.000Z`;

const action = (
  code: string,
  id: string,
  sources: readonly string[],
  knownAt: string | null,
): ActionRow => ({
  id,
  code,
  type: "split",
  exDate: EX,
  payload: { new: 2, old: 1 },
  knownAt,
  evidence: { sources: sources.map((src) => ({ src, ref: "r" })) },
});

describe("corpActionsWithProvenance (D-321)", () => {
  it("reads sources from evidence_json and add_source notes, and the status from the newest event", () => {
    const events: ActionEventRow[] = [
      {
        actionId: "1",
        at: "2026-02-10T01:00:00.000Z",
        status: "queued",
        note: JSON.stringify({ queue: "pending" }),
      },
      {
        actionId: "1",
        at: "2026-02-11T01:00:00.000Z",
        status: "queued",
        note: JSON.stringify({
          queue: "pending",
          add_source: { src: "announcement", ref: "ann-1" },
        }),
      },
    ];
    const [rec] = corpActionsWithProvenance([action("ZZV", "1", ["vendor"], null)], events);
    expect(rec).toMatchObject({ sources: ["announcement", "vendor"], status: "pending" });
    // a pending row is known at its FIRST event (first ingestion)
    expect(rec!.knownAt).toBe("2026-02-10T01:00:00.000Z");
  });

  it("a confirmed row is known at known_at; a row with no event reads pending", () => {
    const [done, none] = corpActionsWithProvenance(
      [action("ZZV", "2", ["announcement"], KNOWN_AT), action("ZZW", "3", ["vendor"], null)],
      [{ actionId: "2", at: KNOWN_AT, status: "auto_confirmed", note: null }],
    );
    expect(done).toMatchObject({ status: "confirmed", knownAt: KNOWN_AT });
    expect(none).toMatchObject({ status: "pending", knownAt: null });
  });

  it("a rejected and a reversed resolution keep their status", () => {
    const evs: ActionEventRow[] = [
      {
        actionId: "4",
        at: KNOWN_AT,
        status: "resolved",
        note: JSON.stringify({ resolution: "rejected" }),
      },
      {
        actionId: "5",
        at: KNOWN_AT,
        status: "resolved",
        note: JSON.stringify({ resolution: "reversed" }),
      },
    ];
    const out = corpActionsWithProvenance(
      [
        action("ZZA", "4", ["announcement"], KNOWN_AT),
        action("ZZB", "5", ["announcement"], KNOWN_AT),
      ],
      evs,
    );
    expect(out.map((r) => r.status)).toEqual(["rejected", "reversed"]);
  });
});

function worldOf(code: string, rec: ReturnType<typeof corpActionsWithProvenance>[number]) {
  const spec: FixtureSpec = {
    code,
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.5, -0.01]) },
    corpActions: [rec],
  };
  return buildAsOfView(statesWorld([spec]));
}

describe("the producer's rows through the Cortex state machine", () => {
  it("a vendor-only confirmed row never re-bases: no candidate, no early confirmation", () => {
    const [rec] = corpActionsWithProvenance(
      [action("ZZV", "10", ["vendor"], KNOWN_AT)],
      [{ actionId: "10", at: KNOWN_AT, status: "auto_confirmed", note: null }],
    );
    expect(rec).toMatchObject({ status: "confirmed", sources: ["vendor"] });
    const view = worldOf("ZZV", rec!);
    expect(candidateGroups(view, "ZZV", BREAK)).toEqual([]);
    let s = null as ReturnType<typeof stepCorpAction>["next"] | null;
    const states: string[] = [];
    for (let t = 0; t <= BREAK + 1; t += 1) {
      const step = stepCorpAction(view, "ZZV", t, s);
      s = step.next;
      states.push(step.next.state);
      if (t === BREAK) expect(step.effects.rebase).toBeNull();
    }
    expect(states[9]).toBe("none");
  });

  it("a pending announcement is a candidate from the session it became known", () => {
    const [rec] = corpActionsWithProvenance(
      [action("ZZN", "11", ["announcement"], null)],
      [
        {
          actionId: "11",
          at: KNOWN_AT,
          status: "queued",
          note: JSON.stringify({ queue: "pending" }),
        },
      ],
    );
    expect(rec).toMatchObject({ status: "pending", sources: ["announcement"], knownAt: KNOWN_AT });
    const view = worldOf("ZZN", rec!);
    expect(candidateGroups(view, "ZZN", BREAK)).not.toEqual([]);
    let s = null as ReturnType<typeof stepCorpAction>["next"] | null;
    const states: string[] = [];
    for (let t = 0; t <= 9; t += 1) {
      const step = stepCorpAction(view, "ZZN", t, s);
      s = step.next;
      states.push(step.next.state);
    }
    expect(states[8]).toBe("none");
    expect(states[9]).toBe("candidate");
  });
});

describe("ruleFromMap", () => {
  it("a family without a map gets a cluster-less rule (its candidates are G04 map_missing, D-335)", () => {
    expect(ruleFromMap("F1", undefined)).toEqual({
      ruleVersion: "F1.none",
      clusters: [],
      familyMeanNet: 0,
      tiers: DEFAULT_FAMILY_TIERS.F1,
    });
  });

  it("reads the optional import fields of params_json; top3MinS stays absent when not stored", () => {
    const base = {
      market: "AU",
      family: "F4",
      ruleVersion: "F4.v7",
      fittedAt: "2030-01-01T00:00:00.000Z",
      activeSetHash: "h",
      nEff: 100,
      pool: "p",
      fitSplit: "development",
    } as const;
    const plain = ruleFromMap("F4", {
      ...base,
      params: { a: 1, b: 0, s_mean: 0, s_sd: 1, K: 2, clusters: ["momentum", "liquidity"] },
    });
    expect(plain.top3MinS).toBeUndefined();
    expect(plain.tiers).toEqual(DEFAULT_FAMILY_TIERS.F4);
    const full = ruleFromMap("F4", {
      ...base,
      params: {
        a: 1,
        b: 0,
        s_mean: 0,
        s_sd: 1,
        K: 2,
        clusters: ["momentum", "liquidity"],
        top3_min_s: 0.4,
        family_mean_net: 0.02,
        gain: 0.1,
        loss: 0.05,
        slots: 2,
        tiers: ["U1", "U2"],
        p_hidden: true,
      } as never,
    });
    expect(full).toMatchObject({
      top3MinS: 0.4,
      familyMeanNet: 0.02,
      gainLoss: { gain: 0.1, loss: 0.05 },
      slots: 2,
      tiers: ["U1", "U2"],
      pHidden: true,
    });
  });
});
