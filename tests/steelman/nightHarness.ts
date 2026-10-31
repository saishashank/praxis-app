// Synthetic ZZ night for the steelman writer, night-stage and acceptance tests (M11-lite WP4). Test-only
// helper (not a test file). All codes are ZZ*, all dates in 2026; the database goes through the REAL
// migrations; rows are inserted directly so each path can be driven from a known state.
import type { Client } from "@libsql/client";
import { defaultAgentParams, type LlmParams } from "@/lib/agents/params";
import type { CalendarRow } from "@/lib/data/calendar";
import { createRouter, type LlmRouter } from "@/lib/llm/router";
import { MemoryStore } from "@/lib/llm/store";
import type { LlmProvider, ProviderRequest } from "@/lib/llm/providers";
import { criticChain } from "@/lib/steelman/critic";
import type { SteelmanKeys, SteelmanLlm } from "@/lib/steelman/night";
import { freshDb } from "../db/helpers";

export const MARKET = "AU";
export const D = "2026-03-04";
export const NOW = "2026-03-04T08:00:00.000Z";
export const CUT = "2026-03-04T07:10:00.000Z"; // 18:10 Melbourne (AEDT)
export const SHA = "a".repeat(64);
export const params = defaultAgentParams();
export const KEYS: SteelmanKeys = {
  dailyCards: 8,
  maxItems: 25,
  expirySessions: 10,
  decisionCutoff: "18:10",
};
export const CALENDAR: CalendarRow[] = [];

const CARD = {
  family: "F3",
  rule_version: "v1",
  thesis: "drift",
  regime: "NEUTRAL",
  rules_fired: [{ rule: "volume_surge", value: "2.4", threshold: "2.0", pass: true }],
  evidence: {
    events: [{ category: "contract_win", polarity: "positive", day0: D }],
    insider_flow: "unknown",
    data_quality_flags: ["thin"],
    other_flags: [],
  },
  scenario: {
    insufficient_history: false,
    n: 37,
    p10_ppm: -3,
    p50_ppm: 5,
    p90_ppm: 9,
    split_version: 2,
  },
  sizing: { accepted: true, half_size: false, reasons: [] },
  cost: { available: true, break_even_ppm: 4200 },
};

/** Cards c1 (ZZA, rank 1.5) and c2 (ZZB, rank 9.5) taken, c3 (ZZC) not taken, and one pick ZZP rank 1. */
export async function seedNight(existing?: Client): Promise<Client> {
  const db = existing ?? (await freshDb("main"));
  const sig = (id: string, code: string, score: string) =>
    db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json, evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', ?, '[]', '{}', 1, 'a', 'r', ?)`,
      args: [id, D, code, score, CUT],
    });
  await sig("s1", "ZZA", "1.5");
  await sig("s2", "ZZB", "9.5");
  await sig("s3", "ZZC", "5.0");
  const dc = (id: string, sid: string, taken: number) =>
    db.execute({
      sql: `INSERT INTO decision_card (id, signal_id, execution_id, taken, not_taken_reason, order_id, card_json, card_sha, schema_version, decided_at)
            VALUES (?, ?, 'x', ?, ?, ?, ?, ?, 1, ?)`,
      args: [
        id,
        sid,
        taken,
        taken ? null : "rank",
        taken ? `o-${id}` : null,
        JSON.stringify(CARD),
        SHA,
        CUT,
      ],
    });
  await dc("c1", "s1", 1);
  await dc("c2", "s2", 1);
  await dc("c3", "s3", 0);
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, 'balanced', 1, 'ZZP', 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', 10000000, 10050000,
            '2026-03-12', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    args: [D, SHA, CUT],
  });
  return db;
}

// ---- scripted providers -------------------------------------------------------------------------

export type Scripted = LlmProvider & { calls: ProviderRequest[] };

/** A mock provider that answers every call with `answer(request)` (a JSON text), counting its calls. */
export function scripted(
  id: string,
  answer: (req: ProviderRequest) => string,
  over: Partial<LlmProvider> = {},
): Scripted {
  const calls: ProviderRequest[] = [];
  return {
    id,
    kind: "mock",
    paid: false,
    trainsOnPrompts: false,
    modelFor: (r) => (r === "R6" ? `${id}-model` : undefined),
    available: () => true,
    call(req) {
      calls.push(req);
      return Promise.resolve({ text: answer(req), tokensIn: 100, tokensOut: 100 });
    },
    calls,
    ...over,
  };
}

/** A critic answer that vouches for every numbered point in the prompt except `except`. */
export function criticAnswer(
  except: readonly number[] = [],
  note = "not supported",
): (r: ProviderRequest) => string {
  return (req) => {
    const idx = [
      ...new Set([...req.prompt.matchAll(/"pointIndex":(\d+)/g)].map((m) => Number(m[1]))),
    ];
    return JSON.stringify({
      verdicts: idx.map((pointIndex) => ({
        pointIndex,
        supported: !except.includes(pointIndex),
        note: except.includes(pointIndex) ? note : "supported",
      })),
    });
  };
}

export const routerOf = (
  providers: readonly LlmProvider[],
  store = new MemoryStore(),
  mode: "mock" | "rules-only" = "mock",
  lp: LlmParams = params.llm,
): LlmRouter =>
  createRouter({
    mode,
    params: lp,
    kbVersion: "t",
    store,
    providers,
    chain: { R6: providers.map((p) => p.id) },
    now: () => new Date(NOW),
  });

/** Author and critic providers, wired as the production factory will: critic chain = other providers. */
export function llmOf(
  author: readonly LlmProvider[],
  critics: readonly LlmProvider[],
  store = new MemoryStore(),
  lp: LlmParams = params.llm,
): SteelmanLlm {
  const all = [...author, ...critics];
  return {
    authorRouter: routerOf(author, store, "mock", lp),
    criticRouterFor: (a) => {
      const c = criticChain(all, a);
      if (c.rule === "skip") return null;
      return createRouter({
        mode: "mock",
        params: lp,
        kbVersion: "t",
        store,
        providers: all,
        chain: { R6: c.chain },
        now: () => new Date(NOW),
      });
    },
    providers: all,
    store,
  };
}

/** The evidence ids in the FACTS block of a prompt. */
export function idsOf(prompt: string): string[] {
  const m = /FACTS:\n(.*)\n/.exec(prompt);
  if (!m) return [];
  const facts = JSON.parse(m[1]!) as { items?: { id: string }[] };
  return (facts.items ?? []).map((i) => i.id);
}

/** An author that answers every pack with four valid, digit-free points citing that pack's first ids. */
export function genericAuthor(): (r: ProviderRequest) => string {
  return (req) => {
    const ids = idsOf(req.prompt);
    const at = (n: number) => [ids[n % ids.length]!];
    return JSON.stringify({
      bull: [
        { text: "The rule evidence on the card passed its check.", citations: at(0) },
        { text: "The recorded event is a favourable one for the company.", citations: at(1) },
      ],
      bear: [
        {
          text: "Past similar trades give a wide range of results.",
          citations: at(2),
          monitorable: false,
        },
        {
          text: "A data flag limits how far the evidence can be trusted.",
          citations: at(3),
          monitorable: true,
        },
      ],
    });
  };
}
