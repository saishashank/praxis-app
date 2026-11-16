// D-1069 (Owner O-84): the edges of the "Replay check" section and its loader, on a stub database that
// returns one stored run: a partial run says so, a summary without a strategy-night count, without
// Cortex nights or without misses leaves those lines out, a masked viewer gets ISO weeks, a market
// other than the default is read as asked, and a database without the table gives no section.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayCheck } from "@/app/(app)/picks/ReplayCheck";
import { summarise } from "@/lib/scorecard/pickScorecard";
import { loadReplayCheck } from "@/lib/ui/loaders/pickScorecard";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";

afterEach(cleanup);

function envOf(
  summaryJson: string | null,
  o: { status?: string; masked?: boolean; market?: string; throws?: boolean } = {},
) {
  const asked: unknown[][] = [];
  const env = {
    market: o.market,
    mask: { masked: o.masked ?? false },
    now: new Date("2026-11-17T00:00:00Z"),
    main: {
      execute: async (q: { args: unknown[] }) => {
        asked.push(q.args);
        if (o.throws) throw new Error("no such table");
        return {
          rows:
            summaryJson === null
              ? []
              : [
                  {
                    id: "run",
                    market: o.market ?? "AU",
                    created_at: "2026-11-16T00:00:00.000Z",
                    commit_sha: "c",
                    sessions: 12,
                    first_d: "2026-11-02",
                    last_d: "2026-11-12",
                    status: o.status ?? "complete",
                    summary_json: summaryJson,
                  },
                ],
        };
      },
    },
  } as unknown as LoaderEnv;
  return { env, asked };
}

const base = summarise([], { sessions: 12 });
const withoutStrategy = (): string => {
  const { strategyNights: _omit, ...rest } = base;
  void _omit;
  return JSON.stringify(rest);
};

describe("loadReplayCheck", () => {
  it("reads the default market and shows a partial run as partial", async () => {
    const { env, asked } = envOf(JSON.stringify(base), { status: "partial" });
    const v = (await loadReplayCheck(env))!;
    expect(asked[0]).toEqual(["AU"]);
    expect(v).toMatchObject({ sessions: 12, partial: true, masked: false });
    expect(v.range).toBe("Mon 2 Nov to Thu 12 Nov");
  });

  it("reads the market it is asked for, and a masked viewer gets ISO weeks", async () => {
    const { env, asked } = envOf(JSON.stringify(base), { market: "US", masked: true });
    const v = (await loadReplayCheck(env))!;
    expect(asked[0]).toEqual(["US"]);
    expect(v.range).toBe("2026-W45 to 2026-W46");
    expect(v.partial).toBe(false);
  });

  it("no stored run, an unreadable summary or a database without the table gives no section", async () => {
    expect(await loadReplayCheck(envOf(null).env)).toBeNull();
    expect(await loadReplayCheck(envOf('{"v":2}').env)).toBeNull();
    expect(await loadReplayCheck(envOf(JSON.stringify(base), { throws: true }).env)).toBeNull();
  });
});

describe("ReplayCheck lines", () => {
  it("a partial run says some nights could not be scored", async () => {
    render(await ReplayCheck({ env: envOf(JSON.stringify(base), { status: "partial" }).env }));
    expect(screen.getByTestId("replay-check").textContent).toContain(
      "(some nights could not be scored)",
    );
  });

  it("a complete run does not", async () => {
    render(await ReplayCheck({ env: envOf(JSON.stringify(base)).env }));
    expect(screen.getByTestId("replay-check").textContent).not.toContain("could not be scored");
  });

  it("no strategy-night count, no Cortex nights and no misses leave those lines out", async () => {
    render(await ReplayCheck({ env: envOf(withoutStrategy()).env }));
    expect(screen.queryByTestId("replay-strategy")).toBeNull();
    expect(screen.queryByTestId("replay-cortex")).toBeNull();
    expect(screen.queryByTestId("replay-misses")).toBeNull();
    expect(screen.getByTestId("replay-caveat")).toBeInTheDocument();
    expect(screen.getByTestId("replay-gainers")).toBeInTheDocument();
  });

  it("with a strategy-night count, Cortex nights and misses, those lines are shown", async () => {
    const s = {
      ...base,
      days: 4,
      strategyNights: 3,
      misses: { ...base.misses, sector_move: 2 },
      cortex: { ...base.cortex, days: 4, gainers: 20, gainersInTop: 3, liveNights: 4 },
    };
    render(await ReplayCheck({ env: envOf(JSON.stringify(s)).env }));
    expect(screen.getByTestId("replay-strategy").textContent).toContain("3 of 4 nights");
    expect(screen.getByTestId("replay-cortex").textContent).toContain("3 of the 20 top gainers");
    expect(screen.getByTestId("replay-misses").textContent).toContain("sector move 2");
  });
});
