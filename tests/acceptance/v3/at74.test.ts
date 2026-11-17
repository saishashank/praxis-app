// @vitest-environment node
// AT-74 (M23 M1, D-1614 to D-1618; PRD-033): the residual-risk monitors 1 to 4 on a seeded database. The night step
// writes one row per monitor and period, raises a plain-words Owner item per alarm at the thresholds, is idempotent,
// and writes nothing but `residual_monitor` and `app_log`; a static scan proves no monitor module can write a book, a
// rule, a ranking or a card, and that nothing that decides imports the monitors. Task M2 extends this file with
// monitors 5 to 8. Synthetic ZZ data only (SEC-110).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { runResearchNight } from "@/lib/research/night";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);

const ROOT = join(__dirname, "..", "..", "..");
const NOW = "2030-04-02T08:00:00Z";
const NIGHT = "2030-04-02";
const TS = "2030-01-01T00:00:00Z";

async function run(
  db: Client,
  sql: string,
  args: Array<string | number | null> = [],
): Promise<void> {
  await db.execute({ sql, args });
}

function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const bench = async (db: Client): Promise<string> => {
  const r = await db.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code LIMIT 1");
  return String(r.rows[0]!.code);
};

/** The seeded world: one finished quarter (2030-Q1), every input the four monitors read. */
async function seed(db: Client, o: { smallNet: number; largeNet: number }): Promise<string> {
  const market = await bench(db);
  const days = weekdays("2029-11-01", "2030-03-29");
  const { staticProfile } = await import("@/lib/market/staticProfile.mjs");
  const index = staticProfile(market).benchmarkIndex as string;
  for (const d of days) {
    await run(
      db,
      "INSERT OR IGNORE INTO trading_calendar (market, d, kind, confirmed, source) VALUES (?, ?, 'session', 1, 'test')",
      [market, d],
    );
    await run(
      db,
      "INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at) VALUES (?, ?, ?, 1000, 1000, 1000, 1000000, 'test', ?, ?)",
      [market, index, d, TS, TS],
    );
  }
  // monitor 1, flags: three flagged codes; the 20th session after 2030-01-02 falls inside the quarter
  const flagD = "2030-01-02";
  const readD = days[days.indexOf(flagD) + 20]!;
  for (const [code, c1] of [
    ["ZA", 90],
    ["ZB", 100],
    ["ZC", 120],
  ] as const) {
    await run(
      db,
      "INSERT INTO cortex_state (market, code, kind, from_d, state, basis_json) VALUES (?, ?, 'promotion', ?, 'flagged', '{}')",
      [market, code, flagD],
    );
    for (const [d, c] of [
      [flagD, 100],
      [readD, c1],
    ] as const) {
      await run(
        db,
        "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 'test', ?, ?)",
        [market, code, d, c, c, c, c, TS, TS],
      );
    }
  }
  // monitor 1, entries: 20 smaller-company and 20 large-company event entries that closed in the quarter
  const sess = days.filter((d) => d >= "2030-01-02" && d <= "2030-03-22");
  for (let i = 0; i < 40; i += 1) {
    const small = i < 20;
    const d = sess[i]!;
    const code = `${small ? "ZS" : "ZL"}${i}`;
    const exitD = sess[i + 5]!;
    await run(
      db,
      "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES (?, ?, ?, 'active', ?)",
      [market, d, code, small ? "U2" : "U1"],
    );
    await run(
      db,
      "INSERT INTO cortex_decision (market, d, book_id, code, arm, family, qty, gate_trace_json, manifest_id) VALUES (?, ?, 'B1', ?, 'live', 'F3', 100, '[]', 'm1')",
      [market, d, code],
    );
    // fill 1,000,000 micro a share x 100 shares = 100,000,000 micro; the net is a fixed share of that
    const net = small ? o.smallNet : o.largeNet;
    await run(
      db,
      "INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, fill_micro, fill_d, exit_d, exit_rule, gross_micro, net_micro, outcome_class, scored_at) VALUES (?, ?, 'B1', ?, 'live', 'filled', 1000000, ?, ?, 'close_signal', ?, ?, 'win', ?)",
      [market, d, code, d, exitD, net, net, TS],
    );
  }
  // monitor 3 and 2: family evidence (slope bound and the sample size with its minimum detectable effect)
  const fams: Array<[string, number | null]> = [
    ["F1", 0.69],
    ["F2", 0.7],
    ["F3", 0.71],
    ["F4", null],
  ];
  for (const [f, ub] of fams) {
    await run(
      db,
      "INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by) VALUES (?, ?, '2030-02-01', 'shadow', ?, 'evaluator')",
      [market, f, JSON.stringify({ n_eff: 300, mde: 0.1, slope_ub90: ub })],
    );
  }
  await run(
    db,
    "INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash, n_eff, pool, fit_split) VALUES (?, 'F1', 'F1.v1', '2030-01-15T00:00:00Z', '{}', 'h', 300, 'p', 's')",
    [market],
  );
  // monitor 4: a live position held through an unconfirmed corporate action that closed on a stop
  await run(
    db,
    "INSERT INTO cortex_state (market, code, kind, from_d, state, basis_json) VALUES (?, 'ZX', 'corp_action', '2030-02-01', 'candidate', '{}')",
    [market],
  );
  await run(
    db,
    "INSERT INTO cortex_state (market, code, kind, from_d, state, basis_json) VALUES (?, 'ZX', 'corp_action', '2030-02-20', 'none', '{}')",
    [market],
  );
  await run(
    db,
    "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES (?, '2030-01-15', 'ZX', 'active', 'U1')",
    [market],
  );
  await run(
    db,
    "INSERT INTO cortex_decision (market, d, book_id, code, arm, family, qty, gate_trace_json, manifest_id) VALUES (?, '2030-01-15', 'B1', 'ZX', 'live', 'F1', 100, '[]', 'm1')",
    [market],
  );
  await run(
    db,
    "INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, fill_micro, fill_d, exit_d, exit_rule, gross_micro, net_micro, outcome_class, scored_at) VALUES (?, '2030-01-15', 'B1', 'ZX', 'live', 'filled', 1000000, '2030-01-16', '2030-02-10', 'level', -1, -1, 'loss', ?)",
    [market, TS],
  );
  return market;
}

type Mon = { monitor: number; period: string; alarm: number; value: Record<string, unknown> };
async function monitors(db: Client): Promise<Mon[]> {
  const r = await db.execute(
    "SELECT monitor, period, alarm, value_json FROM residual_monitor ORDER BY monitor, period",
  );
  return r.rows.map((x) => ({
    monitor: Number(x.monitor),
    period: String(x.period),
    alarm: Number(x.alarm),
    value: JSON.parse(String(x.value_json)) as Record<string, unknown>,
  }));
}
async function ownerLines(db: Client): Promise<string[]> {
  const r = await db.execute(
    "SELECT message FROM app_log WHERE message LIKE 'owner item:%' ORDER BY id",
  );
  return r.rows.map((x) => String(x.message));
}

describe("AT-74: monitors 1 to 4 on a seeded quarter", () => {
  it("writes one row per monitor, raises the alarms at their thresholds, and the Owner lines are plain words", async () => {
    const db = await freshDb("main");
    const market = await seed(db, { smallNet: -10_000_000, largeNet: 5_000_000 });
    const res = await runResearchNight(db, { market, d: NIGHT, now: NOW }, [
      (await import("@/lib/research/steps/monitors")).monitorsStep,
    ]);
    expect(res.failed).toEqual([]);
    const rows = await monitors(db);
    expect(rows.map((r) => [r.monitor, r.period])).toEqual([
      [1, "2030-Q1"],
      [2, "cal-2030-01-15"],
      [3, "2030-Q1"],
      [4, "2030-Q1"],
    ]);
    // monitor 1: 3 matured flags, the one at 90 (-10 %) beats the index and loses, 100 and 120 do not; the gap is -150,000 ppm
    expect(rows[0]!.value).toMatchObject({
      flags: { matured: 3, hits: 1 },
      entries: {
        smaller_n: 20,
        large_n: 20,
        smaller_mean_ppm: -100000,
        large_mean_ppm: 50000,
        diff_ppm: -150000,
        lower90_ppm: -150000,
      },
    });
    expect(rows.map((r) => r.alarm)).toEqual([1, 0, 1, 1]);
    // monitor 2: published pass rates for the families that carry a sample size and an effect size; no alarm
    const m2 = rows[1]!.value as { families: Array<{ family: string }> };
    expect(m2.families.map((f) => f.family)).toEqual(["F1", "F2", "F3", "F4"]);
    // monitor 3: only the family at 0.69 alarms (0.70 exactly, 0.71 and an undefined bound do not)
    const m3 = rows[2]!.value as { families: Array<{ family: string; alarm: boolean }> };
    expect(m3.families.filter((f) => f.alarm).map((f) => f.family)).toEqual(["F1"]);
    // monitor 4: one position held through the unconfirmed window, closed on its stop
    expect(rows[3]!.value).toEqual({ held_through_unconfirmed: 1, closed_on_stop: 1 });
    const lines = await ownerLines(db);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "owner item: Event entries in smaller companies are losing against large companies: review moving them to shadow",
    );
    expect(lines[1]).toBe("owner item: Confidence figures are over-stated for Breakout");
    expect(lines[2]).toMatch(/^owner item: 1 position closed on a stop/);
    for (const l of lines) expect(l).not.toMatch(/\b(F\d|U[123]|CXA|D-\d|AT-\d|monitor)\b/);
  });

  it("is written once: a second night adds no row and no line", async () => {
    const db = await freshDb("main");
    const market = await seed(db, { smallNet: -10_000_000, largeNet: 5_000_000 });
    const { monitorsStep } = await import("@/lib/research/steps/monitors");
    await runResearchNight(db, { market, d: NIGHT, now: NOW }, [monitorsStep]);
    const before = [(await monitors(db)).length, (await ownerLines(db)).length];
    await runResearchNight(db, { market, d: "2030-04-03", now: "2030-04-03T08:00:00Z" }, [
      monitorsStep,
    ]);
    expect([(await monitors(db)).length, (await ownerLines(db)).length]).toEqual(before);
  });

  it("smaller companies ahead of large ones: no event-entry alarm, and no Owner line for it", async () => {
    const db = await freshDb("main");
    const market = await seed(db, { smallNet: 5_000_000, largeNet: -10_000_000 });
    const { monitorsStep } = await import("@/lib/research/steps/monitors");
    await runResearchNight(db, { market, d: NIGHT, now: NOW }, [monitorsStep]);
    expect((await monitors(db))[0]!.alarm).toBe(0);
    expect((await ownerLines(db)).some((l) => l.includes("Event entries"))).toBe(false);
  });

  it("a night inside the quarter reads the quarter before it, and an empty history gives rows with no alarm", async () => {
    const db = await freshDb("main");
    const { monitorsStep } = await import("@/lib/research/steps/monitors");
    const market = await bench(db);
    await runResearchNight(db, { market, d: "2030-05-15", now: "2030-05-15T08:00:00Z" }, [
      monitorsStep,
    ]);
    const rows = await monitors(db);
    expect(rows.map((r) => [r.monitor, r.period, r.alarm])).toEqual([
      [1, "2030-Q1", 0],
      [3, "2030-Q1", 0],
      [4, "2030-Q1", 0],
    ]);
    expect(await ownerLines(db)).toEqual([]);
  });

  it("writes nothing but residual_monitor and app_log (the write allowlist, on the real tables)", async () => {
    const db = await freshDb("main");
    const market = await seed(db, { smallNet: -10_000_000, largeNet: 5_000_000 });
    const names = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).rows.map((r) => String(r.name));
    const count = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const n of names)
        out[n] = Number((await db.execute(`SELECT COUNT(*) AS n FROM ${n}`)).rows[0]!.n);
      return out;
    };
    const before = await count();
    const { monitorsStep } = await import("@/lib/research/steps/monitors");
    await runResearchNight(db, { market, d: NIGHT, now: NOW }, [monitorsStep]);
    const after = await count();
    const changed = names.filter((n) => before[n] !== after[n]);
    expect(changed).toEqual(["app_log", "residual_monitor"]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(f);
  }
  return out;
}
const stripComments = (t: string): string =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");

describe("AT-74: no monitor writes a book, a rule, a ranking or a card (static)", () => {
  const monitorFiles = [
    ...walk(join(ROOT, "src", "lib", "cortex", "monitors")),
    join(ROOT, "src", "lib", "research", "steps", "monitors.ts"),
  ];

  it("every SQL write in the monitor files targets residual_monitor or app_log, and none is an update or a delete", () => {
    expect(monitorsFound(monitorFiles)).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of monitorFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const m of code.matchAll(
        /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|DROP|ALTER|CREATE)\s+(\w+)/gi,
      )) {
        const verb = m[1]!.toUpperCase();
        const table = m[2]!;
        if (!/^INSERT/.test(verb) || !["residual_monitor", "app_log"].includes(table))
          bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the monitors import no arena, agent, pick, order, ranking, e-mail or status-writing module", () => {
    const forbidden =
      /from\s+["'][^"']*(\/arena\/|\/agents\/(?!families)|\/picks\/|\/email\/|\/alerts\/|cortex\/store\/|cortex\/status["'])/;
    const bad: string[] = [];
    for (const f of monitorFiles) {
      for (const line of stripComments(readFileSync(f, "utf8")).split("\n")) {
        if (forbidden.test(line)) bad.push(`${f}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("nothing that decides, sizes, ranks, picks or e-mails imports the monitors", () => {
    const bad: string[] = [];
    for (const d of ["arena", "agents", "picks", "email", "alerts", "learning"]) {
      let files: string[] = [];
      try {
        files = walk(join(ROOT, "src", "lib", d));
      } catch {
        continue;
      }
      for (const f of files) {
        if (/cortex\/monitors|steps\/monitors/.test(stripComments(readFileSync(f, "utf8"))))
          bad.push(f);
      }
    }
    expect(bad).toEqual([]);
  });
});

const monitorsFound = (files: string[]): number => files.length;
