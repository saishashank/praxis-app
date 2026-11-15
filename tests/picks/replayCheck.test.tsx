// D-1069 (Owner O-84): the "Replay check: last N sessions" section of the Track record page, rendered
// from a real (temporary) database holding one stored scorecard run. Unmasked: trading-day dates;
// masked: ISO weeks, and in both cases counts and percentages only (no stock code, name or price).
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld, type Who, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import TrackRecordPage from "@/app/(app)/picks/track-record/page";
import { ReplayCheck } from "@/app/(app)/picks/ReplayCheck";
import { REPLAY_CAVEAT, replayChanceWords, replayLines } from "@/app/(app)/picks/text";
import { persistScorecard, type ScorecardRun } from "@/lib/scorecard/pickScorecardStore";
import { summarise, type DayResult } from "@/lib/scorecard/pickScorecard";

let current: LoaderEnv;
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => ({ id: 1, role: "owner" })) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

afterAll(cleanupTempDbs);
afterEach(cleanup);

const as = (w: World, who: Who) => {
  current = envOf(w, who);
  return current;
};

const profile = (n: number, next: number, five: number, aim: number, stop: number) => ({
  n,
  nextN: n,
  nextSumPpm: next * n,
  nextUp: Math.ceil(n / 2),
  fiveN: n,
  fiveSumPpm: five * n,
  fiveUp: Math.ceil(n / 3),
  aim,
  stop,
  neither: n - aim - stop,
  unknown: 0,
});

function day(d: string, nextD: string, hits: number, basis: "live" | "golive" = "live"): DayResult {
  return {
    d,
    nextD,
    picksN: 6,
    gainersN: 5,
    gainerHits: hits,
    losersN: 5,
    loserHits: 1,
    liquidN: 400,
    namedN: 20,
    chancePpm: 250_000,
    profiles: {
      aggressive: profile(2, 4_000, 12_000, 1, 0),
      balanced: profile(2, 2_000, 6_000, 0, 1),
      conservative: profile(2, 1_000, 3_000, 0, 0),
    },
    detail: {
      gainers: [
        {
          code: "ZZSECRET",
          name: null,
          movePpm: 90_000,
          via: null,
          where: null,
          missed: "no_measure",
        },
      ],
      losers: [],
      picks:
        basis === "live"
          ? [
              {
                profile: "balanced",
                rank: 1,
                code: "ZZSECRET",
                source: "strategy",
                nextPpm: 0,
                fivePpm: 0,
                race: "neither",
              },
            ]
          : [],
    },
    cortex: {
      basis,
      scored: 300,
      gainersInTop: 1,
      gainersN: 5,
      losersInBottom: 2,
      losersN: 5,
      gapPpm: 3_000,
    },
  };
}

let w: World;
beforeAll(async () => {
  w = await fullWorld();
  const days = [day("2026-11-11", "2026-11-12", 1), day("2026-11-12", "2026-11-13", 0, "golive")];
  const summary = summarise(days, { sessions: 40 });
  const run: ScorecardRun = {
    id: "pickscore:AU:2026-11-12:40:aaaaaaaa:bbbbbbbb",
    market: "AU",
    createdAt: "2026-11-16T00:00:00.000Z",
    commitSha: "b".repeat(40),
    sessions: 40,
    firstD: "2026-11-11",
    lastD: "2026-11-12",
    status: "complete",
    summary,
  };
  await persistScorecard(w.main, run, days);
});

describe("Replay check section", () => {
  it("unmasked: the lines, the dates in trading words and the caveat", async () => {
    const env = as(w, "owner");
    render(await ReplayCheck({ env }));
    expect(screen.getByRole("heading", { name: "Replay check: last 40 sessions" })).toBeTruthy();
    const box = screen.getByTestId("replay-check");
    expect(box.textContent).toContain("Wed 11 Nov to Thu 12 Nov");
    // 1 of 2 days with a top-5 gainer in our picks; chance 0.25 a day = about 1 day in 4
    expect(screen.getByTestId("replay-gainers").textContent).toContain(
      "Top-5 gainers in our picks: 1 of 2 days (chance: about 1 day in 4)",
    );
    expect(screen.getByTestId("replay-losers").textContent).toContain(
      "Top-5 losers in our picks: 2 of 10",
    );
    const profiles = screen.getByTestId("replay-profiles").textContent!;
    expect(profiles).toContain("Aggressive: 4 picks; average next day +0.4%, 5 sessions +1.2%");
    expect(profiles).toContain("aim reached 2, stop hit 0");
    // the Cortex line: 2 nights x 1 of 5 gainers in the top tenth; chance 10 % of 10 = 1.0
    expect(screen.getByTestId("replay-cortex").textContent).toContain(
      "Cortex's top tenth held 2 of the 10 top gainers (chance: about 1.0)",
    );
    expect(screen.getByTestId("replay-cortex").textContent).toContain(
      "Cortex: 1 nights live, 1 nights replayed with its go-live measures.",
    );
    expect(screen.getByTestId("replay-strategy").textContent).toContain(
      "Strategy picks: 1 of 2 nights (others had only shortlist picks).",
    );
    expect(screen.getByTestId("replay-misses").textContent).toContain("no measure 2");
    expect(screen.getByTestId("replay-caveat").textContent).toBe(REPLAY_CAVEAT);
    // never an ISO date, an internal code or a stock code
    expect(box.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(box.textContent).not.toContain("ZZSECRET");
    expect(box.textContent).not.toMatch(/pickscore|report_look|F[1-6]\./);
  });

  it("masked: ISO weeks instead of dates, the same counts, no code or name", async () => {
    const env = as(w, "viewer");
    expect(env.mask.masked).toBe(true);
    render(await ReplayCheck({ env }));
    const box = screen.getByTestId("replay-check");
    expect(box.textContent).toContain("2026-W46 to 2026-W46");
    expect(box.textContent).not.toContain("Wed 11 Nov");
    expect(screen.getByTestId("replay-gainers").textContent).toContain("1 of 2 days");
    expect(box.textContent).not.toContain("ZZSECRET");
    expect(box.textContent).not.toMatch(/ZZ[A-Z]+/);
  });

  it("shows on the Track record page, and says so plainly when no run exists yet", async () => {
    as(w, "owner");
    render(await TrackRecordPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByTestId("replay-check")).toBeTruthy();
    cleanup();
    const empty = await fullWorld();
    render(await ReplayCheck({ env: envOf(empty, "owner") }));
    expect(screen.getByTestId("replay-check").textContent).toContain("Replay check: not run yet");
    expect(screen.getByTestId("replay-check").textContent).toContain(
      "No replay check has been run yet.",
    );
  });

  it("words: chance as a day count, and the plain lines of an empty profile", () => {
    expect(replayChanceWords(0)).toBe("none expected");
    expect(replayChanceWords(0.5)).toBe("about 1 day in 2");
    expect(replayChanceWords(1.2)).toBe("about every day");
    const s = summarise([], { sessions: 40 });
    const l = replayLines({ ...s, profiles: { balanced: { ...profile(0, 0, 0, 0, 0), n: 0 } } });
    expect(l.profiles).toEqual(["Balanced: no picks in this window."]);
    expect(l.cortex).toEqual([]);
    expect(l.misses).toBeNull();
  });
});
