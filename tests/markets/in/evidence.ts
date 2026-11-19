// The AT-M4 window of the India market (M20 IN1; AT-M4, D-1119, D-1120): a run of consecutive sessions through the IN
// batch 1 in a development database (IN enabled in `data_only`), the recorded-day review checks, and the rolling-start
// replay over the same sessions with `market: "IN"`. Used by the hand-made test (always) and the recorded-fixture test
// (when the private fixtures checkout is present); the result is the `recorded-days-IN.json` evidence of the AT-M report.
import type { Client } from "@libsql/client";
import type { ViewBar } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { marketMoney } from "@/lib/arena/marketMoney";
import { bandLockedForSession, loadPriceBand } from "@/lib/cortex/states/bands";
import { runDay } from "@/lib/data/sources/in/day.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { toMicroFromVendor } from "@/lib/money/micro";
import { replayCohorts } from "@/lib/replay/cohortReplay";
import { allowMarket } from "../../db/helpers";
import { freshReplayDb } from "../../arena/replayHarness";
import { buildCohortWorld, type WorldSeries } from "../../fixtures/replay/cohortWorld";
import { FX, IN } from "./inNight";

export type SessionFiles = { d: string; files: Record<string, string | undefined> };

export type WindowEvidence = {
  review: boolean;
  reviewNotes: string[];
  days: { d: string; status: string; outcome: string; quality: string; bars: number }[];
  replay: {
    status: "completed" | "failed";
    sessions: number;
    cohorts: number;
    market: string;
    seedMicro: string;
    labels: { label: string; status: "computed" | "not_reachable"; reason?: string }[];
    error?: string;
  };
};

export async function runWindow(
  sessions: readonly SessionFiles[],
  holidays: readonly string[] = [],
): Promise<{ db: Client; evidence: WindowEvidence }> {
  const db = await freshReplayDb();
  await allowMarket(db, IN);
  await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
  await ensureMarketSources(db, IN);
  for (const h of holidays) {
    await db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', ?, 'holiday', NULL, 1, 'fixture')",
      args: [h],
    });
  }
  const days: WindowEvidence["days"] = [];
  const notes: string[] = [];
  let review = true;
  for (const s of sessions) {
    const r = await runDay(db, {
      d: s.d,
      files: s.files,
      nowMs: () => Date.parse(`${s.d}T12:00:00.000Z`),
    });
    const day = r.dates[0]!;
    const q = day.stages?.quality;
    days.push({
      d: s.d,
      status: r.status,
      outcome: String(day.outcome ?? day.status),
      quality: q && typeof q === "object" ? `flags ${q.flags}` : String(q ?? "none"),
      bars: day.bars,
    });
    // the review step: the day's tables agree with its files
    const n = async (t: string) =>
      Number(
        (
          await db.execute({
            sql: `SELECT COUNT(*) AS n FROM ${t} WHERE market='IN' AND d = ?`,
            args: [s.d],
          })
        ).rows[0]!.n,
      );
    const [bars, snap, bands] = [
      await n("price_bar"),
      await n("universe_snapshot"),
      await n("price_band"),
    ];
    if (bars !== snap) {
      review = false;
      notes.push(`${s.d}: ${bars} bars but ${snap} universe rows`);
    }
    if (s.files.bands !== undefined && bands === 0) {
      review = false;
      notes.push(`${s.d}: a band file was given and no band row was stored`);
    }
    if (r.status !== "ok") review = false;
  }

  // the rolling-start replay over the same sessions
  const dates = sessions.map((s) => s.d);
  const rs = await db.execute(
    "SELECT code, d, o, h, l, c, volume FROM price_bar WHERE market='IN' ORDER BY code, d",
  );
  const byCode = new Map<string, Map<string, ViewBar>>();
  for (const r of rs.rows) {
    const code = String(r.code);
    const d = String(r.d);
    let m = byCode.get(code);
    if (m === undefined) byCode.set(code, (m = new Map()));
    m.set(d, {
      d,
      open: toMicroFromVendor(Number(r.o)),
      high: toMicroFromVendor(Number(r.h)),
      low: toMicroFromVendor(Number(r.l)),
      close: toMicroFromVendor(Number(r.c)),
      volume: BigInt(Number(r.volume)),
    });
  }
  const series: WorldSeries[] = [...byCode.keys()].sort().map((code) => ({
    code,
    tier: "U1",
    bars: dates.map((d) => byCode.get(code)!.get(d) ?? null),
  }));
  const params = defaultAgentParams();
  const table = marketMoney(IN).tickTable;
  // band locks of the window, from the stored `price_band` rows and the previous close (D-1109)
  const locked = new Set<string>();
  for (const [code, bars] of byCode) {
    for (const [i, d] of dates.entries()) {
      const bar = bars.get(d);
      const prev = i === 0 ? undefined : bars.get(dates[i - 1]!);
      if (bar === undefined) continue;
      const row = await loadPriceBand(db, IN, code, d);
      if (bandLockedForSession(row, prev?.close ?? null, { closeMicro: bar.close }, table)) {
        locked.add(`${code}|${d}`);
      }
    }
  }
  const world = buildCohortWorld(dates, series, params, {});
  const src = Object.assign(world, {
    bandLocked: (code: string, d: string) => locked.has(`${code}|${d}`),
  });
  let replay: WindowEvidence["replay"];
  try {
    const res = replayCohorts(src, {
      params,
      market: IN,
      controlsPerFamily: 1,
      step: 1,
      cohortParams: () => ({ fxRow: FX }),
    });
    const edges = params.progress.sessionsEdges;
    const reached = new Set(res.cohorts.flatMap((c) => c.checkpoints.map((k) => k[0])));
    replay = {
      status: "completed",
      sessions: res.sessions,
      cohorts: res.cohorts.length,
      market: res.market,
      seedMicro: res.cohorts[0] === undefined ? "0" : String(res.cohorts[0].seedMicro),
      labels: edges.map((e) =>
        reached.has(e)
          ? { label: `checkpoint ${e}`, status: "computed" as const }
          : {
              label: `checkpoint ${e}`,
              status: "not_reachable" as const,
              reason: `the window has ${res.sessions} sessions, fewer than ${e}`,
            },
      ),
    };
  } catch (e) {
    replay = {
      status: "failed",
      sessions: dates.length,
      cohorts: 0,
      market: IN,
      seedMicro: "0",
      labels: [],
      error: e instanceof Error ? e.message.slice(0, 200) : "error",
    };
  }
  return { db, evidence: { review, reviewNotes: notes, days, replay } };
}
