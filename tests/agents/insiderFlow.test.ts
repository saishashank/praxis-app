// @vitest-environment node
// A2 insider/flow score (M4 T6; AGT-105; design 2.5, decision 13): quarter units, unknown is NULL
// and never 0, publication times only, window and weights from AgentParams. Synthetic data only.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import {
  insiderFlowFor,
  insiderFlowScore,
  insiderInputsJson,
  insiderWindowStart,
} from "@/lib/agents/insiderFlow";
import { createDecisionView, decisionCutoffUtc, type NoticeRow } from "@/lib/agents/decisionView";
import type { CalendarRow, MarketHours } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const hours: MarketHours = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };
const calendar: CalendarRow[] = [];

const n = (kind: string, value: bigint | null = null, id = kind): NoticeRow => ({
  ann_id: id,
  kind,
  value_micro: value,
  published_at: "2026-10-01T01:00:00.000Z",
});

describe("A2 insider/flow score (pure)", () => {
  it("unknown (no notice source has run) is null, never 0", () => {
    const s = insiderFlowScore([], false, p);
    expect(s.score_q).toBeNull();
    expect(s.inputs.covered).toBe(false);
  });

  it("covered with no notices is a known 0", () => {
    expect(insiderFlowScore([], true, p).score_q).toBe(0);
  });

  it("net director buying +0.5 = +2 quarter units; selling -2", () => {
    expect(insiderFlowScore([n("director_buy", 5_000_000n)], true, p).score_q).toBe(2);
    expect(insiderFlowScore([n("director_sell", 5_000_000n)], true, p).score_q).toBe(-2);
  });

  it("director direction is the net by value; equal values net to zero", () => {
    const buy = n("director_buy", 9_000_000n, "b");
    const sell = n("director_sell", 4_000_000n, "s");
    expect(insiderFlowScore([buy, sell], true, p).score_q).toBe(2);
    expect(insiderFlowScore([n("director_buy", 4_000_000n, "b"), sell], true, p).score_q).toBe(0);
  });

  it("without values the direction is the count of buys against sells", () => {
    const rows = [
      n("director_buy", null, "a"),
      n("director_buy", null, "b"),
      n("director_sell", null, "c"),
    ];
    expect(insiderFlowScore(rows, true, p).score_q).toBe(2);
  });

  it("substantial holder: new or increase +0.25 (+1), decrease -0.25 (-1), once each", () => {
    expect(insiderFlowScore([n("sh_new")], true, p).score_q).toBe(1);
    expect(
      insiderFlowScore([n("sh_increase", null, "a"), n("sh_new", null, "b")], true, p).score_q,
    ).toBe(1);
    expect(insiderFlowScore([n("sh_decrease")], true, p).score_q).toBe(-1);
    expect(
      insiderFlowScore([n("sh_new", null, "a"), n("sh_decrease", null, "b")], true, p).score_q,
    ).toBe(0);
  });

  it("sums director and holder components (polarity)", () => {
    expect(
      insiderFlowScore([n("director_buy", 1n, "a"), n("sh_increase", null, "b")], true, p).score_q,
    ).toBe(3);
    expect(
      insiderFlowScore([n("director_sell", 1n, "a"), n("sh_decrease", null, "b")], true, p).score_q,
    ).toBe(-3);
  });

  it("clips to [-1, +1] (-4..+4 quarter units) with heavier weights from the config", () => {
    const heavy = buildAgentParams((k) =>
      k === "insider_score_weights"
        ? { director_net: 0.75, holder_new_or_increase: 0.5, holder_decrease: 0.5 }
        : CONFIG_KEYS[k].default,
    );
    expect(
      insiderFlowScore([n("director_buy", 1n, "a"), n("sh_new", null, "b")], true, heavy).score_q,
    ).toBe(4);
    expect(
      insiderFlowScore([n("director_sell", 1n, "a"), n("sh_decrease", null, "b")], true, heavy)
        .score_q,
    ).toBe(-4);
  });

  it("weights come from AgentParams: a changed director weight changes the score", () => {
    const light = buildAgentParams((k) =>
      k === "insider_score_weights"
        ? { director_net: 0.25, holder_new_or_increase: 0.25, holder_decrease: 0.25 }
        : CONFIG_KEYS[k].default,
    );
    expect(insiderFlowScore([n("director_buy", 1n)], true, light).score_q).toBe(1);
  });

  it("inputs JSON has a fixed key order", () => {
    expect(insiderInputsJson(insiderFlowScore([], false, p).inputs)).toBe(
      '{"covered":false,"director_net":0,"holder_down":false,"holder_up":false,"notices":0}',
    );
  });

  it("the window start is sessions-1 trading days back", () => {
    const rows: CalendarRow[] = [];
    expect(insiderWindowStart("2026-10-15", 1, rows)).toBe("2026-10-15");
    expect(insiderWindowStart("2026-10-15", 3, rows)).toBe("2026-10-13");
    expect(insiderWindowStart("2026-10-19", 2, rows)).toBe("2026-10-16");
  });
});

const D = "2026-10-15";
const CUTOFF = decisionCutoffUtc(D, p.decisionCutoff);

async function db(rows: { id: string; code: string; kind: string; at: string; value?: number }[]) {
  const c = await freshDb("main");
  await c.batch(
    rows.map((r) => ({
      sql: `INSERT INTO insider_notice (market, ann_id, code, kind, value_micro, published_at, parser_version)
            VALUES ('AU', ?, ?, ?, ?, ?, 'v1')`,
      args: [r.id, r.code, r.kind, r.value ?? null, r.at],
    })),
  );
  return c;
}

describe("A2 insider/flow score (DB reader)", () => {
  const read = async (c: Awaited<ReturnType<typeof db>>) =>
    insiderFlowFor(
      createDecisionView(c, { market: "AU", d: D, cutoff: CUTOFF }),
      "AAA",
      p,
      calendar,
      hours,
    );

  it("no notices anywhere: unknown (NULL)", async () => {
    const row = await read(await db([]));
    expect(row.score_q).toBeNull();
    expect(row).toMatchObject({ market: "AU", code: "AAA", d: D });
  });

  it("only a notice published after the cut-off exists: still unknown (poison not read)", async () => {
    const row = await read(
      await db([{ id: "x", code: "AAA", kind: "director_buy", at: "2026-10-15T07:30:00.000Z" }]),
    );
    expect(row.score_q).toBeNull();
  });

  it("a notice at exactly the cut-off is not read", async () => {
    const row = await read(await db([{ id: "x", code: "AAA", kind: "director_buy", at: CUTOFF }]));
    expect(row.score_q).toBeNull();
  });

  it("notices in the window count; older ones and other codes do not; coverage is market-wide", async () => {
    const row = await read(
      await db([
        { id: "a", code: "AAA", kind: "director_buy", at: "2026-10-14T01:00:00.000Z", value: 100 },
        { id: "b", code: "AAA", kind: "sh_decrease", at: "2026-08-01T01:00:00.000Z" }, // outside 30 sessions
        { id: "c", code: "BBB", kind: "director_sell", at: "2026-10-14T01:00:00.000Z", value: 100 },
        { id: "d", code: "AAA", kind: "director_sell", at: "2026-10-16T01:00:00.000Z", value: 999 }, // future
      ]),
    );
    expect(row.score_q).toBe(2);
    const other = await read(
      await db([{ id: "c", code: "BBB", kind: "sh_new", at: "2026-10-14T01:00:00.000Z" }]),
    );
    expect(other.score_q).toBe(0); // covered, nothing for AAA: known zero
    expect(JSON.parse(other.inputs_json).covered).toBe(true);
  });
});
