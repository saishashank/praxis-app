// Test-only helpers for the pick-reflection tests (M22 C3): a settled pick on the synthetic ZZ night, its steelman points,
// thesis checks, a scripted writer that answers by the ids in the prompt, and a statement spy. Not a test file. Synthetic
// data only (SEC-110).
import type { Client } from "@libsql/client";
import type { ProviderRequest } from "@/lib/llm/providers";
import { createRouter } from "@/lib/llm/router";
import { MemoryStore, type LlmStore } from "@/lib/llm/store";
import type { ReflectLlm, ReflectOptions } from "@/lib/steelman/reflect";
import { D, MARKET, NOW, SHA, params, scripted, seedNight, type Scripted } from "./nightHarness";

export { D, MARKET, NOW, params, scripted, seedNight };
export type { Scripted };

/** The session the pick of `seedNight` settles in (the session being run). */
export const SETTLED_D = "2026-03-12";
export const RUN_NOW = "2026-03-12T08:00:00.000Z";
export const PICK = { d: D, profile: "balanced", rank: 1, code: "ZZP" };

/** Settles the seed pick: bought, closed at the stop level on SETTLED_D, with its market figures. */
export async function settlePick(
  db: Client,
  over: { missed?: boolean; settledD?: string } = {},
): Promise<void> {
  const settledD = over.settledD ?? SETTLED_D;
  const w = (sql: string, args: (string | number | null)[] = []): Promise<unknown> =>
    db.execute({ sql, args });
  await w(
    `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
     VALUES ('AU', ?, 'balanced', 1, 'pick', 'ZZP', ?, 'waiting', ?)`,
    [D, SHA, D],
  );
  if (over.missed) {
    await w(
      `UPDATE pick_outcome SET state = 'missed', updated_d = ? WHERE d = ? AND rank = 1 AND kind = 'pick'`,
      [settledD, D],
    );
  } else {
    await w(
      `UPDATE pick_outcome SET state = 'bought', entry_d = '2026-03-05', entry_micro = 10020000, updated_d = '2026-03-05'
        WHERE d = ? AND rank = 1 AND kind = 'pick'`,
      [D],
    );
    await w(
      `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 9200000, exit_reason = 'stop', net_micro = -820000,
              net_ppm = -81000, updated_d = ? WHERE d = ? AND rank = 1 AND kind = 'pick'`,
      [settledD, settledD, D],
    );
  }
  await w(
    `INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d, index_code, basis, index_from_micro,
       index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed, settled_d)
     VALUES ('AU', ?, 'balanced', 1, 'pick', '2026-03-05', ?, 'ZZI', 'price_only', 1000000, 1012000, 12000, ?, ?, ?, ?)`,
    [
      D,
      settledD,
      over.missed ? null : -81000,
      over.missed ? null : -93000,
      over.missed ? 1 : 0,
      settledD,
    ],
  );
}

/** Two shown steelman points for the seed pick, stored the way the steelman stage stores them. */
export async function seedPoints(db: Client): Promise<string[]> {
  const packId = "b".repeat(64);
  await db.execute({
    sql: `INSERT INTO steelman_pack (pack_id, market, d, subject_kind, subject_id, code, card_id, cutoff_at, items_json, item_count, created_at)
          VALUES (?, 'AU', ?, 'pick', ?, 'ZZP', NULL, ?, '[]', 0, ?)`,
    args: [packId, D, `AU|${D}|balanced|1`, NOW, NOW],
  });
  const ids: string[] = [];
  for (const [n, side, text] of [
    [1, "bull", "The rule evidence on the card passed its check."],
    [2, "bear", "The market regime was only neutral."],
  ] as const) {
    const pointId = `${packId}:${side}:${n}`;
    ids.push(pointId);
    await db.execute({
      sql: `INSERT INTO steelman_point (point_id, pack_id, side, n, text, citations_json, monitorable, state, author_provider, author_model, created_at)
            VALUES (?, ?, ?, ?, ?, '["E01"]', 0, 'shown', 'alpha', 'alpha-model', ?)`,
      args: [pointId, packId, side, n, text, NOW],
    });
  }
  return ids;
}

/** The evidence ids in the FACTS line of a prompt. */
export function idsOf(prompt: string): string[] {
  const m = /FACTS:\n(.*)(?:\n|$)/.exec(prompt);
  if (!m) return [];
  const facts = JSON.parse(m[1]!) as { items?: { id: string }[] };
  return (facts.items ?? []).map((i) => i.id);
}

/** A valid, digit-free answer: two claims citing the first fact and the first point (when there is one). */
export function goodAnswer(req: ProviderRequest): string {
  const ids = idsOf(req.prompt);
  const point = ids.find((i) => i.startsWith("P")) ?? ids[0]!;
  return JSON.stringify({
    claims: [
      { text: "The pick was published with a buy limit, a stop and an aim.", citations: [ids[0]!] },
      {
        text: "It was closed when the stop level was reached, behind the market.",
        citations: [ids.find((i) => i === "F04") ?? ids[ids.length - 1]!, point],
      },
    ],
  });
}

export function reflectLlm(
  providers: readonly Scripted[],
  store: LlmStore = new MemoryStore(),
  mode: "mock" | "rules-only" = "mock",
): ReflectLlm {
  return {
    router: createRouter({
      mode,
      params: params.llm,
      kbVersion: "t",
      store,
      providers,
      chain: { R6: providers.map((p) => p.id) },
      now: () => new Date(RUN_NOW),
    }),
    providers,
    store,
  };
}

export function reflectOptions(
  llm: ReflectLlm,
  over: Partial<ReflectOptions> = {},
): ReflectOptions {
  return {
    market: MARKET,
    d: SETTLED_D,
    llmParams: params.llm,
    enabled: true,
    llm,
    live: { R6: true },
    now: RUN_NOW,
    ...over,
  };
}

/** Statements that change data, recorded; reads pass through. */
export function spy(db: Client): { exec: Pick<Client, "execute">; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    exec: {
      execute: ((q: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof q === "string" ? q : q.sql;
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(sql)) writes.push(sql);
        return db.execute(q as never);
      }) as Client["execute"],
    },
  };
}

export async function reflections(db: Client): Promise<Record<string, unknown>[]> {
  const r = await db.execute("SELECT * FROM pick_reflection ORDER BY d, profile, rank");
  return r.rows.map((x) => ({ ...x }));
}
