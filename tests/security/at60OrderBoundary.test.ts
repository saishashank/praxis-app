// @vitest-environment node
// M17 AT-60 order boundary (SEC-114, ARN-111, AGT-139; docs/M17_design.md "Order boundary"): the alert
// and intraday modules can neither place nor change an order, book, ledger or lesson. Enforced four
// ways: (i) an import guard, (ii) a SQL write allowlist, (iii) database triggers, (iv) a replay hash of
// the book tables with the poll and the scan on versus off. ZZ fixtures only, no network.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPickAlertPoll } from "@/lib/alerts/pick/poll";
import { localToUtc } from "@/lib/data/calendar";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { runIntradayScan } from "@/lib/intraday/run";
import { replaySessions } from "@/lib/arena/replay";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  MARKET,
  NOW,
  dumpTables,
  makeStrategy,
  paramOverridesFor,
  setupReplay,
} from "../arena/replayHarness";

afterEach(cleanupTempDbs);

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
};

/** The guarded files: the new modules, whichever of them exist at this point of the build. */
function guardedFiles(): string[] {
  const dirs = [
    "src/lib/data/quotes",
    "src/lib/alerts/pick",
    "src/lib/intraday",
    "src/app/api/internal/pick-alerts",
    "src/app/api/internal/intraday-scan",
  ];
  const files = ["src/lib/email/pickMail.ts", "src/lib/email/templates/pickAlerts.ts"];
  const out = dirs.flatMap((d) => walk(path.join(ROOT, d)));
  for (const f of files) if (fs.existsSync(path.join(ROOT, f))) out.push(path.join(ROOT, f));
  return out.sort();
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(src: string): string[] {
  const out: string[] = [];
  // a type-only import of the arena column types (sentinel/schema.ts) carries no code
  src = src.replace(/import type [^;]*?from ["']@\/lib\/arena\/schema["'];?/g, "");
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Repo-relative path (no extension) of a specifier, or the bare package name. */
function resolveSpec(file: string, spec: string): string {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith(".")) {
    return posix(path.relative(ROOT, path.resolve(path.dirname(file), spec)));
  }
  return spec;
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["src/lib/arena/*", /^src\/lib\/arena(\/|$)/],
  ["cortex/night", /^src\/lib\/cortex\/night(\/|$)/],
  ["cortex decision writers", /^src\/lib\/cortex\/store\/decisions(\/|$)/],
  ["pick store writers", /^src\/lib\/picks\/store(\/|$)/],
  ["agents", /^src\/lib\/agents(\/|$)/],
  ["llm", /^src\/lib\/llm(\/|$)/],
  ["anthropic sdk", /^@anthropic-ai\//],
];

/**
 * The guarded roots plus every src file they import, transitively (relative and @/ imports only).
 * Descent stops at files outside the modules the new streams own or read directly (sentinel intake,
 * data helpers, money): vetted read-only reuse such as the Cortex gate functions, the signed-route
 * wrapper and the config store are leaves, so their own history of imports is not part of this guard.
 */
const DESCEND =
  /^src\/lib\/(sentinel|data|money|intraday|alerts\/pick)\/|^src\/app\/api\/internal\/(pick-alerts|intraday-scan)\//;
function closure(roots: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...roots];
  const exts = ["", ".ts", ".tsx", ".mjs", "/index.ts"];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!DESCEND.test(posix(path.relative(ROOT, f)))) continue; // a leaf: listed, not scanned
    for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
      const base = path.join(ROOT, resolveSpec(f, spec));
      const hit = exts
        .map((e) => base + e)
        .find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (hit !== undefined && posix(hit).includes("/src/")) stack.push(hit);
    }
  }
  return [...seen].sort();
}

describe("AT-60 order boundary (i): import guard", () => {
  const files = closure(guardedFiles()).filter((f) => DESCEND.test(posix(path.relative(ROOT, f))));

  it("guards the WP1, WP3 and WP5 modules", () => {
    const rel = files.map((f) => posix(path.relative(ROOT, f)));
    expect(rel).toContain("src/lib/alerts/pick/evaluate.ts");
    expect(rel).toContain("src/lib/intraday/run.ts");
    expect(rel).toContain("src/lib/data/quotes/fetch.ts");
    expect(rel).toContain("src/app/api/internal/pick-alerts/route.ts");
    expect(rel).toContain("src/lib/sentinel/todayItems.ts"); // reached through the closure
  });

  it("no guarded file imports an arena, night, decision-writer, pick-store, agent or LLM module", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        for (const [name, re] of FORBIDDEN) {
          if (re.test(r)) bad.push(`${posix(path.relative(ROOT, f))} imports ${spec} (${name})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the alert modules take no Cortex input at all (evaluateAlert is limit, stop and quote only)", () => {
    for (const f of guardedFiles().filter((x) => posix(x).includes("src/lib/alerts/pick/"))) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        // the Cortex store `Exec` type is the only allowed neighbour (a type, no writer)
        if (/^src\/lib\/cortex\//.test(r)) expect(r, f).toBe("src/lib/cortex/store/common");
      }
    }
  });

  it("the guard itself catches a forbidden import (self-test)", () => {
    const sample =
      'import { runPreopen } from "@/lib/arena/preopen";\nimport x from "@anthropic-ai/sdk";';
    const hits = specifiers(sample).map((s) => resolveSpec("/x.ts", s));
    expect(FORBIDDEN.filter(([, re]) => hits.some((h) => re.test(h))).map(([n]) => n)).toEqual([
      "src/lib/arena/*",
      "anthropic sdk",
    ]);
  });
});

describe("AT-60 order boundary (ii): SQL write allowlist", () => {
  const ALLOWED = new Set(["pick_alert", "pick_alert_mail", "intraday_candidate", "quote_run"]);
  const WRITE_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  // a write keyword followed by anything but an identifier (interpolation, concatenation)
  const DYNAMIC_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?![A-Za-z_])/gi;
  // an execute( whose first argument is neither a string literal nor an object with a literal sql
  const EXEC_RE = /\.execute\((?!\s*(?:["'\x60]|\{\s*sql:\s*["'\x60]))/g;

  it("every INSERT, UPDATE and DELETE literal names an allowed table", () => {
    const bad: string[] = [];
    for (const f of guardedFiles()) {
      // string and template literals only, so prose in comments cannot trip or hide a write
      const src = fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const m of src.matchAll(WRITE_RE)) {
        if (!ALLOWED.has(m[1])) bad.push(`${posix(path.relative(ROOT, f))}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no write keyword is followed by an interpolation, and execute takes only literals", () => {
    const bad: string[] = [];
    for (const f of closure(guardedFiles()).filter((x) =>
      DESCEND.test(posix(path.relative(ROOT, x))),
    )) {
      const src = fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      const rel = posix(path.relative(ROOT, f));
      for (const m of src.matchAll(DYNAMIC_RE)) bad.push(`${rel}: dynamic write ${m[0]}`);
      for (const m of src.matchAll(EXEC_RE)) {
        const tail = src.slice(m.index, m.index + 60).replace(/\s+/g, " ");
        bad.push(`${rel}: non-literal execute ${tail}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the guarded modules write only through `execute` (no batch, no transaction handle)", () => {
    const bad: string[] = [];
    for (const f of guardedFiles()) {
      const src = fs.readFileSync(f, "utf8");
      if (/\.(batch|transaction|executeMultiple)\(/.test(src))
        bad.push(posix(path.relative(ROOT, f)));
    }
    expect(bad).toEqual([]);
  });

  it("e-mail rows are written only through sendEmail and the ledger only through logCell", () => {
    for (const f of guardedFiles()) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(
        /INSERT\s+INTO\s+(email_message|email_attempt|cortex_ledger_cell)/i,
      );
    }
  });

  it("the allowlist regex flags an order write (self-test)", () => {
    const names = [
      ..."INSERT INTO arena_order (id) VALUES (1); update fill SET x = 1".matchAll(WRITE_RE),
    ].map((m) => m[1]);
    expect(names).toEqual(["arena_order", "fill"]);
  });
});

describe("AT-60 order boundary (iii): triggers", () => {
  it("pick_alert, pick_alert_mail and quote_run abort UPDATE and DELETE", async () => {
    const db = await freshDb("main");
    const alert =
      "INSERT INTO pick_alert (alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d, state, limit_micro, stop_micro, at) " +
      "VALUES ('a', 1, '1', 'AU', '2026-11-03', 'P1', 1, 'ZZ01', '2026-11-04', 'armed', 10, 9, 't')";
    await db.execute(alert);
    await db.execute(
      "INSERT INTO pick_alert_mail (alert_id, kind, status, at) VALUES ('a', 'pick_hit', 'sent', 't')",
    );
    await db.execute(
      "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU', '2026-11-04', '10:00', 'poll', 't', 1)",
    );
    const change: Record<string, string> = {
      pick_alert: "at = 'x'",
      pick_alert_mail: "at = 'x'",
      quote_run: "requests = 5",
    };
    for (const [t, set] of Object.entries(change)) {
      await expect(db.execute(`UPDATE ${t} SET ${set}`)).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`)).rejects.toThrow(/append-only/);
    }
  });

  it("intraday_candidate: DELETE aborts; only the follow-up columns may change", async () => {
    const db = await freshDb("main");
    await db.execute(
      "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id, materiality, move_ppm, gates_json) " +
        "VALUES ('AU', '2026-11-04', 'ZZ01', '10:30', 't', 'zz', 'a1', 3, 50000, '{}')",
    );
    await expect(db.execute("DELETE FROM intraday_candidate")).rejects.toThrow();
    await expect(db.execute("UPDATE intraday_candidate SET move_ppm = 1")).rejects.toThrow();
    await db.execute(
      "UPDATE intraday_candidate SET latest_move_ppm = 1, decision_outcome = 'night_pick'",
    );
  });

  it("the book tables are untouched by migration 0020 (no trigger of ours on them)", async () => {
    const db = await freshDb("main");
    const r = await db.execute(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'pick_alert%' OR name LIKE 'quote_run%' OR name LIKE 'intraday_candidate%')",
    );
    const on = new Set(r.rows.map((x) => String(x.tbl_name)));
    expect([...on].sort()).toEqual([
      "intraday_candidate",
      "pick_alert",
      "pick_alert_mail",
      "quote_run",
    ]);
  });
});

describe("AT-60 order boundary (iv): replay hash with the poll and the scan on versus off", () => {
  const TABLES: Array<[string, string]> = [
    ["arena_order", "SELECT * FROM arena_order ORDER BY id"],
    ["trade", "SELECT * FROM trade ORDER BY 1, 2, 3"],
    ["sleeve_trade", "SELECT * FROM sleeve_trade ORDER BY 1, 2, 3"],
    ["lesson", "SELECT * FROM lesson ORDER BY 1"],
    ["cortex_decision", "SELECT * FROM cortex_decision ORDER BY 1"],
  ];

  async function run(on: boolean): Promise<{ hash: string; alerts: number; candidates: number }> {
    const setup = await setupReplay({
      startD: "2030-01-07",
      sessions: 20,
      seed: 11,
      dividendAt: 8,
      gateFailEvery: 17,
    });
    const { db, ds } = setup;
    const strategy = makeStrategy(db, ds);
    if (on) {
      await db.execute(
        "UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'",
      );
      await db.execute(
        "INSERT OR REPLACE INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
      );
      await db.execute({
        sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
                reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
                risk_micro, factors_json, based_on_json, pick_sha, created_at)
              VALUES ('AU', ?, 'P1', 1, 'ZZ01', 'F1', 'U1', 'F1.v1', 'sig', 'UNVALIDATED', 10000000, 10000000, ?,
                9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?, ?)`,
        args: [ds.dates[0], ds.dates[18], "b".repeat(64), `${ds.dates[0]}T07:00:00.000Z`],
      });
      await db.execute({
        sql:
          "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, item_ann_id, materiality, move_ppm, gates_json) " +
          "VALUES ('AU', ?, 'ZZ01', '10:30', 't', 'zz', 'a1', 3, 50000, '{}')",
        args: [ds.dates[1]],
      });
    }
    const tick = async (d: string): Promise<void> => {
      const now = localToUtc(d, "10:45", "Australia/Melbourne");
      const fetchStub = async () => ({
        ok: true,
        status: 200,
        json: async () =>
          syntheticChart({
            price: 9.9,
            prevClose: 10,
            volume: 5000,
            timeS: (now.getTime() - 20 * 60_000) / 1000,
            symbol: "ZZ01.AX",
          }),
      });
      const deps = { db, now: () => now, fetch: fetchStub, sleep: async () => {} };
      await runPickAlertPoll({ ...deps, recipients: async () => ["1"] });
      await runIntradayScan(deps);
    };
    const results = await replaySessions(db, {
      market: MARKET,
      from: ds.dates[0],
      to: ds.dates[ds.dates.length - 1],
      now: NOW,
      afterClose: async (d, r) => {
        await strategy(d, r);
        if (on) await tick(d);
      },
      restartParams: paramOverridesFor,
    });
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["success"]));
    const dump = await dumpTables(db);
    for (const [name, sql] of TABLES) {
      const rs = await db.execute(sql);
      dump[name] = rs.rows
        .map((row) => JSON.stringify(Object.values(row).map((v) => String(v))))
        .join("\n");
    }
    const hash = createHash("sha256")
      .update(
        Object.entries(dump)
          .map(([k, v]) => `${k}\n${v}`)
          .join("\n--\n"),
      )
      .digest("hex");
    const n = async (sql: string) => Number((await db.execute(sql)).rows[0].n);
    return {
      hash,
      alerts: await n("SELECT COUNT(*) AS n FROM pick_alert"),
      candidates: await n("SELECT COUNT(*) AS n FROM intraday_candidate"),
    };
  }

  it("the book, ledger, lesson and Cortex decision tables hash the same with the feature on and off", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(off.alerts).toBe(0);
    expect(off.candidates).toBe(0);
    expect(on.alerts).toBeGreaterThan(0);
    expect(on.candidates).toBeGreaterThan(0);
    expect(on.hash).toBe(off.hash);
  }, 120_000);
});
