// D-1068 (Owner O-84): the `--mode pick-scorecard` run, called by src/lib/replay/cli.ts. Builds the
// in-memory world from the snapshot bytes (the same loader the learning mode uses), replays the last N
// nights (./pickReplay.ts), adds the nights up and writes the report once (./pickScorecardStore.ts).
// Output of the CLI: statuses, counts and minutes only; never a code, a name or a row.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import { sha256Hex } from "@/lib/data/backfill/rules.mjs";
import { loadSnapshot } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import { replayNightsScored, type CortexTally } from "./pickReplay";
import { SESSIONS_DEFAULT, SESSIONS_MAX, SKIPPED_DEFAULT, summarise } from "./pickScorecard";
import {
  persistScorecard,
  scorecardExists,
  scorecardRunId,
  type ScorecardRun,
} from "./pickScorecardStore";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";

const MARKET = HOME_MARKET; // the scorecard replays the home market only

/** `--sessions N`: 1 to SESSIONS_MAX, default SESSIONS_DEFAULT; null = a bad argument. */
export function parseSessions(text: string | null): number | null {
  if (text === null) return SESSIONS_DEFAULT;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= SESSIONS_MAX ? n : null;
}

export type ScorecardResult =
  | {
      readonly kind: "recorded";
      readonly run: ScorecardRun;
      readonly rows: number;
      readonly minutes: number;
      /** D-1083: why Cortex nights gave no features (counts only). */
      readonly cortex: CortexTally;
    }
  | { readonly kind: "already" }
  | { readonly kind: "empty" };

export async function runPickScorecard(o: {
  readonly db: Client;
  readonly params: AgentParams;
  readonly snapshotBytes: Uint8Array;
  readonly sessions: number;
  readonly commitSha: string;
  readonly nowMs: () => number;
}): Promise<ScorecardResult> {
  const t0 = o.nowMs();
  const snap = loadSnapshot(o.snapshotBytes);
  const world = new SnapshotWorld(snap, { params: o.params, tierSource: "bars" });
  const { days, nights, cortex } = await replayNightsScored(
    { db: o.db, world, params: o.params, market: MARKET },
    o.sessions,
  );
  if (days.length === 0 || nights.length === 0) return { kind: "empty" };
  const summary = summarise(days, { sessions: o.sessions, skipped: SKIPPED_DEFAULT });
  const id = scorecardRunId(
    MARKET,
    summary.lastD,
    o.sessions,
    sha256Hex(o.snapshotBytes),
    o.commitSha,
  );
  if (await scorecardExists(o.db, id)) return { kind: "already" };
  const run: ScorecardRun = {
    id,
    market: MARKET,
    createdAt: new Date(o.nowMs()).toISOString(),
    commitSha: o.commitSha,
    sessions: o.sessions,
    firstD: summary.firstD,
    lastD: summary.lastD,
    status: days.length === nights.length ? "complete" : "partial",
    summary,
  };
  const rows = await persistScorecard(o.db, run, days);
  return { kind: "recorded", run, rows, minutes: (o.nowMs() - t0) / 60_000, cortex }; // threshold-ok: ms per minute
}
