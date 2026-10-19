// Test support for the M5 acceptance suites (T15). Synthetic ZZ* data only. A held position in a live
// E execution and the announcement + assessment rows the Sentinel ingest would have written, so the
// alert path (tiers, P0 delivery, caps) can be driven through the real code with the mock provider.
import type { Client } from "@libsql/client";
import type { AlertCtx } from "@/lib/alerts/deliver";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { freshDb } from "../../db/helpers";

export const T0 = new Date("2026-10-19T09:00:00.000Z"); // Mon 20:00 Melbourne (AEDT)
export const MIN = 60_000;
export const OWNER = "owner@example.test";
export const APP = "https://praxis.example.test";
export const SRC = "asx_announcements";
export const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

export type World = {
  db: Client;
  mock: MockProvider;
  clock: Date;
  n: number;
  ctx(): AlertCtx;
  at(min: number): Date;
  run(sql: string, args?: (string | number | null)[]): Promise<unknown>;
  rows(sql: string, args?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
};

export async function setMode(db: Client, mode: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });
}

export async function alertWorld(): Promise<World> {
  const db = await freshDb("main");
  const w: World = {
    db,
    mock: createMockProvider(),
    clock: new Date(T0),
    n: 0,
    ctx: () => ({
      db,
      env: ENV,
      now: () => w.clock,
      provider: w.mock,
      sleep: async () => {},
    }),
    at: (min) => new Date(T0.getTime() + min * MIN),
    run: (sql, args = []) => db.execute({ sql, args }),
    rows: async (sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r })),
  };
  await w.run("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await setMode(db, "full");
  await seedHolder(w, {
    code: "ZZAA",
    exec: "E01",
    valueMicro: 120_000_000,
    navMicro: 1_000_000_000,
  });
  return w;
}

/** A held position: execution, live cohort, filled buy, open trade and the NAV snapshot (12 % here). */
export async function seedHolder(
  w: World,
  o: { code: string; exec: string; kind?: "E" | "C1"; valueMicro: number; navMicro: number },
): Promise<void> {
  const kind = o.kind ?? "E";
  await w.run(
    `INSERT OR IGNORE INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES (?, 'AU', ?, ?, ?, 'T1', 'rv1', 'P5')`,
    [o.exec, kind, kind === "E" ? "F1" : null, kind === "E" ? "U" : null],
  );
  const cid = `K${o.exec}${o.code}`;
  await w.run(
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json,
       cost_profile_version, rng_seed, live) VALUES (?, ?, '2026-10-12', 600000000, 'rv1', '{}', 1, 42, 1)`,
    [cid, o.exec],
  );
  await w.run(
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, '2026-10-12', ?, 'buy', 'entry', 10, 'pending')`,
    [`O${cid}`, cid, o.code],
  );
  await w.run(
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro,
       slip_micro, fill_price_micro, value_micro, brokerage_micro, cost_profile,
       bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES (?, ?, ?, '2026-10-13', ?, 'buy', 10, 'open', 1000000, 5000, 1005000, 10050000,
       30000000, 'P5', 1000000, 1100000, 900000, 1050000)`,
    [`F${cid}`, `O${cid}`, cid, o.code],
  );
  await w.run("UPDATE arena_order SET status = 'filled', fill_d = '2026-10-13' WHERE id = ?", [
    `O${cid}`,
  ]);
  await w.run(
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?, ?, ?, ?, 900000)",
    [`T${cid}`, cid, o.code, `F${cid}`],
  );
  await w.run(
    `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
       div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
       liq_nav_micro, open_positions, invariants_ok) VALUES (?, '2026-10-16', 0,0,0,?,0,0,0,0,?,?,1,1)`,
    [cid, o.valueMicro, o.navMicro, o.navMicro],
  );
  await w.run(
    `INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro)
     VALUES (?, '2026-10-16', ?, 10, 1000000, ?)`,
    [cid, o.code, o.valueMicro],
  );
}

export type Ann = {
  code?: string;
  title?: string;
  type?: string | null;
  materiality?: 0 | 1 | 2 | 3;
  held?: boolean;
  watch?: boolean;
};

/** An announcement and its assessment, as the Sentinel ingest would have written them. Returns the alert key. */
export async function seedAnn(w: World, o: Ann = {}): Promise<string> {
  const annId = `a${++w.n}`;
  const t = w.clock.toISOString();
  await w.run(
    `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
     VALUES ('AU', ?, ?, ?, ?, ?, 0, ?, 'https://example.test/doc.pdf', ?)`,
    [
      o.code ?? "ZZAA",
      annId,
      t,
      t,
      o.type === undefined ? "Trading Halt" : o.type,
      o.title ?? "Trading halt pending an announcement",
      SRC,
    ],
  );
  await w.run(
    `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity,
       held, watch, candidate, tracked, assessed_at) VALUES (?, ?, 'AU', ?, ?, 'materiality-v1', 0, ?, ?, ?, 1, ?)`,
    [
      SRC,
      annId,
      o.code ?? "ZZAA",
      o.materiality ?? 3,
      o.held === false ? 0 : 1,
      o.watch ? 1 : 0,
      o.watch ? 1 : 0,
      t,
    ],
  );
  return `ann:AU:${SRC}:${annId}`;
}
