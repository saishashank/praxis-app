// "rich" scenario: the populated seed plus synthetic rows that make every V2 element render (picks of
// five families for three profiles, strategies in each state, a Decision Card with rules and breakers,
// P0/P1/P2 alerts, news with materiality, an Evening Review, corporate-action queue items). Synthetic ZZ
// codes only; sector names are generic labels. Applied once by `ensureRich()` after the server is up
// (Playwright transpiles this file; the seed .mjs files cannot import the app libraries).
import { createClient, type Client } from "@libsql/client";
import { cardIdOf, type DecisionCard } from "../../src/lib/agents/cards";
import { paramsJson, resolveCohortParams } from "../../src/lib/arena/cohort";

const SHA = "a".repeat(64);
const SECTORS = [
  "Energy",
  "Materials",
  "Industrials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Health Care",
  "Financials",
  "Information Technology",
  "Communication Services",
  "Utilities",
  "Real Estate",
];
const FAMILIES = ["F1", "F2", "F3", "F4", "F5"] as const;
const PROFILES = ["aggressive", "balanced", "conservative"] as const;

type Arg = string | number | null;
const run = (db: Client, sql: string, args: Arg[] = []) => db.execute({ sql, args });
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function card(code: string, name: string, d: string): DecisionCard {
  return {
    v: 1,
    market: "AU",
    d,
    code,
    family: "F1",
    execution: "E01",
    rule_version: "F1.v1",
    variant: "U",
    regime: "NEUTRAL",
    taken: true,
    not_taken_reason: null,
    thesis: `${name} (${code}) broke out above its 20-day high on rising volume.`,
    rules_fired: [
      { rule: "Breaks the 20-day high", value: "A$12.34", threshold: "A$12.10", pass: true },
      { rule: "Volume above average", value: "1.8x", threshold: "1.5x", pass: true },
      { rule: "Market not in shock", value: "NEUTRAL", threshold: "not SHOCK", pass: true },
    ],
    rank_score: "2.5",
    evidence: {
      events: [],
      insider_flow: "unknown",
      short_interest: "unknown",
      data_quality_flags: [],
      other_flags: [],
    },
    thesis_breakers: [
      { id: "TB-NEG", check: "The company announces a trading halt" },
      { id: "TB-GAP", check: "A fall of more than 8% in one session" },
      { id: "TB-VOL", check: "Volume dries up for five sessions" },
    ],
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
      as_of_roll_d: d,
      variant: "F1",
      rule_version: "F1.v1",
    },
    footnote: `Simulation only; ${code} data to ${d}.`,
  } as DecisionCard;
}

export async function ensureRich(): Promise<void> {
  if (process.env.E2E_SCENARIO !== "rich") return;
  const m = createClient({ url: process.env.TURSO_MAIN_URL! });
  try {
    const have = await run(m, "SELECT count(*) AS n FROM pick");
    if (Number(have.rows[0].n) > 0) return;
    await seed(m);
  } finally {
    m.close();
  }
}

async function seed(m: Client): Promise<void> {
  const last = String((await run(m, "SELECT max(d) AS d FROM price_bar")).rows[0].d);
  const days = (await run(m, "SELECT DISTINCT d FROM price_bar ORDER BY d DESC LIMIT 4")).rows
    .map((r) => String(r.d))
    .reverse();
  const D = last;
  const AT = `${D}T08:00:00.000Z`;
  const codes = (await run(m, "SELECT code, name FROM instrument ORDER BY code LIMIT 16")).rows.map(
    (r) => ({ code: String(r.code), name: String(r.name) }),
  );
  const px = async (code: string) =>
    Math.round(
      Number((await run(m, "SELECT c FROM price_bar WHERE code=? AND d=?", [code, D])).rows[0].c) *
        1e6,
    );

  // sectors (generic names) so the sector hues show on the Market tab
  for (const [i, c] of codes.entries())
    await run(m, "UPDATE instrument SET sector = ? WHERE code = ?", [
      SECTORS[i % SECTORS.length],
      c.code,
    ]);
  const rest = await run(m, "SELECT code FROM instrument WHERE sector IS NULL");
  for (const [i, r] of rest.rows.entries())
    await run(m, "UPDATE instrument SET sector = ? WHERE code = ?", [
      SECTORS[i % SECTORS.length],
      String(r.code),
    ]);

  // executions E01..E06 (one per family) and a control
  for (const [i, f] of ["F1", "F2", "F3", "F4", "F5", "F6"].entries())
    await run(
      m,
      "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES (?, 'AU','E',?, 'U','v1','P5')",
      [`E0${i + 1}`, f],
    );
  await run(
    m,
    "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('C2-F1','AU','C2','F1',NULL,'v1','P5')",
  );
  const params = paramsJson(resolveCohortParams());
  const cohort = (id: string, ex: string, start: string) =>
    run(
      m,
      `INSERT INTO cohort (id, execution_id, control_idx, start_d, seed_micro, rule_version, params_json,
         cost_profile_version, rng_seed) VALUES (?,?,${ex === "C2-F1" ? 1 : "NULL"},?,600000000,'v1',?,1,1948686321533620142)`,
      [id, ex, start, params],
    );
  const nav = (c: string, d: string, v: number, open = 0) =>
    run(
      m,
      `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
         div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
         liq_nav_micro, open_positions, invariants_ok) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?,1)`,
      [c, d, v, v, v, open],
    );
  const start = addDays(days[0], -14);
  const live: Record<string, number[]> = {
    E01: [600, 615, 640],
    E02: [590, 575, 560], // paused below A$600
    E05: [600, 598, 590], // below
    E06: [600, 650, 700], // above
  };
  for (const [ex, series] of Object.entries(live)) {
    await cohort(`${ex}@${start}`, ex, start);
    for (const [i, v] of series.entries())
      await nav(`${ex}@${start}`, days[i + 1], v * 1_000_000, ex === "E01" ? 1 : 0);
  }
  // E03 reached its goal on an earlier round; E04 was stopped (bust)
  const rounds = [
    ["E03", "target", 1_200_000_000],
    ["E04", "bust", 290_000_000],
  ] as const;
  for (const [ex, kind, out] of rounds) {
    const id = `${ex}@${addDays(start, -40)}`;
    await cohort(id, ex, addDays(start, -40));
    await run(
      m,
      "UPDATE cohort SET terminal_kind = ?, terminal_d = ?, ttd_sessions = 19, ttd_days = 27, outcome_micro = ? WHERE id = ?",
      [kind, addDays(start, -10), out, id],
    );
  }
  await cohort(`C2-F1@1`, "C2-F1", start);
  await run(
    m,
    "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('family','F2','paused',?, 'owner')",
    [AT],
  );

  // trade, signals and cards for E01
  const [up, dn] = codes;
  const E01 = `E01@${start}`;
  const upPx = await px(up.code);
  await run(
    m,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty) VALUES ('o1',?,?,?,'buy','entry',10)`,
    [E01, days[0], up.code],
  );
  await run(
    m,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
       fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro,
       bar_c_micro) VALUES ('f1','o1',?,?,?,'buy',10,'open',?,0,?,?,0,'P5',?,?,?,?)`,
    [E01, days[1], up.code, upPx, upPx, upPx * 10, upPx, upPx, upPx, upPx],
  );
  await run(m, "UPDATE arena_order SET status='filled', fill_d=? WHERE id='o1'", [days[1]]);
  await run(
    m,
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('t1',?,?,'f1',?)",
    [E01, up.code, Math.round(upPx * 0.9)],
  );
  await run(
    m,
    "INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro, haircut) VALUES (?,?,?,?,?,?,0)",
    [E01, D, up.code, 10, upPx, upPx * 10],
  );

  const SIG = (f: string, v: string, code: string) => `sig:AU:${D}:${f}:v1:${v}:${code}`;
  const sigIns = (id: string, fam: string, variant: string, code: string, score: string) =>
    run(
      m,
      `INSERT OR IGNORE INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
         evidence_json, schema_version, agent_version, inputs_ref, decided_at)
       VALUES (?,'AU',?,?,'v1',?,?,'NEUTRAL',?,'[]','{}',1,'a','r',?)`,
      [id, D, fam, variant, code, score, AT],
    );
  const sigUp = SIG("F1", "U", up.code);
  await sigIns(sigUp, "F1", "U", up.code, "2.5");
  const cardId = cardIdOf(sigUp, "E01");
  await run(
    m,
    `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, order_id, card_json, card_sha,
       schema_version, decided_at) VALUES (?,?,'E01',?,1,'o1',?,?,1,?)`,
    [cardId, sigUp, E01, JSON.stringify(card(up.code, up.name, D)), SHA, AT],
  );
  await run(
    m,
    "INSERT INTO card_note (card_id, kind, text, provider, fallback_depth) VALUES (?, 'summary', ?, NULL, 'rules-only')",
    [cardId, `${up.code} broke out on rising volume; the plan stops at A$11.00.`],
  );
  for (const [i, [id, status, v, t]] of (
    [
      ["TB-NEG", "green", "No halt notice", "a trading halt"],
      ["TB-GAP", "amber", `${up.code} fell 5%`, "a fall of more than 8%"],
      ["TB-VOL", "red", "Volume low for 5 sessions", "five quiet sessions"],
    ] as const
  ).entries())
    await run(
      m,
      `INSERT INTO thesis_breaker_eval (subject_id, breaker_id, d, phase, seq, subject_kind, card_id, market, code,
         status, value_text, trigger_text, rule_version) VALUES ('t1',?,?,'nightly',?,'trade',?,'AU',?,?,?,?,'v1')`,
      [id, D, i + 1, cardId, up.code, status, v, t],
    );
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

  // picks: three profiles x five families (one pick per family per profile, ranks 1..5)
  for (const [pi, profile] of PROFILES.entries()) {
    for (const [fi, fam] of FAMILIES.entries()) {
      const c = codes[(pi * 5 + fi) % codes.length];
      const ref = await px(c.code);
      const sid = SIG(fam, `P${pi}`, c.code);
      await sigIns(sid, fam, `P${pi}`, c.code, String(5 - fi));
      await run(
        m,
        `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, card_id, label,
           reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, aim_reach_ppm, n_similar, bad_ppm,
           typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json, pick_sha,
           created_at) VALUES ('AU',?,?,?,?,?,'U1','v1',?,NULL,?,?,?,?,?,?,?,41,-50000,12000,90000,20,100000000,10000000,'[]','[]',?,?)`,
        [
          D,
          profile,
          fi + 1,
          c.code,
          fam,
          sid,
          ["Trend follower", "Dip buyer", "Breakout", "Consensus", "Value tilt"][fi],
          ref,
          Math.round(ref * 1.01),
          addDays(D, 3),
          Math.round(ref * 0.9),
          Math.round(ref * 1.15),
          300_000 + fi * 80_000,
          `${(fi + 1).toString(16).repeat(64)}`.slice(0, 64),
          AT,
        ],
      );
    }
  }

  // news with materiality 0..3 and alerts of each tier
  const ann = [
    ["Full-year results beat expectations", "results", 1, 3, 1],
    ["Trading halt requested pending an announcement", "halt", 1, 3, 0],
    ["Appointment of a new chair", "board", 0, 1, 0],
    ["Dividend declared", "dividend", 1, 2, 1],
    ["Notice of annual general meeting", "meeting", 0, 0, 0],
  ] as const;
  for (const [i, [title, type, sens, mat, pol]] of ann.entries()) {
    const c = codes[i % 3];
    const id = `rich-${i}`;
    await run(
      m,
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
       VALUES ('AU',?,?,?,?,?,?,?,NULL,'asx')`,
      [c.code, id, AT, AT, type, sens, `${c.name}: ${title}`],
    );
    await run(
      m,
      `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity, held, watch,
         candidate, tracked, assessed_at) VALUES ('asx',?,'AU',?,?,'v1',?,?,0,0,?,?)`,
      [id, c.code, mat, pol, i === 0 ? 1 : 0, i === 0 ? 1 : 0, AT],
    );
  }
  const alerts: [string, string, string, string, number | null][] = [
    ["rich:p0", "thesis_breaker", "P0", "E01", null],
    ["rich:p1", "announcement", "P1", "E01", 3],
    ["rich:p2", "announcement", "P2", "", 1],
  ];
  for (const [key, kind, tier, ex, mat] of alerts)
    await run(
      m,
      `INSERT INTO alert (alert_key, market, code, kind, tier, execution_id, weight_ppm, materiality, published_at,
         detected_at, facts_json) VALUES (?,'AU',?,?,?,?,?,?,?,?,'{}')`,
      [key, up.code, kind, tier, ex || null, ex ? 120_000 : null, mat, AT, AT],
    );

  await run(
    m,
    `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
     VALUES (?,1,'full','{}',?,'<p>Evening review of the day.</p>','Evening review of the day.','Evening review of the day.',30,'rules',?)`,
    [D, SHA, AT],
  );
  for (const [i, kind] of ["split", "dividend"].entries()) {
    const r = await run(
      m,
      "INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json) VALUES ('AU',?,?,?,NULL,?,NULL) RETURNING id",
      [
        codes[i].code,
        kind,
        D,
        JSON.stringify(kind === "split" ? { ratio: "2:1" } : { amount: "0.10" }),
      ],
    );
    await run(
      m,
      "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (?,?,'queued','system',?)",
      [
        Number(r.rows[0].id),
        AT,
        i === 0 ? "price-only change (GL-01)" : "awaiting a second source",
      ],
    );
  }
}
