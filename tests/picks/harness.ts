// Synthetic world for the picks tests (M6 T17). Everything is synthetic (codes ZZ*, dates in 2030).
// The database goes through the REAL migrations; signals, cards, bars, ledger rows and labels are
// inserted directly so each rule can be tested from a known state.
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { vi } from "vitest";
import { freshDb } from "../db/helpers";

// Migrating a database and inserting a synthetic world is slow when the suite runs in parallel.
vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

export const MARKET = "AU";
export const START = "2030-01-02";
export const NOW = "2030-04-01T07:00:00.000Z";
export const HISTORY = 60;

export function sessionList(n: number): string[] {
  const out: string[] = [];
  for (let d = START; out.length < n; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

/** 90 sessions: 0..59 history and tonight (D = index 59), 60.. are the sessions after publication. */
export const SESSIONS = sessionList(90);
export const D = SESSIONS[HISTORY - 1]!;
export const params = defaultAgentParams();

export type Sql = (sql: string, args?: (string | number | bigint | null)[]) => Promise<unknown>;

export async function world(): Promise<{ db: Client; run: Sql }> {
  const db = await freshDb("main");
  const run: Sql = (sql, args = []) => db.execute({ sql, args });
  return { db, run };
}

export type CodeSpec = { code: string; tier: "U1" | "U2" | "U3"; base: bigint; step: bigint };

/** Bars for sessions [from, to): close = base + step*i (micro), a 1 % range around it. */
export async function addBars(
  run: Sql,
  spec: CodeSpec,
  from: number,
  to: number,
  over: Record<number, { o?: bigint; h?: bigint; l?: bigint; c?: bigint }> = {},
): Promise<void> {
  for (let i = from; i < to; i += 1) {
    const c = over[i]?.c ?? spec.base + spec.step * BigInt(i % 7); // a small repeating wiggle
    const o = over[i]?.o ?? c;
    const h = over[i]?.h ?? (c > o ? c : o) + c / 100n;
    const l = over[i]?.l ?? (c < o ? c : o) - c / 100n;
    await run(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      [
        MARKET,
        spec.code,
        SESSIONS[i]!,
        Number(o) / 1e6,
        Number(h) / 1e6,
        Number(l) / 1e6,
        Number(c) / 1e6,
        1_000_000,
        `${SESSIONS[i]}T07:00:00.000Z`,
        `${SESSIONS[i]}T07:00:00.000Z`,
      ],
    );
  }
}

export async function addUniverse(run: Sql, d: string, specs: CodeSpec[]): Promise<void> {
  for (const s of specs) {
    await run(
      `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
       VALUES (?, ?, ?, 'active', ?, 1e9, 1e6, 0)`,
      [MARKET, d, s.code, s.tier],
    );
  }
}

export async function addExecutionAndLabel(
  run: Sql,
  family: string,
  ruleVersion: string,
  label: string,
): Promise<void> {
  await run(
    `INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile)
     VALUES (?, ?, 'E', ?, 'U', ?, 'P5')`,
    [`E-${family}`, MARKET, family, ruleVersion],
  );
  await run(
    `INSERT INTO label (id, execution_id, rule_version, variant, label, n, d)
     VALUES (?, ?, ?, 'U', ?, 40, ?)`,
    [`L-${family}-${ruleVersion}`, `E-${family}`, ruleVersion, label, SESSIONS[0]!],
  );
}

export const sigId = (d: string, family: string, rv: string, code: string): string =>
  `sig:${MARKET}:${d}:${family}:${rv}:U:${code}`;

export async function addSignal(
  run: Sql,
  o: {
    d: string;
    family: string;
    rv: string;
    code: string;
    tier: string;
    closeMicro: bigint;
    rank: string;
    rules?: { rule: string; value: string; threshold: string; pass: boolean }[];
    partial?: number;
  },
): Promise<string> {
  const id = sigId(o.d, o.family, o.rv, o.code);
  await run(
    `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score,
       rules_json, evidence_json, partial, schema_version, agent_version, inputs_ref, decided_at)
     VALUES (?, ?, ?, ?, ?, 'U', ?, 'NEUTRAL', ?, ?, ?, ?, 1, 'test', 'ref', ?)`,
    [
      id,
      MARKET,
      o.d,
      o.family,
      o.rv,
      o.code,
      o.rank,
      JSON.stringify(
        o.rules ?? [{ rule: "rsi_short", value: "6/1", threshold: "10/1", pass: true }],
      ),
      JSON.stringify({ close_micro: String(o.closeMicro), tier: o.tier }),
      o.partial ?? 0,
      `${o.d}T07:00:00.000Z`,
    ],
  );
  return id;
}

export async function addCard(run: Sql, signalId: string, stopMicro: bigint): Promise<string> {
  const id = `card:${signalId}`;
  await run(
    `INSERT INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, card_json,
       card_sha, schema_version, decided_at)
     VALUES (?, ?, 'E-F1', 0, 'rank', ?, ?, 1, ?)`,
    [
      id,
      signalId,
      JSON.stringify({
        exit_plan: [
          {
            rule: "stop",
            tag: "IS",
            via: null,
            kind: "initial_stop",
            detail: { stop_at_close_micro: String(stopMicro) },
          },
          { rule: "time", tag: "CS", via: null, kind: "time_stop", detail: { sessions: 40 } },
        ],
      }),
      "a".repeat(64),
      `${D}T07:00:00.000Z`,
    ],
  );
  return id;
}

/**
 * A development split and 32 closed forward-ledger rows for (F1, F1.v1, U): each held 4 sessions
 * (entry session counted), qty 100 at A$10, out A$9.0 + 0.1 * i.
 */
export async function addHistory(run: Sql, family = "F1", rv = "F1.v1", rows = 32): Promise<void> {
  const devEnd = SESSIONS[50]!;
  await run("INSERT INTO lineage (id, created_d) VALUES (?, ?)", [
    `${MARKET}:${family}`,
    SESSIONS[0]!,
  ]);
  await run(
    `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len, purge,
       data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d, dev_end_d, reason)
     VALUES (?, 1, 5, 5, 5, 2, ?, ?, ?, ?, ?, ?, 'create')`,
    [`${MARKET}:${family}`, D, SESSIONS[55]!, D, SESSIONS[51]!, SESSIONS[54]!, devEnd],
  );
  for (let i = 0; i < rows; i += 1) {
    const sid = await addSignal(run, {
      d: SESSIONS[i]!,
      family,
      rv,
      code: "ZZH1",
      tier: "U1",
      closeMicro: 10_000_000n,
      rank: "1/1",
    });
    await run(
      `INSERT INTO ledger_row (id, signal_id, entry_d, qty, fill_in_micro, brok_in_micro,
         stress_in_micro, timed, forward) VALUES (?, ?, ?, 100, 10000000, 3000000, 10000000, 1, 1)`,
      [`lr-${family}-${i}`, sid, SESSIONS[i]!],
    );
    await run(
      `UPDATE ledger_row SET exit_d = ?, exit_tag = 'CS', fill_out_micro = ?, brok_out_micro = 3000000,
         stress_out_micro = ?, qty_out = 100, gross_num = 1, gross_den = 1 WHERE id = ?`,
      [SESSIONS[i + 3]!, 9_000_000 + 100_000 * i, 9_000_000 + 100_000 * i, `lr-${family}-${i}`],
    );
  }
}
