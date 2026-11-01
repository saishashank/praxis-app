// @vitest-environment node
// Claim status machine (KB-073, D-530): property test over all 64 pairs, the database trigger agrees, and
// nextStatusFor emits only legal edges (D-536a: formalised before screened).
import type { Client } from "@libsql/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_CLAIM_PAIRS,
  CLAIM_EDGES,
  isAllowedClaimEdge,
  nextStatusFor,
  type ClaimEvent,
} from "@/lib/experts/status";
import { CLAIM_STATUSES, type ClaimStatus } from "@/lib/experts/types";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// A legal route from `extracted` to each status.
const ROUTE: Record<ClaimStatus, ClaimStatus[]> = {
  extracted: [],
  owner_checked: ["owner_checked"],
  formalised: ["owner_checked", "formalised"],
  screened: ["owner_checked", "formalised", "screened"],
  challenger: ["owner_checked", "formalised", "screened", "challenger"],
  promoted: ["owner_checked", "formalised", "screened", "challenger", "promoted"],
  rejected: ["rejected"],
  parked: ["parked"],
};
const NOW = "2030-03-05T08:00:00.000Z";

describe("status edges", () => {
  it("has 64 pairs and the edge table is closed over the status list", () => {
    expect(ALL_CLAIM_PAIRS).toHaveLength(64);
    for (const tos of Object.values(CLAIM_EDGES))
      for (const to of tos) expect(CLAIM_STATUSES).toContain(to);
    expect(Object.keys(CLAIM_EDGES).sort()).toEqual([...CLAIM_STATUSES].sort());
  });

  it("promoted and rejected are final; parked only reopens to owner_checked", () => {
    expect(CLAIM_EDGES.promoted).toEqual([]);
    expect(CLAIM_EDGES.rejected).toEqual([]);
    expect(CLAIM_EDGES.parked).toEqual(["owner_checked"]);
    expect(isAllowedClaimEdge("extracted", "screened")).toBe(false);
    expect(isAllowedClaimEdge("owner_checked", "screened")).toBe(false);
  });

  describe("the database trigger agrees for every pair", () => {
    let db: Client;
    beforeAll(async () => {
      db = await freshDb("main");
    });
    it("allows exactly CLAIM_EDGES", async () => {
      let n = 0;
      for (const [from, to] of ALL_CLAIM_PAIRS) {
        n += 1;
        const id = `C-T-${n}`;
        await db.execute({
          sql: "INSERT INTO claim (id, type, testability, created_at) VALUES (?, 'method', 'testable_eod', ?)",
          args: [id, NOW],
        });
        const chain: ClaimStatus[] = ["extracted", ...ROUTE[from]];
        for (const [i, status] of chain.entries()) {
          await db.execute({
            sql: "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES (?, ?, ?, 'seed', ?)",
            args: [id, i + 1, status, NOW],
          });
        }
        let allowed = true;
        try {
          await db.execute({
            sql: "INSERT INTO claim_status (claim_id, seq, status, actor, at) VALUES (?, ?, ?, 'seed', ?)",
            args: [id, chain.length + 1, to, NOW],
          });
        } catch {
          allowed = false;
        }
        expect(allowed, `${from} -> ${to}`).toBe(isAllowedClaimEdge(from, to));
      }
    });
  });
});

describe("nextStatusFor", () => {
  const events: ClaimEvent[] = [
    { kind: "person_checked" },
    { kind: "cluster_confirmed", hasValidFit: true },
    { kind: "cluster_confirmed", hasValidFit: false },
    { kind: "screened" },
    { kind: "challenger_created" },
    { kind: "challenger_promoted" },
    { kind: "rejected" },
    { kind: "parked" },
    { kind: "reopened" },
  ];

  it("never returns an illegal edge, for every status and event", () => {
    for (const from of CLAIM_STATUSES)
      for (const e of events) {
        const to = nextStatusFor(from, e);
        if (to !== null) expect(isAllowedClaimEdge(from, to), `${from} ${e.kind}`).toBe(true);
      }
  });

  it("D-536a: cluster confirmed with a valid fit formalises an owner_checked claim before screening", () => {
    expect(nextStatusFor("owner_checked", { kind: "cluster_confirmed", hasValidFit: true })).toBe(
      "formalised",
    );
    expect(
      nextStatusFor("owner_checked", { kind: "cluster_confirmed", hasValidFit: false }),
    ).toBeNull();
    expect(nextStatusFor("extracted", { kind: "cluster_confirmed", hasValidFit: true })).toBeNull();
    expect(nextStatusFor("owner_checked", { kind: "screened" })).toBeNull();
    expect(nextStatusFor("formalised", { kind: "screened" })).toBe("screened");
  });

  it("walks the happy path and the person gate", () => {
    expect(nextStatusFor("extracted", { kind: "person_checked" })).toBe("owner_checked");
    expect(nextStatusFor("parked", { kind: "reopened" })).toBe("owner_checked");
    expect(nextStatusFor("screened", { kind: "challenger_created" })).toBe("challenger");
    expect(nextStatusFor("challenger", { kind: "challenger_promoted" })).toBe("promoted");
    expect(nextStatusFor("promoted", { kind: "rejected" })).toBeNull();
    expect(nextStatusFor("rejected", { kind: "parked" })).toBeNull();
    expect(nextStatusFor("owner_checked", { kind: "person_checked" })).toBeNull();
  });
});
