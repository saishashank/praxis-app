// Synthetic (ZZ) seed shared by the loader tests of M7 T7. Built on the real migrations, so every
// trigger of the schema is exercised; nothing here is a real code or a real price.
import type { Client } from "@libsql/client";
import { cardIdOf, type DecisionCard } from "@/lib/agents/cards";
import { paramsJson, resolveCohortParams } from "@/lib/arena/cohort";
import { findLeaks } from "@/lib/view/mask";
import type { LoaderDeps } from "@/lib/ui/loaders/common";
import { freshDb } from "../db/helpers";

export const NOW = new Date("2026-10-20T03:00:00.000Z"); // Tuesday 14:00 in Melbourne
export const LATE = new Date("2026-10-30T03:00:00.000Z"); // 11 days later: the data is stale
export const D = "2026-10-19";

export const CODES = ["ZZUP", "ZZDN", "ZZOTH"] as const;
export const NAMES = ["Zed Upward Holdings", "Zed Downward Mining", "Zed Other Group"] as const;

export const OWNER = { id: 1, role: "owner" };
export const EDITOR = { id: 2, role: "editor" };
export const VIEWER = { id: 3, role: "viewer" };

export const SIG_UP = `sig:AU:${D}:F1:v1:U:ZZUP`;
export const SIG_DN = `sig:AU:${D}:F1:v1:U:ZZDN`;
export const SIG_OTH = `sig:AU:${D}:F2:v1:L:ZZOTH`;
export const CARD_UP = cardIdOf(SIG_UP, "E01");
export const CARD_DN = cardIdOf(SIG_DN, "E01");
export const COHORT_E01 = "E01@2026-10-12";
export const COHORT_E02 = "E02@2026-10-12";

const SHA = "a".repeat(64);
const AT = "2026-10-19T08:00:00.000Z";

export type Both = { main: Client; auth: Client };

export async function emptyDbs(): Promise<Both> {
  return { main: await freshDb("main"), auth: await freshDb("auth") };
}

export function deps(db: Both, user: { id: number; role: string } | null, now = NOW): LoaderDeps {
  return { mainDb: db.main, authDb: db.auth, user, now };
}

/** Counts the queries a loader sends. */
export function counting(db: Both): { db: Both; count: () => number } {
  let n = 0;
  const wrap = new Proxy(db.main, {
    get(target, prop, recv) {
      if (prop === "execute") {
        return (...a: Parameters<Client["execute"]>) => {
          n += 1;
          return target.execute(...a);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: { main: wrap as Client, auth: db.auth }, count: () => n };
}

function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    market: "AU",
    d: D,
    code: "ZZUP",
    family: "F1",
    execution: "E01",
    rule_version: "F1.v1",
    variant: "U",
    regime: "NEUTRAL",
    taken: true,
    not_taken_reason: null,
    thesis: "Zed Upward Holdings (ZZUP) broke out at A$12.34 on 2026-10-16.",
    rules_fired: [{ rule: "R1 vs ZZDN", value: "A$3.20", threshold: "$2", pass: true }],
    rank_score: "1",
    evidence: {
      events: [],
      insider_flow: "unknown",
      short_interest: "unknown",
      data_quality_flags: [],
      other_flags: [],
    },
    thesis_breakers: [{ id: "TB-NEG", check: "ZZOTH announces a halt" }],
    exit_plan: [{ rule: "stop at A$11.00", tag: "IS", via: null, kind: "stop", detail: {} }],
    sizing: {
      available: true,
      accepted: true,
      reasons: [],
      qty: "10",
      fill_price_micro: "12340000",
      order_value_micro: "123400000",
      half_size: false,
    },
    cost: {
      available: true,
      reason: null,
      entry_brokerage_micro: "9500000",
      entry_slippage_micro: "0",
      exit_brokerage_micro: "9500000",
      exit_slippage_micro: "0",
      cost_estimate_micro: "19000000",
      order_value_micro: "123400000",
      break_even_ppm: 15_400,
    },
    scenario: {
      insufficient_history: false,
      n: 41,
      reason: null,
      p10_ppm: -50_000,
      p50_ppm: 12_000,
      p90_ppm: 90_000,
      split_version: 1,
      as_of_roll_d: "2026-10-16",
      variant: "F1",
      rule_version: "F1.v1",
    },
    footnote: "Simulation only; ZZUP data to 2026-10-16.",
    ...over,
  } as DecisionCard;
}

async function run(db: Client, sql: string, args: Array<string | number | null> = []) {
  await db.execute({ sql, args });
}

async function nav(db: Client, cohort: string, d: string, liq: number, open = 0) {
  await run(
    db,
    `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
       div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
       liq_nav_micro, open_positions, invariants_ok) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?,1)`,
    [cohort, d, liq, liq, liq, open],
  );
}

/** Two live strategies with positions, trades, signals, cards, a pick, news, a review and controls. */
export async function seedPopulated(db: Both): Promise<void> {
  const m = db.main;
  const params = paramsJson(resolveCohortParams());
  for (const [i, code] of CODES.entries()) {
    await run(
      m,
      "INSERT INTO instrument (market, code, name, sector) VALUES ('AU', ?, ?, 'Materials')",
      [code, NAMES[i]!],
    );
  }
  await run(
    m,
    "INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES ('AU', ?, 'data', ?, NULL, 'ok')",
    [D, AT],
  );
  await run(
    m,
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E01','AU','E','F1','U','v1','P5')",
  );
  await run(
    m,
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E02','AU','E','F2','U','v1','P5')",
  );
  // D-191: an L twin (leverage sleeve) is in the registry but runs no cohort and is listed nowhere;
  // its own page still reads the hypothetical sleeve figures
  await run(
    m,
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E04','AU','E','F2','L','v1','P5')",
  );
  await run(
    m,
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('C2-F1','AU','C2','F1',NULL,'v1','P5')",
  );

  const cohort = async (id: string, ex: string, start: string) => {
    await run(
      m,
      `INSERT INTO cohort (id, execution_id, control_idx, start_d, seed_micro, rule_version, params_json,
         cost_profile_version, rng_seed) VALUES (?,?,${ex === "C2-F1" ? 1 : "NULL"},?,600000000,'v1',?,1,1948686321533620142)`,
      [id, ex, start, params],
    );
  };
  // E02 had a first round that busted, then the live round.
  await cohort("E02@2026-09-01", "E02", "2026-09-01");
  await run(
    m,
    "UPDATE cohort SET terminal_kind = 'bust', terminal_d = '2026-09-20', ttd_sessions = 13, ttd_days = 19, outcome_micro = 290000000 WHERE id = 'E02@2026-09-01'",
  );
  await cohort(COHORT_E01, "E01", "2026-10-12");
  await cohort(COHORT_E02, "E02", "2026-10-12");
  await cohort("C2-F1@1", "C2-F1", "2026-10-12");

  // Navs: E01 grows, E02 sits just above the bust level (300 A$M of 600).
  for (const [d, v] of [
    ["2026-10-15", 600_000_000],
    ["2026-10-16", 610_000_000],
    [D, 630_000_000],
  ] as const) {
    await nav(m, COHORT_E01, d, v, d === D ? 1 : 0);
  }
  for (const [d, v] of [
    ["2026-10-15", 320_000_000],
    ["2026-10-16", 315_000_000],
    [D, 310_000_000],
  ] as const) {
    await nav(m, COHORT_E02, d, v);
  }
  await run(
    m,
    "INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro, haircut) VALUES (?,?,?,?,?,?,0)",
    [COHORT_E01, D, "ZZUP", 10, 12_340_000, 123_400_000],
  );

  // Orders, fills and trades of E01: ZZUP is open, ZZDN is closed.
  const order = (id: string, d: string, code: string, side: string, kind: string, qty: number) =>
    run(
      m,
      `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty) VALUES (?,?,?,?,?,?,?)`,
      [id, COHORT_E01, d, code, side, kind, qty],
    );
  const fill = (
    id: string,
    o: string,
    d: string,
    code: string,
    side: string,
    qty: number,
    price: number,
  ) =>
    run(
      m,
      `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
         fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro,
         bar_c_micro) VALUES (?,?,?,?,?,?,?,'open',?,0,?,?,0,'P5',?,?,?,?)`,
      [
        id,
        o,
        COHORT_E01,
        d,
        code,
        side,
        qty,
        price,
        price,
        price * qty,
        price,
        price,
        price,
        price,
      ],
    );
  const filled = (id: string, d: string) =>
    run(m, "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?", [d, id]);
  await order("o1", "2026-10-14", "ZZUP", "buy", "entry", 10);
  await fill("f1", "o1", "2026-10-15", "ZZUP", "buy", 10, 12_000_000);
  await filled("o1", "2026-10-15");
  await run(
    m,
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('t1',?,?,'f1',11000000)",
    [COHORT_E01, "ZZUP"],
  );
  await run(
    m,
    "INSERT INTO stop_level (trade_id, d, rule, cohort_id, level_micro) VALUES ('t1',?,'trail',?,11500000)",
    [D, COHORT_E01],
  );
  await order("o2", "2026-10-14", "ZZDN", "buy", "entry", 5);
  await fill("f2", "o2", "2026-10-15", "ZZDN", "buy", 5, 10_000_000);
  await filled("o2", "2026-10-15");
  await run(
    m,
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('t2',?,?,'f2',9000000)",
    [COHORT_E01, "ZZDN"],
  );
  await order("o3", "2026-10-16", "ZZDN", "sell", "exit_is", 5);
  await fill("f3", "o3", "2026-10-16", "ZZDN", "sell", 5, 11_000_000);
  await filled("o3", "2026-10-16");
  await run(m, "UPDATE trade SET exit_fill_id = 'f3', exit_type = 'IS' WHERE id = 't2'");

  // Signals and cards.
  for (const [id, fam, variant, code, score] of [
    [SIG_UP, "F1", "U", "ZZUP", "2.5"],
    [SIG_DN, "F1", "U", "ZZDN", "1.5"],
    [SIG_OTH, "F2", "L", "ZZOTH", "9"],
  ] as const) {
    await run(
      m,
      `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
         evidence_json, schema_version, agent_version, inputs_ref, decided_at)
       VALUES (?,'AU',?,?,'v1',?,?,'NEUTRAL',?,'[]','{}',1,'a','r',?)`,
      [id, D, fam, variant, code, score, AT],
    );
  }
  await run(
    m,
    `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, order_id, card_json, card_sha,
       schema_version, decided_at) VALUES (?,?,'E01',?,1,'o1',?,?,1,?)`,
    [CARD_UP, SIG_UP, COHORT_E01, JSON.stringify(card()), SHA, AT],
  );
  await run(
    m,
    `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, not_taken_reason, card_json,
       card_sha, schema_version, decided_at) VALUES (?,?,'E01',?,0,?,?,?,1,?)`,
    [
      CARD_DN,
      SIG_DN,
      COHORT_E01,
      "ZZOTH is held; see https://x.example.test/a",
      JSON.stringify(card({ code: "ZZDN", taken: false, not_taken_reason: "ZZOTH is held" })),
      SHA,
      AT,
    ],
  );
  await run(
    m,
    "INSERT INTO card_note (card_id, kind, text, provider, fallback_depth) VALUES (?, 'summary', ?, NULL, 'rules-only')",
    [CARD_UP, "ZZUP looks strong at $12.34."],
  );
  await run(
    m,
    `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind, card_id, market, code,
       status, value_text, trigger_text, rule_version) VALUES ('t1','TB-NEG',?,'nightly',1,'trade',?,'AU','ZZUP',
       'red','ZZUP fell 12%','a fall of $2 in ZZUP','v1')`,
    [D, CARD_UP],
  );

  // Market state, quality, label, controls, shocks, re-cost rows.
  await run(
    m,
    "INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state) VALUES ('AU',?,1,7000000000,'NEUTRAL','NEUTRAL')",
    [D],
  );
  await run(
    m,
    "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES ('AU',?,'U1',10,10,1.0,1)",
    [D],
  );
  await run(
    m,
    "INSERT INTO label (id, execution_id, rule_version, variant, label, n, d) VALUES ('l1','E01','v1','U','UNVALIDATED',0,?)",
    [D],
  );
  await run(
    m,
    "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('family','F2','paused',?, 'owner')",
    [AT],
  );
  await run(
    m,
    "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('r1', ?, 'shock:-10', ?, ?)",
    [
      `shock:${COHORT_E01}`,
      D,
      JSON.stringify({
        pct: -10,
        pnl_micro: "-12340000",
        value_micro: "111060000",
        nav_after_micro: "617660000",
        positions: 1,
      }),
    ],
  );
  await run(
    m,
    "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('r1', ?, 'recost:P3', ?, ?)",
    [
      `cost:${COHORT_E01}`,
      D,
      JSON.stringify({
        nav_micro: "629000000",
        liq_nav_micro: "628000000",
        fees_micro: "1",
        stored_nav_micro: "630000000",
        fills: 3,
      }),
    ],
  );

  // A pick, news and a review.
  await run(
    m,
    `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, card_id, label,
       reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, aim_reach_ppm, n_similar, bad_ppm,
       typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json, pick_sha,
       created_at) VALUES ('AU',?,'balanced',1,'ZZUP','F1','U1','v1',?,?,'Trend follower',12340000,12400000,
       '2026-10-23',11000000,14000000,300000,41,-50000,12000,90000,20,100000000,10000000,'[]','[]',?,?)`,
    [D, SIG_UP, CARD_UP, SHA, AT],
  );
  await run(
    m,
    `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
     VALUES ('AU','ZZUP','a1',?,?,'results',1,'Zed Upward Holdings full-year results beat','https://x.example.test/a','asx')`,
    [AT, AT],
  );
  await run(
    m,
    `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
     VALUES (?,1,'full','{}',?,'h','t','m',1,'rules',?)`,
    [D, SHA, AT],
  );

  // People: the Owner, an Editor and a Viewer; the Editor and the Owner watch ZZUP.
  const a = db.auth;
  for (const [id, email, role] of [
    [1, "o@example.test", "owner"],
    [2, "e@example.test", "editor"],
    [3, "v@example.test", "viewer"],
  ] as const) {
    await run(
      a,
      "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)",
      [id, email, role, AT, AT],
    );
  }
  for (const id of [1, 2]) {
    await run(
      a,
      "INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES (?, 'AU', 'ZZUP', ?)",
      [id, AT],
    );
  }
  for (const [d, c] of [
    ["2026-10-16", 12.1],
    [D, 12.34],
  ] as const) {
    await run(
      m,
      "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) VALUES ('AU','ZZUP',?,?,?,?,?,1000,'t',?,?)",
      [d, c, c, c, c, AT, AT],
    );
  }
}

/** Fails when a code, company name, signal or card id of the seed appears anywhere in `value`. */
export function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  const extra = ["sig:AU", "card:sig", "x.example.test"].filter((s) => text.includes(s));
  return [...findLeaks(value, CODES, NAMES), ...extra];
}
