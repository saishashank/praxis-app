// @vitest-environment node
// D-187: a waiting pick stands while the information holds, not for a number of sessions. Each
// check withdraws it for its own reason, a missing piece of information never does, and the
// nightly verdicts are append-only.
import { afterAll, describe, expect, it } from "vitest";
import { checkPickNight, type PickNight } from "@/lib/picks/validity";
import { cleanupTempDbs } from "../db/helpers";
import { D, MARKET, NOW, SESSIONS, world } from "./harness";

afterAll(cleanupTempDbs);

// buy up to 10.05, stop 9.20, aim 11.00: published reward-to-risk (11.00-10.05)/(10.05-9.20) = 1.12
const base: PickNight = {
  closeMicro: 10_100_000n,
  buyMaxMicro: 10_050_000n,
  stopMicro: 9_200_000n,
  aimMicro: 11_000_000n,
  family: "F1",
  regime: "RISK-ON",
  negativeNews: false,
  label: "PASSED-BACKTEST",
  dataFault: false,
  halted: false,
  sessionsWaited: 3,
  timeFrameSessions: 10,
};

describe("checkPickNight", () => {
  it("a pick whose reasons still hold stands, however many sessions it has waited", () => {
    expect(checkPickNight(base)).toBeNull();
    expect(checkPickNight({ ...base, sessionsWaited: 10 })).toBeNull();
  });

  it("each piece of information withdraws it for its own reason", () => {
    expect(checkPickNight({ ...base, dataFault: true })).toBe("data");
    expect(checkPickNight({ ...base, halted: true })).toBe("data");
    expect(checkPickNight({ ...base, closeMicro: 9_200_000n })).toBe("below_stop");
    expect(checkPickNight({ ...base, closeMicro: 11_000_000n })).toBe("aim_reached");
    expect(checkPickNight({ ...base, negativeNews: true })).toBe("negative_news");
    expect(checkPickNight({ ...base, regime: "RISK-OFF" })).toBe("regime");
    expect(checkPickNight({ ...base, label: "FAILED" })).toBe("evidence");
    expect(checkPickNight({ ...base, label: "NOT-DEMONSTRATED" })).toBe("evidence");
    expect(checkPickNight({ ...base, sessionsWaited: 11 })).toBe("horizon");
  });

  it("edge_eroded: reward-to-risk at tonight's close below half of the published one", () => {
    // close 10.60: (11.00-10.60)/(10.60-9.20) = 0.29 < 1.12/2 -> withdrawn
    expect(checkPickNight({ ...base, closeMicro: 10_600_000n })).toBe("edge_eroded");
    // close 10.30: (11.00-10.30)/(10.30-9.20) = 0.64 >= 0.56 -> stands
    expect(checkPickNight({ ...base, closeMicro: 10_300_000n })).toBeNull();
    // a close below the buy zone only improves the edge
    expect(checkPickNight({ ...base, closeMicro: 9_800_000n })).toBeNull();
  });

  it("the regime check follows the family's own gates (F4 trades in every known regime)", () => {
    expect(checkPickNight({ ...base, family: "F4", regime: "SHOCK" })).toBeNull();
    expect(checkPickNight({ ...base, family: "F2", regime: "RISK-OFF" })).toBeNull();
    expect(checkPickNight({ ...base, family: "F2", regime: "SHOCK" })).toBe("regime");
  });

  it("missing information tonight withdraws nothing (no bar, no regime row)", () => {
    expect(checkPickNight({ ...base, closeMicro: null })).toBeNull();
    expect(checkPickNight({ ...base, regime: null })).toBeNull();
  });

  it("the first failing check is the reason, in a fixed order", () => {
    expect(
      checkPickNight({ ...base, dataFault: true, negativeNews: true, closeMicro: 9_000_000n }),
    ).toBe("data");
    expect(checkPickNight({ ...base, negativeNews: true, regime: "SHOCK" })).toBe("negative_news");
  });
});

describe("pick_check table", () => {
  it("needs its published pick (append-only is checked in nightly.test.ts on real rows)", async () => {
    const { db } = await world();
    await expect(
      db.execute({
        sql: `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
              VALUES (?, ?, 'aggressive', 1, ?, 1, NULL, ?)`,
        args: [MARKET, D, SESSIONS[61]!, NOW],
      }),
    ).rejects.toThrow(/needs its published pick/);
  });
});
