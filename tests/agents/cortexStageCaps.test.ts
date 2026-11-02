// @vitest-environment node
// D-347: the CTX-026 caps span all 12 books. Twelve A$600 books on the ZZ world: an A$500 entry is a
// small share of the arena's NAV, so G11 passes; a second book may take the same code (2 books, under
// 20 %); a third book is stopped at G11 for that code.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { runNight } from "@/lib/cortex/night";
import { book, nightInputs } from "../cortex/night/zzNight";

const A600 = 600_000_000n;
const twelve = Array.from({ length: 12 }, (_, i) =>
  book(`E${String(i + 1).padStart(2, "0")}`, "F1", {
    positions: [],
    settledCashMicro: A600,
    navMicro: A600,
  }),
);

describe("G11 over the whole arena (D-347)", () => {
  const out = runNight(
    nightInputs(undefined, {
      books: twelve,
      status: { F1: "allowed" },
      params: {
        ...defaultAgentParams(),
        cortex: { ...defaultAgentParams().cortex, disagreementMax: 1 },
      },
    }),
  );

  it("an A$500 entry passes G11 against the 12-book NAV, a second book may hold the same code", () => {
    const live = out.decisions.filter((x) => x.family === "F1");
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live[0]!.code).toBe(live[1]!.code);
    for (const x of live) {
      expect(x.trace.find((t) => t.gateId === "G11_portfolio")?.pass).toBe(true);
      expect(x.orderValueMicro).toBeLessThanOrEqual(A600);
    }
  });

  it("the third book cannot take that code (at most 2 books)", () => {
    const live = out.decisions.filter((x) => x.family === "F1");
    const code = live[0]!.code;
    expect(live.filter((x) => x.code === code)).toHaveLength(2);
    const stopped = out.blocked.filter(
      (x) => x.arm === "live" && x.code === code && x.firstFail === "G11_portfolio",
    );
    expect(stopped.length).toBeGreaterThan(0);
  });

  it("context books count in the NAV and the holdings (leverage twins)", () => {
    const solo = runNight(
      nightInputs(undefined, {
        books: [twelve[0]!],
        contextBooks: twelve.slice(1),
        status: { F1: "allowed" },
        params: {
          ...defaultAgentParams(),
          cortex: { ...defaultAgentParams().cortex, disagreementMax: 1 },
        },
      }),
    );
    const d = solo.decisions.find((x) => x.family === "F1");
    expect(d?.trace.find((t) => t.gateId === "G11_portfolio")?.pass).toBe(true);
  });
});
