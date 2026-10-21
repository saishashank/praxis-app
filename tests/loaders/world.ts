// A small synthetic world for the M7 T8 loader and route tests (synthetic ZZ codes only). Today is
// Monday 2026-10-20 in Melbourne; the latest bars, signals, picks, news and review are of 2026-10-19.
// Active set of 2026-10-19 (signals): ZZDN, ZZUP. ZZOTH is NOT in it (an announcement and a pick only).
import type { Client } from "@libsql/client";
import { addUser } from "../auth/helpers";
import { freshDb } from "../db/helpers";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { CREDENTIAL_NAMES } from "@/lib/sentinel/schema";
import { maskContext } from "@/lib/view/mask";

export const NOW = new Date("2026-10-20T03:00:00.000Z");
export const D = "2026-10-19";
export const CODES = ["ZZUP", "ZZDN", "ZZOTH"];
export const NAMES = ["Zed Upward Holdings", "Zed Downward Mining", "Zed Other Group"];
export const SHA = "a".repeat(64);

export type World = {
  main: Client;
  auth: Client;
  ids: { owner: number; editor: number; viewer: number; granted: number };
  annIds: { up: number; oth: number };
};

const run = (db: Client, sql: string, args: Array<string | number | null> = []) =>
  db.execute({ sql, args });

export async function emptyWorld(): Promise<World> {
  const main = await freshDb("main");
  const auth = await freshDb("auth");
  const ids = {
    owner: await addUser(auth, { email: "owner@example.test", role: "owner" }),
    editor: await addUser(auth, { email: "editor@example.test", role: "editor" }),
    viewer: await addUser(auth, { email: "viewer@example.test", role: "viewer" }),
    granted: await addUser(auth, { email: "granted@example.test", role: "viewer" }),
  };
  await run(
    auth,
    `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at)
     VALUES (?, ?, '2026-10-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')`,
    [ids.granted, ids.owner],
  );
  return { main, auth, ids, annIds: { up: 0, oth: 0 } };
}

export async function fullWorld(): Promise<World> {
  const w = await emptyWorld();
  const { main } = w;
  await run(
    main,
    `INSERT INTO instrument (market, code, name, sector) VALUES
       ('AU','ZZUP','Zed Upward Holdings','Technology'),
       ('AU','ZZDN','Zed Downward Mining','Materials'),
       ('AU','ZZOTH','Zed Other Group',NULL)`,
  );
  const bar = (code: string, d: string, c: number, v: number) =>
    run(
      main,
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      [code, d, c, c, c, c, v, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    );
  await bar("ZZUP", "2026-10-16", 10, 1000);
  await bar("ZZUP", D, 10.5, 1200);
  await bar("ZZDN", "2026-10-16", 5, 800);
  await bar("ZZDN", D, 4.5, 900);
  await bar("ZZOTH", "2026-10-16", 2, 500);
  await bar("ZZOTH", D, 2.2, 600);
  for (const [id, code] of [
    ["s1", "ZZUP"],
    ["s2", "ZZDN"],
  ] as const) {
    await run(
      main,
      `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
         evidence_json, schema_version, agent_version, inputs_ref, decided_at)
       VALUES (?, 'AU', ?, 'F1', 'F1.v1', 'F1', ?, 'NEUTRAL', '1', '[]', '{}', 1, 'a1', 'x', ?)`,
      [id, D, code, `${D}T08:00:00.000Z`],
    );
  }
  // Picks (balanced): rank 1 ZZUP (closed win), rank 2 ZZOTH (waiting).
  const pick = (rank: number, code: string) =>
    run(
      main,
      `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
         reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
         typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
         pick_sha, created_at)
       VALUES ('AU', ?, 'balanced', ?, ?, 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', 10000000, 10050000,
         '2026-10-23', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, ?, ?, ?, ?)`,
      [
        D,
        rank,
        code,
        JSON.stringify([
          {
            factor: `Volume of ${code}`,
            value: "high",
            bucket: 3,
            n: 40,
            effectPpm: 12000,
            enough: true,
          },
        ]),
        JSON.stringify([`${code} broke out at A$12.34 on 2026-10-16`]),
        SHA,
        `${D}T07:00:00.000Z`,
      ],
    );
  await pick(1, "ZZUP");
  await pick(2, "ZZOTH");
  await run(
    main,
    `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
     VALUES ('AU', ?, 'balanced', 1, 'pick', 'ZZUP', ?, 'waiting', ?)`,
    [D, SHA, D],
  );
  await run(
    main,
    `UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = 10000000, updated_d = ?
     WHERE market = 'AU' AND d = ? AND profile = 'balanced' AND rank = 1 AND kind = 'pick'`,
    [D, D, D],
  );
  await run(
    main,
    `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 10500000, exit_reason = 'aim',
       net_micro = 50000, net_ppm = 50000, updated_d = ?
     WHERE market = 'AU' AND d = ? AND profile = 'balanced' AND rank = 1 AND kind = 'pick'`,
    [D, D, D],
  );
  // News: one item for ZZUP (active, held) and one for ZZOTH (not active).
  const ann = async (code: string, annId: string, title: string, held: number) => {
    const r = await run(
      main,
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
       VALUES ('AU', ?, ?, ?, ?, 'Results', 1, ?, 'https://news.example.test/doc.pdf', 'src')`,
      [code, annId, `${D}T02:00:00.000Z`, `${D}T02:01:00.000Z`, title],
    );
    await run(
      main,
      `INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity,
         held, watch, candidate, tracked, assessed_at) VALUES ('src', ?, 'AU', ?, 3, 'materiality-v1', 1, ?, 0, 0, 1, ?)`,
      [annId, code, held, `${D}T02:02:00.000Z`],
    );
    return Number(r.lastInsertRowid);
  };
  w.annIds.up = await ann("ZZUP", "n1", "Zed Upward Holdings (ZZUP) full-year result A$12.34", 1);
  w.annIds.oth = await ann("ZZOTH", "n2", "Zed Other Group (ZZOTH) trading halt", 0);
  await run(
    main,
    `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json)
     VALUES ('ann:AU:src:n1', 'AU', 'ZZUP', 'announcement', 'P1', ?, '{"rule":"r","why":"ZZDN is held","executions":[]}')`,
    [`${D}T02:03:00.000Z`],
  );
  // Evening review of the day.
  const facts = {
    orders: [
      {
        code: "ZZUP",
        side: "buy",
        qty: 100,
        state: "filled",
        executionId: "E01",
        reason: "ZZUP broke out at $12.34",
      },
    ],
    narrative: { kind: "rules", s4: ["ZZDN fell on 2026-10-19"], s5: [], s6: [] },
    alerts: [],
    health: [],
    executions: [],
  };
  await run(
    main,
    `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
     VALUES (?, 1, 'full', ?, ?, '<p>ZZUP bought at A$12.34 https://a.example.test</p>', 't', 'm', 10, 'rules', ?)`,
    [D, JSON.stringify(facts), SHA, `${D}T09:00:00.000Z`],
  );
  // Knowledge: a document, a plan item, a lesson.
  await run(
    main,
    `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
     VALUES ('knowledge/lessons/L-ZZUP.md', 1, 'AU', 'lesson', '{"title":"Lesson about ZZUP"}', 'ZZUP body', ?, ?, ?)`,
    [SHA, D, `${D}T09:00:00.000Z`],
  );
  await run(
    main,
    `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
     VALUES ('AU', ?, 1, 'data_weakness', 'no-lesson:data_weakness ZZUP feed was late', NULL, 'ops', '{"metric":"flags"}')`,
    [D],
  );
  await run(
    main,
    `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json, rule_version,
       metric, direction, created_d, created_run)
     VALUES ('L-1', 'AU', 'market', NULL, 'breakout', 1, '{}', 'F1.v1', 'net_ppm', 1, ?, 'run1')`,
    [D],
  );
  // An expired credential gives the Control Room one item with a fix line.
  await run(
    main,
    "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, '2026-10-01', '2026-09-01T00:00:00.000Z', 1)",
    [Object.keys(CREDENTIAL_NAMES)[0]!],
  );
  await run(
    main,
    `INSERT INTO llm_call (id, role, provider, fallback_depth, tokens_in, tokens_out, cached, outcome, market, d)
     VALUES ('c1', 'narrator', 'mock', '0', 10, 20, 0, 'ok', 'AU', ?)`,
    [D],
  );
  return w;
}

export type Who = "owner" | "editor" | "viewer" | "granted";

/** The loader environment of a user (the same mask rule as maskContext). */
export function envOf(w: World, who: Who, now: Date = NOW): LoaderEnv {
  const role = who === "granted" ? "viewer" : who;
  return {
    main: w.main,
    auth: w.auth,
    user: { id: w.ids[who], role },
    mask: maskContext({ id: w.ids[who], role }, who === "granted"),
    now,
  };
}
